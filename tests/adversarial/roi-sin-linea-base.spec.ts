// REQ-REV-018/REQ-GOB-016 (P0/OBS-GOB, BP-015/BP-131/BP-171/BP-150/GOB-037/GOB-012):
// "El sistema debe registrar, para cada agente/módulo con impacto económico, una línea
// base firmada en la semana 1 ...; ningún cobro por resultado se activa sin línea base
// firmada." Verificado aquí contra Postgres REAL (embedded-postgres, ADR-003) --
// `packages/db/migrations/0120_roi_baseline_cobro_resultado.sql` es la autoridad de
// verdad, no la aplicación: ninguna sesión (ni siquiera owner/gm, que sí puede escribir
// la fila por RLS) puede activar un cobro por resultado sin una línea base FIRMADA, ni
// firmar una línea base fuera de la ventana de "semana 1" (7 días desde que el
// agente/módulo se activó), escribiendo SQL a mano.
//
// Caso central del criterio de aceptación ("intento de cobro sin línea base →
// bloqueado"): un INSERT en `cobro_resultado_activacion` sin una `roi_baseline` firmada
// para ese mismo (hotel, agente) es rechazado por el trigger -- verificado en 3
// variantes (sin ninguna línea base, con línea base en borrador, con línea base firmada
// fuera de la semana 1) -- y, en contraste, se PERMITE cuando la línea base sí está
// firmada dentro de la semana 1 y además existe la aprobación del fundador que exige
// BP-150/GOB-052 para "estructura de éxito compartido" -- el gate discrimina de verdad,
// no solo deniega siempre (mismo criterio que
// tests/adversarial/decisiones-reservadas-fundador.spec.ts).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";

