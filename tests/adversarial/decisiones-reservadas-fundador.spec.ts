// REQ-GOB-012 (fuentes GOB-051/GOB-052/BP-066/BP-082/BP-145/BP-150/LLM-022/BP-065/
// H18-004): catálogo cerrado de 24 categorías de decisión reservadas exclusivamente al
// fundador humano (`public.founder_reserved_category`, migración 0081) — cualquier
// intento de cambio en esos dominios sin una aprobación registrada y vigente del
// fundador debe bloquearse, verificado aquí con un intento REAL de cambio (INSERT/
// UPDATE contra Postgres real, nunca un mock) en cada una de 5 categorías muestreadas,
// cubriendo las 3 superficies que introduce/gatea 0081:
//   - `register_identity_document()` (0067, gateada por 0081): retención de identidad
//     >30 días.
//   - `agent_config` (0025, gateada por 0081): paso a autopilot del agente de
//     revenue/cierre.
//   - `founder_reserved_setting` (0081, genérica): categorías sin tabla de dominio
//     propia (cambio de proveedor de modelo/telefonía/BD, precios de lista, borrado
//     destructivo/force-push).
// Además: (a) el catálogo es CERRADO de verdad (Postgres rechaza una categoría
// inventada con un error real de enum, no una validación de aplicación evadible), (b)
// SOLO el fundador puede registrar o revocar una aprobación — ni el owner de un
// hotel-cliente puede, sin importar su rol, y (c) una vez registrada la aprobación, el
// MISMO cambio que antes se bloqueaba pasa (el gate discrimina de verdad, no solo
// deniega siempre).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";

