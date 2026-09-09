// REQ-REV-003 (P0/GOB): verifica contra Postgres REAL (embedded-postgres, ADR-003) que
// la máquina de estados de `packages/db/migrations/0082_revenue_engine_gate.sql` es la
// autoridad de verdad -- no la aplicación -- para las 3 reglas del requisito:
//   1. shadow -> propone exige un mínimo de 90 días en shadow.
//   2. propone -> autopilot exige un backtest walk-forward vigente que pase Y una
//      aprobación registrada y vigente del fundador (REQ-GOB-012,
//      `shadow_a_autopilot_revenue`, 0081) -- ninguna de las dos por separado basta.
//   3. Nunca se puede saltar directo de shadow a autopilot, y cualquier democión
//      (freno de emergencia) siempre se permite sin condiciones.
// Complementa (nunca duplica) tests/unit/domain-hotel/revenue-engine-gate.spec.ts (el
// espejo puro de esta misma lógica) -- mismo criterio que
// tests/adversarial/decisiones-reservadas-fundador.spec.ts frente a 0081.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../../support/pg-fixture.ts";

interface RevenueHotel {
  orgId: string;
  hotelId: string;
  ownerId: string;
  frontdeskId: string;
}

describe("REQ-REV-003: máquina de estados real shadow -> propone -> autopilot + backtest walk-forward", () => {
  let fixture: PgFixture;
  let founderId: string;

  beforeAll(async () => {
    fixture = await createPgFixture();

    const founderRows = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name) values ($1, $2) returning id;",
      [`fundador-${randomUUID()}@atiende-hoteles.test`, "Fundador de prueba"],
    );
    founderId = founderRows.rows[0]!.id;
    await fixture.engine.admin.query("insert into public.founder_identity (user_id, full_name) values ($1, $2);", [
      founderId,
      "Fundador de prueba",
    ]);
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  // Cada test siembra su PROPIO org/hotel (aislado, mismo criterio que
  // tests/unit/rls/org-isolation.spec.ts::seedIndependentOrg) para que las
  // transiciones de gate de un test nunca contaminen a otro -- el reloj de 90 días y
  // el historial de backtests son estado real por hotel.
  async function seedRevenueHotel(): Promise<RevenueHotel> {
    const suffix = randomUUID();
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ($1) returning id;",
      [`Org revenue-gate ${suffix}`],
    );
    const orgId = orgRows[0]!.id;

    const { rows: locationRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', $2) returning id;",
      [orgId, `Hotel revenue-gate ${suffix}`],
    );
    const hotelId = locationRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelId, orgId]);

    const { rows: ownerRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name) values ($1, $2) returning id;",
      [`owner-${suffix}@atiende-hoteles.test`, "Owner de prueba"],
    );
    const ownerId = ownerRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'owner');", [
      orgId,
      hotelId,
      ownerId,
    ]);

    const { rows: frontdeskRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name) values ($1, $2) returning id;",
      [`frontdesk-${suffix}@atiende-hoteles.test`, "Frontdesk de prueba"],
    );
    const frontdeskId = frontdeskRows[0]!.id;
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'frontdesk');",
      [orgId, hotelId, frontdeskId],
    );

    return { orgId, hotelId, ownerId, frontdeskId };
  }

  async function insertGate(h: RevenueHotel, opts: { shadowStartedAt?: Date; asUser?: string } = {}): Promise<string> {
    const { rows } = await fixture.engine.withAppSession({ userId: opts.asUser ?? h.ownerId }, (db) =>
      db.query<{ id: string }>(
        `insert into public.revenue_engine_gate (org_id, hotel_id, shadow_started_at)
         values ($1, $2, coalesce($3, now())) returning id;`,
        [h.orgId, h.hotelId, opts.shadowStartedAt ?? null],
      ),
    );
    return rows[0]!.id;
  }

  async function updateGate(h: RevenueHotel, gate: string, opts: { asUser?: string } = {}) {
    return fixture.engine.withAppSession({ userId: opts.asUser ?? h.ownerId }, (db) =>
      db.query(`update public.revenue_engine_gate set gate = $1 where hotel_id = $2;`, [gate, h.hotelId]),
    );
  }

  // `runAt: null` = "ahora mismo", resuelto por Postgres (`coalesce($3, now())`) --
  // NUNCA por `new Date()` del lado de Node -- para no crear una carrera de reloj
  // cliente/servidor: `now()` del backtest debe compararse contra `propone_started_at`
  // (otro `now()` de Postgres, de una transacción YA COMITEADA antes de esta) dentro del
  // mismo reloj, con el margen real que da la propia latencia de red/transacción, nunca
  // el margen de ~1ms que dejaría un timestamp calculado en Node inmediatamente después
  // del `await` anterior (encontrado real e intermitente al correr este archivo
  // completo, nunca en aislamiento: ver commit REQ-REV-003 en docs/logs/). Pasar una
  // fecha explícita del pasado (ej. "backtest obsoleto") sigue siendo válido y no
  // corre ese riesgo -- solo el caso "ahora" necesita resolverse en el servidor.
  async function insertPassingBacktest(h: RevenueHotel, runAt: Date | null) {
    await fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
      db.query(
        `insert into public.revenue_backtest_run
           (org_id, hotel_id, counterfactual_method, windows_evaluated, windows_engine_won,
            engine_total_revenue, baseline_total_revenue, improvement_pct, passes, failure_reasons, run_at)
         values ($1, $2, 'misma_tarifa_periodo_anterior', 3, 3, 3600, 3000, 20.0, true, '[]'::jsonb, coalesce($3, now()));`,
        [h.orgId, h.hotelId, runAt ? runAt.toISOString() : null],
      ),
    );
  }

  async function insertFailingBacktest(h: RevenueHotel, runAt: Date) {
    await fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
      db.query(
        `insert into public.revenue_backtest_run
           (org_id, hotel_id, counterfactual_method, windows_evaluated, windows_engine_won,
            engine_total_revenue, baseline_total_revenue, improvement_pct, passes, failure_reasons, run_at)
         values ($1, $2, 'misma_tarifa_periodo_anterior', 3, 1, 2800, 3000, -6.7, false, '["no_supera_baseline"]'::jsonb, $3);`,
        [h.orgId, h.hotelId, runAt.toISOString()],
      ),
    );
  }

  async function aprobarShadowAAutopilot(h: RevenueHotel) {
    await fixture.engine.withAppSession({ userId: founderId }, (db) =>
      db.query(
        `insert into public.founder_decision_approval (category, org_id, hotel_id, decided_by, texto_exacto)
         values ('shadow_a_autopilot_revenue', $1, $2, $3, 'Apruebo autopilot para el hotel de prueba de REQ-REV-003.');`,
        [h.orgId, h.hotelId, founderId],
      ),
    );
  }

  it("un hotel nuevo SOLO puede empezar en shadow -- Postgres rechaza un insert directo en otro gate", async () => {
    const h = await seedRevenueHotel();
    await expect(
      fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
        db.query(`insert into public.revenue_engine_gate (org_id, hotel_id, gate) values ($1, $2, 'autopilot');`, [h.orgId, h.hotelId]),
      ),
    ).rejects.toThrow(/gate_inicial_invalido/);

    const { rows } = await fixture.engine.admin.query("select 1 from public.revenue_engine_gate where hotel_id = $1;", [h.hotelId]);
    expect(rows).toHaveLength(0);
  });

  it("shadow -> propone se bloquea antes de 90 días, con el conteo real de días en el mensaje", async () => {
    const h = await seedRevenueHotel();
    const hace45Dias = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await insertGate(h, { shadowStartedAt: hace45Dias });

    await expect(updateGate(h, "propone")).rejects.toThrow(/shadow_insuficiente/);

    const { rows } = await fixture.engine.admin.query<{ gate: string }>("select gate from public.revenue_engine_gate where hotel_id = $1;", [
      h.hotelId,
    ]);
    expect(rows[0]!.gate).toBe("shadow"); // no quedó a medias
  });

  it("shadow -> propone se permite con 91 días cumplidos, y fija propone_started_at", async () => {
    const h = await seedRevenueHotel();
    const hace91Dias = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    await insertGate(h, { shadowStartedAt: hace91Dias });

    await updateGate(h, "propone");

    const { rows } = await fixture.engine.admin.query<{ gate: string; propone_started_at: string | null }>(
      "select gate, propone_started_at from public.revenue_engine_gate where hotel_id = $1;",
      [h.hotelId],
    );
    expect(rows[0]!.gate).toBe("propone");
    expect(rows[0]!.propone_started_at).not.toBeNull();
  });

  it("propone -> autopilot se bloquea sin ningún backtest registrado", async () => {
    const h = await seedRevenueHotel();
    await insertGate(h, { shadowStartedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) });
    await updateGate(h, "propone");

    await expect(updateGate(h, "autopilot")).rejects.toThrow(/backtest_no_supera_baseline/);
  });

  it("propone -> autopilot se bloquea con un backtest que NO pasa, aunque exista aprobación del fundador", async () => {
    const h = await seedRevenueHotel();
    await insertGate(h, { shadowStartedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) });
    await updateGate(h, "propone");
    await insertFailingBacktest(h, new Date());
    await aprobarShadowAAutopilot(h);

    await expect(updateGate(h, "autopilot")).rejects.toThrow(/backtest_no_supera_baseline/);
  });

  it('propone -> autopilot se bloquea con backtest que SÍ pasa pero SIN aprobación del fundador (REQ-GOB-012)', async () => {
    const h = await seedRevenueHotel();
    await insertGate(h, { shadowStartedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) });
    await updateGate(h, "propone");
    await insertPassingBacktest(h, null);

    await expect(updateGate(h, "autopilot")).rejects.toThrow(/aprobacion_fundador_requerida/);

    const { rows } = await fixture.engine.admin.query<{ gate: string }>("select gate from public.revenue_engine_gate where hotel_id = $1;", [
      h.hotelId,
    ]);
    expect(rows[0]!.gate).toBe("propone");
  });

  it("propone -> autopilot se PERMITE con backtest vigente que pasa + aprobación del fundador registrada", async () => {
    const h = await seedRevenueHotel();
    await insertGate(h, { shadowStartedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) });
    await updateGate(h, "propone");
    await insertPassingBacktest(h, null);
    await aprobarShadowAAutopilot(h);

    await updateGate(h, "autopilot");

    const { rows } = await fixture.engine.admin.query<{ gate: string; autopilot_started_at: string | null }>(
      "select gate, autopilot_started_at from public.revenue_engine_gate where hotel_id = $1;",
      [h.hotelId],
    );
    expect(rows[0]!.gate).toBe("autopilot");
    expect(rows[0]!.autopilot_started_at).not.toBeNull();
  });

  it("un backtest corrido ANTES de entrar en propone (obsoleto) no habilita autopilot", async () => {
    const h = await seedRevenueHotel();
    const hace200Dias = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await insertGate(h, { shadowStartedAt: hace200Dias });
    // Backtest corrido durante el shadow largo, ANTES de pasar a propone.
    await insertPassingBacktest(h, new Date(Date.now() - 120 * 24 * 60 * 60 * 1000));
    await updateGate(h, "propone"); // propone_started_at queda en "ahora"
    await aprobarShadowAAutopilot(h);

    await expect(updateGate(h, "autopilot")).rejects.toThrow(/backtest_obsoleto/);
  });

  it("nunca se puede saltar directo de shadow a autopilot, aunque el backtest y la aprobación ya existan", async () => {
    const h = await seedRevenueHotel();
    await insertGate(h, { shadowStartedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) });
    await insertPassingBacktest(h, new Date());
    await aprobarShadowAAutopilot(h);

    await expect(updateGate(h, "autopilot")).rejects.toThrow(/transicion_no_permitida/);
  });

  it("una democión (freno de emergencia) SIEMPRE se permite, sin backtest ni aprobación, y reinicia el reloj de shadow", async () => {
    const h = await seedRevenueHotel();
    await insertGate(h, { shadowStartedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) });
    await updateGate(h, "propone");
    await insertPassingBacktest(h, null);
    await aprobarShadowAAutopilot(h);
    await updateGate(h, "autopilot");

    // Sin ninguna condición adicional: un owner/gm puede bajar de autopilot a shadow
    // directo (freno de emergencia), sin volver a pedir nada.
    await updateGate(h, "shadow");

    const { rows } = await fixture.engine.admin.query<{
      gate: string;
      shadow_started_at: string;
      propone_started_at: string | null;
      autopilot_started_at: string | null;
    }>("select gate, shadow_started_at, propone_started_at, autopilot_started_at from public.revenue_engine_gate where hotel_id = $1;", [
      h.hotelId,
    ]);
    expect(rows[0]!.gate).toBe("shadow");
    expect(rows[0]!.propone_started_at).toBeNull();
    expect(rows[0]!.autopilot_started_at).toBeNull();
    // El reloj de 90 días es NUEVO: shadow_started_at quedó recién ahora, no puede
    // promoverse de inmediato otra vez.
    await expect(updateGate(h, "propone")).rejects.toThrow(/shadow_insuficiente/);
  });

  it("el límite de variación en propone está acotado por CHECK a la banda ±10-15% (REQ-REV-003)", async () => {
    const h = await seedRevenueHotel();
    await insertGate(h, { shadowStartedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) });

    await expect(
      fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
        db.query("update public.revenue_engine_gate set propone_max_variation_pct = 20 where hotel_id = $1;", [h.hotelId]),
      ),
    ).rejects.toThrow();

    await fixture.engine.withAppSession({ userId: h.ownerId }, (db) =>
      db.query("update public.revenue_engine_gate set propone_max_variation_pct = 12.5 where hotel_id = $1;", [h.hotelId]),
    );
    const { rows } = await fixture.engine.admin.query<{ propone_max_variation_pct: string }>(
      "select propone_max_variation_pct from public.revenue_engine_gate where hotel_id = $1;",
      [h.hotelId],
    );
    expect(Number(rows[0]!.propone_max_variation_pct)).toBeCloseTo(12.5, 5);
  });

  it("RLS: un rol sin privilegio de gobierno (frontdesk) no puede crear ni mover el gate del motor de revenue", async () => {
    const h = await seedRevenueHotel();
    await expect(
      fixture.engine.withAppSession({ userId: h.frontdeskId }, (db) =>
        db.query("insert into public.revenue_engine_gate (org_id, hotel_id) values ($1, $2);", [h.orgId, h.hotelId]),
      ),
    ).rejects.toThrow(/row-level security/i);

    await insertGate(h, { shadowStartedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) });
    // A diferencia de un INSERT (donde `WITH CHECK` sí lanza un error real de RLS), un
    // UPDATE cuyo `USING` excluye la fila simplemente no encuentra ninguna fila que
    // actualizar -- Postgres no lanza, deja la fila intacta (semántica real de RLS,
    // verificada aquí en vez de asumida).
    await updateGate(h, "propone", { asUser: h.frontdeskId });
    const { rows: sinCambio } = await fixture.engine.admin.query<{ gate: string }>(
      "select gate from public.revenue_engine_gate where hotel_id = $1;",
      [h.hotelId],
    );
    expect(sinCambio[0]!.gate).toBe("shadow"); // el intento de frontdesk no movió el gate

    // Pero SÍ puede leerlo (transparencia).
    const { rows } = await fixture.engine.withAppSession({ userId: h.frontdeskId }, (db) =>
      db.query<{ gate: string }>("select gate from public.revenue_engine_gate where hotel_id = $1;", [h.hotelId]),
    );
    expect(rows[0]!.gate).toBe("shadow");
  });
});