describe("adversarial: ningún cobro por resultado se activa sin línea base firmada (REQ-REV-018)", () => {
  let fixture: PgFixture;
  let founderId: string;
  let orgId: string;
  let hotelId: string;
  let ownerId: string;
  let gmId: string;
  let frontdeskId: string;

  beforeAll(async () => {
    fixture = await createPgFixture();
    const hotel = fixture.seed.hotels[0]!;
    orgId = fixture.seed.orgId;
    hotelId = hotel.id;
    ownerId = hotel.staff.find((s) => s.role === "owner")!.id;
    gmId = hotel.staff.find((s) => s.role === "gm")!.id;
    frontdeskId = hotel.staff.find((s) => s.role === "frontdesk")!.id;

    // Identidad de plataforma, no un miembro de hotel_staff de ningún hotel-cliente --
    // mismo criterio que tests/adversarial/decisiones-reservadas-fundador.spec.ts.
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

  function agentName(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  async function crearBorradorBaseline(
    agente: string,
    opts: { activadoEn?: Date; asUser?: string } = {},
  ): Promise<string> {
    const { rows } = await fixture.engine.withAppSession({ userId: opts.asUser ?? ownerId }, (db) =>
      db.query<{ id: string }>(
        `insert into public.roi_baseline
           (org_id, hotel_id, agent_name, metrica, valor_base, unidad, metodo_captura,
            periodo_desde, periodo_hasta, activado_en)
         values ($1, $2, $3, 'reservas_directas_mensuales', 40, 'reservas/mes',
                 'promedio de 12 meses de historico PMS importado en onboarding',
                 '2025-01-01', '2025-12-31', coalesce($4, now()))
         returning id;`,
        [orgId, hotelId, agente, opts.activadoEn?.toISOString() ?? null],
      ),
    );
    return rows[0]!.id;
  }

  async function firmarBaseline(id: string, firmadoEn: Date, opts: { asUser?: string } = {}) {
    return fixture.engine.withAppSession({ userId: opts.asUser ?? ownerId }, (db) =>
      db.query("update public.roi_baseline set firmado_en = $1 where id = $2;", [firmadoEn.toISOString(), id]),
    );
  }

  async function aprobarEstructuraExitoCompartido() {
    await fixture.engine.withAppSession({ userId: founderId }, (db) =>
      db.query(
        `insert into public.founder_decision_approval (category, org_id, hotel_id, decided_by, texto_exacto)
         values ('estructura_de_exito_compartido', $1, $2, $3, 'Apruebo la estructura de exito compartido para el hotel de prueba de REQ-REV-018.');`,
        [orgId, hotelId, founderId],
      ),
    );
  }

  async function activarCobro(
    agente: string,
    roiBaselineId: string,
    opts: { asUser?: string } = {},
  ) {
    return fixture.engine.withAppSession({ userId: opts.asUser ?? ownerId }, (db) =>
      db.query(
        `insert into public.cobro_resultado_activacion (org_id, hotel_id, agent_name, roi_baseline_id, modelo_cobro)
         values ($1, $2, $3, $4, 'porcentaje_reservas_directas_incrementales');`,
        [orgId, hotelId, agente, roiBaselineId],
      ),
    );
  }

  it("SIN ninguna línea base (id inexistente): la activación se bloquea, incluso con aprobación del fundador ya registrada", async () => {
    await aprobarEstructuraExitoCompartido();
    const agente = agentName("motor-revenue");

    await expect(activarCobro(agente, randomUUID())).rejects.toThrow(/linea_base_no_encontrada/);

    const { rows } = await fixture.engine.admin.query(
      "select 1 from public.cobro_resultado_activacion where hotel_id = $1 and agent_name = $2;",
      [hotelId, agente],
    );
    expect(rows).toHaveLength(0);
  });

  it("con línea base EN BORRADOR (sin firmar): la activación se bloquea (linea_base_no_firmada)", async () => {
    const agente = agentName("motor-revenue");
    const baselineId = await crearBorradorBaseline(agente);

    await expect(activarCobro(agente, baselineId)).rejects.toThrow(/linea_base_no_firmada/);

    const { rows } = await fixture.engine.admin.query(
      "select 1 from public.cobro_resultado_activacion where hotel_id = $1 and agent_name = $2;",
      [hotelId, agente],
    );
    expect(rows).toHaveLength(0);
  });

  it("firmar una línea base FUERA de la semana 1 (más de 7 días desde su activación) se rechaza al firmarla -- sigue sin firma, la activación sigue bloqueada", async () => {
    const agente = agentName("motor-revenue");
    const hace10Dias = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const baselineId = await crearBorradorBaseline(agente, { activadoEn: hace10Dias });

    await expect(firmarBaseline(baselineId, new Date())).rejects.toThrow(/linea_base_fuera_de_semana_1/);

    const { rows } = await fixture.engine.admin.query<{ firmado_en: string | null }>(
      "select firmado_en from public.roi_baseline where id = $1;",
      [baselineId],
    );
    expect(rows[0]!.firmado_en).toBeNull(); // no quedó a medias firmada

    await expect(activarCobro(agente, baselineId)).rejects.toThrow(/linea_base_no_firmada/);
  });

  it("firmar ANTES de que el agente/módulo se activara se rechaza (firma_anterior_a_activacion)", async () => {
    const agente = agentName("motor-revenue");
    const activadoEn = new Date();
    const baselineId = await crearBorradorBaseline(agente, { activadoEn });
    const firmadoEnElPasado = new Date(activadoEn.getTime() - 60 * 60 * 1000);

    await expect(firmarBaseline(baselineId, firmadoEnElPasado)).rejects.toThrow(/firma_anterior_a_activacion/);
  });

  it("línea base firmada del hotel/agente correcto pero SIN aprobación del fundador de 'estructura_de_exito_compartido': bloqueada (defensa en profundidad, BP-150/GOB-052)", async () => {
    const agente = agentName("motor-energia");
    const baselineId = await crearBorradorBaseline(agente);
    await firmarBaseline(baselineId, new Date());

    // Nótese: NO se llama aprobarEstructuraExitoCompartido() en este caso -- el alcance
    // (org_id/hotel_id) es el mismo de los demás casos, pero esta prueba corre ANTES de
    // que cualquier otra la haya registrado para esta org/hotel en este archivo salvo la
    // del primer test (que sí la registró) -- se usa un hotel/org independiente para
    // que la ausencia de aprobación sea real, no un efecto colateral del orden de los
    // tests.
    const orgIndep = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ($1) returning id;",
      [`Org roi-baseline sin-fundador ${randomUUID()}`],
    );
    const orgIdIndep = orgIndep.rows[0]!.id;
    const locationIndep = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', $2) returning id;",
      [orgIdIndep, `Hotel roi-baseline sin-fundador ${randomUUID()}`],
    );
    const hotelIdIndep = locationIndep.rows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelIdIndep, orgIdIndep]);
    const ownerIndep = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name) values ($1, $2) returning id;",
      [`owner-${randomUUID()}@atiende-hoteles.test`, "Owner independiente de prueba"],
    );
    const ownerIdIndep = ownerIndep.rows[0]!.id;
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'owner');",
      [orgIdIndep, hotelIdIndep, ownerIdIndep],
    );

    const { rows: baselineIndepRows } = await fixture.engine.withAppSession({ userId: ownerIdIndep }, (db) =>
      db.query<{ id: string }>(
        `insert into public.roi_baseline
           (org_id, hotel_id, agent_name, metrica, valor_base, unidad, metodo_captura, periodo_desde, periodo_hasta)
         values ($1, $2, $3, 'reservas_directas_mensuales', 40, 'reservas/mes',
                 'promedio de 12 meses de historico PMS importado en onboarding', '2025-01-01', '2025-12-31')
         returning id;`,
        [orgIdIndep, hotelIdIndep, agente],
      ),
    );
    const baselineIndepId = baselineIndepRows[0]!.id;
    await fixture.engine.withAppSession({ userId: ownerIdIndep }, (db) =>
      db.query("update public.roi_baseline set firmado_en = now() where id = $1;", [baselineIndepId]),
    );

    await expect(
      fixture.engine.withAppSession({ userId: ownerIdIndep }, (db) =>
        db.query(
          `insert into public.cobro_resultado_activacion (org_id, hotel_id, agent_name, roi_baseline_id, modelo_cobro)
           values ($1, $2, $3, $4, 'porcentaje_reservas_directas_incrementales');`,
          [orgIdIndep, hotelIdIndep, agente, baselineIndepId],
        ),
      ),
    ).rejects.toThrow(/aprobacion_fundador_requerida/);

    // El baseline del hotel principal (creado arriba con el mismo nombre de agente,
    // pero SIN esta activacion todavia) tampoco fue tocado por este bloque.
    void baselineId;
  });

  it("una vez firmada, la línea base es INMUTABLE -- ni siquiera owner/gm puede reescribir el monto ya mostrado al dueño", async () => {
    const agente = agentName("motor-revenue");
    const baselineId = await crearBorradorBaseline(agente);
    await firmarBaseline(baselineId, new Date());

    await expect(
      fixture.engine.withAppSession({ userId: ownerId }, (db) =>
        db.query("update public.roi_baseline set valor_base = 999999 where id = $1;", [baselineId]),
      ),
    ).rejects.toThrow(/linea_base_firmada_inmutable/);

    const { rows } = await fixture.engine.admin.query<{ valor_base: string }>(
      "select valor_base from public.roi_baseline where id = $1;",
      [baselineId],
    );
    expect(Number(rows[0]!.valor_base)).toBe(40);
  });

  it("al firmar, no se puede cambiar ningún otro campo en el mismo UPDATE (no_se_puede_modificar_al_firmar)", async () => {
    const agente = agentName("motor-revenue");
    const baselineId = await crearBorradorBaseline(agente);

    await expect(
      fixture.engine.withAppSession({ userId: ownerId }, (db) =>
        db.query("update public.roi_baseline set firmado_en = now(), valor_base = 12345 where id = $1;", [baselineId]),
      ),
    ).rejects.toThrow(/no_se_puede_modificar_al_firmar/);

    const { rows } = await fixture.engine.admin.query<{ firmado_en: string | null; valor_base: string }>(
      "select firmado_en, valor_base from public.roi_baseline where id = $1;",
      [baselineId],
    );
    expect(rows[0]!.firmado_en).toBeNull();
    expect(Number(rows[0]!.valor_base)).toBe(40);
  });

  it("RLS: frontdesk no puede crear ni firmar una línea base, pero sí puede verla (transparencia)", async () => {
    const agente = agentName("motor-revenue");
    await expect(
      fixture.engine.withAppSession({ userId: frontdeskId }, (db) =>
        db.query(
          `insert into public.roi_baseline
             (org_id, hotel_id, agent_name, metrica, valor_base, unidad, metodo_captura, periodo_desde, periodo_hasta)
           values ($1, $2, $3, 'reservas_directas_mensuales', 40, 'reservas/mes', 'x', '2025-01-01', '2025-12-31');`,
          [orgId, hotelId, agente],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const baselineId = await crearBorradorBaseline(agente);
    // Un UPDATE cuyo USING excluye la fila no lanza -- simplemente no encuentra
    // ninguna fila que actualizar (semántica real de RLS, mismo criterio que
    // tests/integration/revenue/revenue-engine-gate.spec.ts).
    await firmarBaseline(baselineId, new Date(), { asUser: frontdeskId });
    const { rows: sinFirmar } = await fixture.engine.admin.query<{ firmado_en: string | null }>(
      "select firmado_en from public.roi_baseline where id = $1;",
      [baselineId],
    );
    expect(sinFirmar[0]!.firmado_en).toBeNull();

    const { rows: visible } = await fixture.engine.withAppSession({ userId: frontdeskId }, (db) =>
      db.query<{ id: string }>("select id from public.roi_baseline where id = $1;", [baselineId]),
    );
    expect(visible).toHaveLength(1);
  });

  it("RLS: frontdesk no puede activar un cobro por resultado, aunque la línea base ya esté firmada", async () => {
    const agente = agentName("motor-revenue");
    const baselineId = await crearBorradorBaseline(agente);
    await firmarBaseline(baselineId, new Date());
    await aprobarEstructuraExitoCompartido();

    await expect(activarCobro(agente, baselineId, { asUser: frontdeskId })).rejects.toThrow(/row-level security/i);
  });

  it("gm tiene el mismo nivel que owner: puede crear, firmar y activar (RLS no distingue entre los dos roles de gobierno)", async () => {
    const agente = agentName("motor-revenue");
    const baselineId = await crearBorradorBaseline(agente, { asUser: gmId });
    await firmarBaseline(baselineId, new Date(), { asUser: gmId });
    await aprobarEstructuraExitoCompartido();

    await activarCobro(agente, baselineId, { asUser: gmId });

    const { rows } = await fixture.engine.admin.query<{ activado_por: string }>(
      "select activado_por from public.cobro_resultado_activacion where hotel_id = $1 and agent_name = $2;",
      [hotelId, agente],
    );
    expect(rows[0]!.activado_por).toBe(gmId);
  });

  it("CASO POSITIVO: línea base firmada dentro de la semana 1 + aprobación del fundador -- la activación SÍ se permite (el gate discrimina de verdad, no solo deniega siempre)", async () => {
    const agente = agentName("motor-revenue");
    const baselineId = await crearBorradorBaseline(agente);
    await firmarBaseline(baselineId, new Date());
    await aprobarEstructuraExitoCompartido();

    await activarCobro(agente, baselineId);

    const { rows } = await fixture.engine.admin.query<{ agent_name: string; roi_baseline_id: string; activado_por: string }>(
      "select agent_name, roi_baseline_id, activado_por from public.cobro_resultado_activacion where hotel_id = $1 and agent_name = $2;",
      [hotelId, agente],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.roi_baseline_id).toBe(baselineId);
    expect(rows[0]!.activado_por).toBe(ownerId);

    // No se puede activar dos veces el mismo (hotel, agente) -- unique(hotel_id, agent_name).
    await expect(activarCobro(agente, baselineId)).rejects.toThrow();
  });

  it("una línea base de OTRO agente (aunque esté firmada) no habilita el cobro de este agente (linea_base_no_corresponde)", async () => {
    const agenteA = agentName("motor-revenue");
    const agenteB = agentName("motor-energia");
    const baselineIdA = await crearBorradorBaseline(agenteA);
    await firmarBaseline(baselineIdA, new Date());
    await aprobarEstructuraExitoCompartido();

    // Se intenta activar el cobro de agenteB usando la línea base FIRMADA de agenteA.
    await expect(activarCobro(agenteB, baselineIdA)).rejects.toThrow(/linea_base_no_corresponde/);
  });
});