describe("adversarial: catálogo cerrado de decisiones reservadas al fundador (REQ-GOB-012)", () => {
  let fixture: PgFixture;
  let founderId: string;
  let hotelId: string;
  let orgId: string;
  let ownerId: string;
  let gmId: string;

  beforeAll(async () => {
    fixture = await createPgFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    orgId = fixture.seed.orgId;
    ownerId = hotel.staff.find((s) => s.role === "owner")!.id;
    gmId = hotel.staff.find((s) => s.role === "gm")!.id;

    // El fundador es una identidad de PLATAFORMA, no un miembro de `hotel_staff` de
    // ningún hotel-cliente -- se registra directo con el cliente admin (superusuario,
    // igual que el alta de org/hotel en H1), nunca desde una sesión de aplicación.
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

  async function crearReserva(): Promise<string> {
    const { rows } = await fixture.engine.withAppSession({ userId: gmId }, async (db) =>
      db.query<{ id: string }>(
        `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, total_amount)
         values ($1, $2, $3, current_date, current_date + 3, 3600)
         returning id;`,
        [orgId, hotelId, fixture.seed.hotels[0]!.roomTypes[0]!.id],
      ),
    );
    return rows[0]!.id;
  }

  async function registrarAprobacion(category: string, opts: { orgId?: string | null; hotelId?: string | null } = {}) {
    return fixture.engine.withAppSession({ userId: founderId }, (db) =>
      db.query(
        `insert into public.founder_decision_approval (category, org_id, hotel_id, decided_by, texto_exacto)
         values ($1, $2, $3, $4, $5);`,
        [
          category,
          opts.orgId === undefined ? orgId : opts.orgId,
          opts.hotelId === undefined ? hotelId : opts.hotelId,
          founderId,
          `Apruebo "${category}" para efectos de la prueba adversarial REQ-GOB-012.`,
        ],
      ),
    );
  }

  it("el catálogo es cerrado de verdad: una categoría fuera del enum es rechazada por Postgres, no por una validación evadible", async () => {
    await expect(registrarAprobacion("categoria_inventada_fuera_del_catalogo")).rejects.toThrow(
      /invalid input value for enum founder_reserved_category/,
    );
  });

  it("solo el fundador puede registrar una aprobación -- el owner del hotel-cliente NO puede, sin importar su rol", async () => {
    await expect(
      fixture.engine.withAppSession({ userId: ownerId }, (db) =>
        db.query(
          `insert into public.founder_decision_approval (category, org_id, hotel_id, decided_by, texto_exacto)
           values ('precios_de_lista', $1, $2, $3, 'lo apruebo yo mismo');`,
          [orgId, hotelId, ownerId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const { rows } = await fixture.engine.admin.query(
      "select 1 from public.founder_decision_approval where category = 'precios_de_lista' and hotel_id = $1;",
      [hotelId],
    );
    expect(rows).toHaveLength(0);
  });

  // Categoría 1/5 -- "retención de identidad >30 días", superficie real
  // `register_identity_document()` (0067, gateada en 0081).
  it('categoría "retencion_identidad_mayor_30_dias": extender la retención a 45 días se bloquea sin aprobación del fundador, y se permite una vez registrada', async () => {
    const reservationId = await crearReserva();

    const intentar = () =>
      fixture.engine.withAppSession({ userId: ownerId }, (db) =>
        db.query(
          `select * from public.register_identity_document($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
          [
            orgId,
            hotelId,
            reservationId,
            "Ana Pérez",
            "MX",
            "ine",
            "AB12",
            Buffer.from("ciphertext"),
            Buffer.from("iv"),
            Buffer.from("authtag"),
            45,
            "Litigio en curso, retiene el hotel por instrucción de su abogado.",
          ],
        ),
      );

    // Sin aprobación del fundador: el rol owner/gm ya no basta por sí solo (REQ-GOB-012).
    await expect(intentar()).rejects.toThrow(/aprobacion_fundador_requerida/);

    const { rows: antes } = await fixture.engine.admin.query(
      "select 1 from public.identity_ref where reservation_id = $1;",
      [reservationId],
    );
    expect(antes).toHaveLength(0);

    // El fundador registra la aprobación para esta org/hotel...
    await registrarAprobacion("retencion_identidad_mayor_30_dias");

    // ...y ahora el MISMO intento pasa (el gate discrimina, no deniega siempre).
    const { rows: ref } = await intentar();
    expect(ref).toHaveLength(1);

    const { rows: despues } = await fixture.engine.admin.query<{ retention_days: number }>(
      `select v.retention_days from public.identity_vault v
       join public.identity_ref r on r.vault_id = v.id
       where r.reservation_id = $1;`,
      [reservationId],
    );
    expect(despues[0]!.retention_days).toBe(45);
  });

  // Categoría 2/5 -- "shadow -> autopilot de revenue", superficie real `agent_config`
  // (0025, gateada en 0081): solo el agente de revenue/cierre (`auditor_nocturno`).
  it('categoría "shadow_a_autopilot_revenue": subir auditor_nocturno a autopilot se bloquea sin aprobación, y se permite una vez registrada', async () => {
    const intentar = () =>
      fixture.engine.withAppSession({ userId: ownerId }, (db) =>
        db.query(
          `insert into public.agent_config (org_id, hotel_id, agent_name, gate, monthly_ceiling_usd)
           values ($1, $2, 'auditor_nocturno', 'autopilot', 15)
           on conflict (hotel_id, agent_name) do update set gate = excluded.gate;`,
          [orgId, hotelId],
        ),
      );

    await expect(intentar()).rejects.toThrow(/aprobacion_fundador_requerida/);

    const { rows: antes } = await fixture.engine.admin.query<{ gate: string }>(
      "select gate from public.agent_config where hotel_id = $1 and agent_name = 'auditor_nocturno';",
      [hotelId],
    );
    expect(antes).toHaveLength(0); // el INSERT completo se revirtió, no quedó a medias.

    // Confirma que un agente NO ligado a revenue (recepcion_virtual) NUNCA estuvo
    // sujeto a esta categoría -- sigue gobernado solo por owner/gm, como antes de 0081.
    await fixture.engine.withAppSession({ userId: ownerId }, (db) =>
      db.query(
        `insert into public.agent_config (org_id, hotel_id, agent_name, gate, monthly_ceiling_usd)
         values ($1, $2, 'recepcion_virtual', 'autopilot', 45)
         on conflict (hotel_id, agent_name) do update set gate = excluded.gate;`,
        [orgId, hotelId],
      ),
    );
    const { rows: recepcion } = await fixture.engine.admin.query<{ gate: string }>(
      "select gate from public.agent_config where hotel_id = $1 and agent_name = 'recepcion_virtual';",
      [hotelId],
    );
    expect(recepcion[0]!.gate).toBe("autopilot");

    await registrarAprobacion("shadow_a_autopilot_revenue");
    await intentar();

    const { rows: despues } = await fixture.engine.admin.query<{ gate: string }>(
      "select gate from public.agent_config where hotel_id = $1 and agent_name = 'auditor_nocturno';",
      [hotelId],
    );
    expect(despues[0]!.gate).toBe("autopilot");
  });

  // Categoría 3/5 -- "precios de lista", superficie genérica `founder_reserved_setting`
  // con alcance de UN hotel.
  it('categoría "precios_de_lista": fijar la estructura de precio de lista de un hotel se bloquea sin aprobación, y se permite una vez registrada', async () => {
    const intentar = () =>
      fixture.engine.withAppSession({ userId: ownerId }, (db) =>
        db.query(
          `insert into public.founder_reserved_setting (category, org_id, hotel_id, key, value)
           values ('precios_de_lista', $1, $2, 'rack_rate_estandar_mxn', '1500'::jsonb);`,
          [orgId, hotelId],
        ),
      );

    await expect(intentar()).rejects.toThrow(/aprobacion_fundador_requerida/);
    const { rows: antes } = await fixture.engine.admin.query(
      "select 1 from public.founder_reserved_setting where category = 'precios_de_lista' and hotel_id = $1;",
      [hotelId],
    );
    expect(antes).toHaveLength(0);

    await registrarAprobacion("precios_de_lista");
    await intentar();

    const { rows: despues } = await fixture.engine.admin.query<{ value: number }>(
      "select value from public.founder_reserved_setting where category = 'precios_de_lista' and hotel_id = $1;",
      [hotelId],
    );
    expect(despues[0]!.value).toBe(1500);
  });

  // Categoría 4/5 -- "cambio de proveedor de modelo/telefonía/BD", alcance de TODA la
  // plataforma (org_id/hotel_id NULL) -- bloqueado en DOS capas independientes: (a) sin
  // aprobación registrada, el trigger bloquea a CUALQUIERA (incluido el propio
  // fundador -- ser el fundador no es un atajo para saltarse el registro explícito), y
  // (b) incluso YA CON la aprobación registrada, RLS sigue bloqueando a quien no es el
  // fundador -- un owner nunca puede tocar configuración de plataforma, sin importar
  // cuántas aprobaciones existan.
  it('categoría "cambio_proveedor_modelo_telefonia_bd" (alcance plataforma): bloqueado sin aprobación (incluso para el fundador) y bloqueado para el owner incluso YA con aprobación', async () => {
    const intentarComoOwner = () =>
      fixture.engine.withAppSession({ userId: ownerId }, (db) =>
        db.query(
          `insert into public.founder_reserved_setting (category, org_id, hotel_id, key, value)
           values ('cambio_proveedor_modelo_telefonia_bd', null, null, 'model_provider', '"anthropic"'::jsonb);`,
        ),
      );
    const intentarComoFundador = () =>
      fixture.engine.withAppSession({ userId: founderId }, (db) =>
        db.query(
          `insert into public.founder_reserved_setting (category, org_id, hotel_id, key, value)
           values ('cambio_proveedor_modelo_telefonia_bd', null, null, 'model_provider', '"anthropic"'::jsonb);`,
        ),
      );

    // Sin aprobación registrada: el trigger BEFORE INSERT corre antes que la RLS WITH
    // CHECK y bloquea a cualquiera -- ni siquiera el fundador puede saltarse su propio
    // registro.
    await expect(intentarComoOwner()).rejects.toThrow(/aprobacion_fundador_requerida/);
    await expect(intentarComoFundador()).rejects.toThrow(/aprobacion_fundador_requerida/);

    await registrarAprobacion("cambio_proveedor_modelo_telefonia_bd", { orgId: null, hotelId: null });

    // Ya CON la aprobación: el trigger deja pasar, pero la RLS (capa independiente)
    // sigue exigiendo ser el fundador para escribir configuración de plataforma -- el
    // owner sigue bloqueado, ahora por una razón distinta.
    await expect(intentarComoOwner()).rejects.toThrow(/row-level security/i);

    await intentarComoFundador();

    const { rows } = await fixture.engine.admin.query<{ value: string }>(
      "select value from public.founder_reserved_setting where category = 'cambio_proveedor_modelo_telefonia_bd' and org_id is null;",
    );
    expect(rows[0]!.value).toBe("anthropic");
  });

  // Categoría 5/5 -- "borrado destructivo/force-push", alcance de plataforma.
  it('categoría "borrado_destructivo_o_force_push": se bloquea sin aprobación, y se permite una vez registrada', async () => {
    const intentar = () =>
      fixture.engine.withAppSession({ userId: founderId }, (db) =>
        db.query(
          `insert into public.founder_reserved_setting (category, org_id, hotel_id, key, value)
           values ('borrado_destructivo_o_force_push', null, null, 'force_push_main_habilitado', 'true'::jsonb);`,
        ),
      );

    await expect(intentar()).rejects.toThrow(/aprobacion_fundador_requerida/);

    await registrarAprobacion("borrado_destructivo_o_force_push", { orgId: null, hotelId: null });
    await intentar();

    const { rows } = await fixture.engine.admin.query<{ value: boolean }>(
      "select value from public.founder_reserved_setting where category = 'borrado_destructivo_o_force_push';",
    );
    expect(rows[0]!.value).toBe(true);
  });

  it("una aprobación revocada deja de cubrir el cambio (revocar no es borrar -- queda el registro, pero ya no autoriza)", async () => {
    await registrarAprobacion("modo_sin_recepcion_nocturna", { orgId, hotelId: null });

    const setKey = () =>
      fixture.engine.withAppSession({ userId: founderId }, (db) =>
        db.query(
          `insert into public.founder_reserved_setting (category, org_id, hotel_id, key, value)
           values ('modo_sin_recepcion_nocturna', $1, null, 'activo', 'true'::jsonb)
           on conflict do nothing;`,
          [orgId],
        ),
      );
    await setKey(); // pasa mientras la aprobación sigue vigente.

    await fixture.engine.withAppSession({ userId: founderId }, (db) =>
      db.query(
        `update public.founder_decision_approval
         set revoked_at = now()
         where category = 'modo_sin_recepcion_nocturna' and org_id = $1 and hotel_id is null;`,
        [orgId],
      ),
    );

    await expect(
      fixture.engine.withAppSession({ userId: founderId }, (db) =>
        db.query(
          `insert into public.founder_reserved_setting (category, org_id, hotel_id, key, value)
           values ('modo_sin_recepcion_nocturna', $1, null, 'activo_v2', 'true'::jsonb);`,
          [orgId],
        ),
      ),
    ).rejects.toThrow(/aprobacion_fundador_requerida/);
  });

  it("una aprobación ya registrada es inmutable: intentar reescribir su texto/categoría (en vez de solo revocar) se bloquea", async () => {
    const { rows } = await fixture.engine.withAppSession({ userId: founderId }, (db) =>
      db.query<{ id: string }>(
        `insert into public.founder_decision_approval (category, org_id, hotel_id, decided_by, texto_exacto)
         values ('reduccion_de_plantilla', $1, null, $2, 'texto original aprobado') returning id;`,
        [orgId, founderId],
      ),
    );
    const approvalId = rows[0]!.id;

    await expect(
      fixture.engine.withAppSession({ userId: founderId }, (db) =>
        db.query("update public.founder_decision_approval set texto_exacto = 'texto reescrito' where id = $1;", [approvalId]),
      ),
    ).rejects.toThrow(/aprobacion_inmutable/);
  });
});
