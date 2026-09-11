// H2 · ADR-004/ADR-009: matriz de roles y escalada — housekeeping/maintenance NO pueden
// leer/escribir dinero (folio/charge/payment) ni crear/transicionar reservas; un
// intento se rechaza en DOS capas (middleware de la API + RLS de packages/db). También
// cubre "housekeeping intentando leer folio → 403 y RLS vacía" citado en el encargo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";
import { MONEY_ROLES, HOTEL_ROLES } from "@atiende-hoteles/api";

// Bug real de CI (10-sep-2026): fechas que eran literales absolutos se quedan fuera
// de la ventana de tarifa/disponibilidad sembrada por seedDev (siempre desde "hoy"
// real, 30 días) tarde o temprano -- corregidas a offsets relativos, nunca "hoy" mismo.
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}


describe("adversarial: matriz de roles (REQ-TEN-003) y escalada", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  let folioId: string;
  let reservationId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;

    const { rows: reservationRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, total_amount)
       values ($1, $2, $3, current_date, current_date + 1, 1200) returning id;`,
      [fixture.seed.orgId, hotelA.id, hotelA.roomTypes[0]!.id],
    );
    reservationId = reservationRows[0]!.id;

    const { rows: folioRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.folio (tenant_id, hotel_id, reservation_id) values ($1, $2, $3) returning id;",
      [fixture.seed.orgId, hotelId, reservationId],
    );
    folioId = folioRows[0]!.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it.each(HOTEL_ROLES)("rol %s: GET resumen del propio hotel siempre permitido (lectura operativa general)", async (role) => {
    const hotelA = fixture.seed.hotels[0]!;
    const staff = hotelA.staff.find((s) => s.role === role)!;
    const token = await loginAs(fixture.app, staff.email);

    const res = await fixture.app.request(`/hoteles/${hotelId}/resumen`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  const NO_MONEY_ROLES = HOTEL_ROLES.filter((r) => !MONEY_ROLES.includes(r));

  it.each(NO_MONEY_ROLES)("rol %s NO puede leer un folio (403, RLS vacía)", async (role) => {
    const hotelA = fixture.seed.hotels[0]!;
    const staff = hotelA.staff.find((s) => s.role === role)!;
    const token = await loginAs(fixture.app, staff.email);

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
  });

  // Patrón Likida/atiende.ai #6: mitad faltante del patrón de autorización por rol --
  // antes de este cambio, el 403 de arriba (housekeeping leyendo un folio) no dejaba
  // NINGÚN rastro en audit_log ni en el logger estructurado (app.ts `onError` solo
  // registraba `status >= 500`). Esta prueba verifica extremo a extremo (API real +
  // Postgres real) que ahora sí queda una fila `access.denied`, bajo el tenant REAL del
  // hotel objetivo (no el que el actor reclama en su JWT), con el actor/ruta/motivo.
  it("un 403 de assertRole (housekeeping leyendo un folio) queda auditado en audit_log como 'access.denied'", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hk = hotelA.staff.find((s) => s.role === "housekeeping")!;
    const token = await loginAs(fixture.app, hk.email);

    const before = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.audit_log where hotel_id = $1 and action = 'access.denied';",
      [hotelId],
    );
    const countBefore = Number(before.rows[0]!.count);

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);

    const { rows } = await fixture.engine.admin.query<{
      tenant_id: string;
      hotel_id: string;
      actor_user_id: string;
      action: string;
      entity_type: string;
      payload: { route: string; method: string; reason: string };
    }>(
      `select tenant_id, hotel_id, actor_user_id, action, entity_type, payload
       from public.audit_log
       where hotel_id = $1 and action = 'access.denied'
       order by created_at desc limit 1;`,
      [hotelId],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tenant_id).toBe(fixture.seed.orgId); // tenant REAL del hotel, no uno inventado.
    expect(row.actor_user_id).toBe(hk.id);
    expect(row.entity_type).toBe("route");
    expect(row.payload.route).toBe(`/hoteles/${hotelId}/folios/${folioId}`);
    expect(row.payload.method).toBe("GET");
    expect(row.payload.reason).toMatch(/housekeeping/);

    const after = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.audit_log where hotel_id = $1 and action = 'access.denied';",
      [hotelId],
    );
    expect(Number(after.rows[0]!.count)).toBe(countBefore + 1); // exactamente una fila nueva, no un duplicado.
  });

  it.each(MONEY_ROLES)("rol %s SÍ puede leer un folio de su hotel", async (role) => {
    const hotelA = fixture.seed.hotels[0]!;
    const staff = hotelA.staff.find((s) => s.role === role)!;
    const token = await loginAs(fixture.app, staff.email);

    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("housekeeping intentando insertar un payment directamente (bypaseando la API) es rechazado por RLS", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hk = hotelA.staff.find((s) => s.role === "housekeeping")!;

    await expect(
      fixture.engine.withAppSession({ userId: hk.id }, async (session) => {
        await session.query(
          "insert into public.payment (tenant_id, hotel_id, folio_id, amount, method) values ($1, $2, $3, $4, $5);",
          [fixture.seed.orgId, hotelId, folioId, 500, "efectivo"],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("housekeeping NO puede crear una reserva (403)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hk = hotelA.staff.find((s) => s.role === "housekeeping")!;
    const token = await loginAs(fixture.app, hk.email);

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "hk-intento-1" },
      body: JSON.stringify({ roomTypeId: hotelA.roomTypes[0]!.id, checkInDate: isoDate(16), checkOutDate: isoDate(17) }),
    });
    expect(res.status).toBe(403);
  });

  it("reservations SÍ puede crear una reserva (rol permitido)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const staff = hotelA.staff.find((s) => s.role === "reservations")!;
    const token = await loginAs(fixture.app, staff.email);

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "reservations-ok-1" },
      body: JSON.stringify({ roomTypeId: hotelA.roomTypes[0]!.id, checkInDate: isoDate(18), checkOutDate: isoDate(19) }),
    });
    expect(res.status).toBe(201);
  });

  it("escalada: un usuario staff intentando una ruta de back office inexistente recibe 404, nunca datos", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const token = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);
    const res = await fixture.app.request("/reportes/pl", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });
});
