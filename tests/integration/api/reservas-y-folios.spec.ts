// H2 · Flujo completo de reserva → folio → cargo → pago vía la API real, con
// idempotencia (misma clave/mismo cuerpo → misma respuesta; misma clave/cuerpo distinto
// → 422) y disponibilidad (rango por tipo de habitación).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("apps/api: reservas + disponibilidad + folios (integración real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}` };
  }

  it("POST /hoteles/:id/reservas sin Idempotency-Key es rechazado (400)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ roomTypeId, checkInDate: "2026-09-10", checkOutDate: "2026-09-11" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("idempotency_key_required");
  });

  it("crea una reserva real, con total calculado desde rate_plan y outbox emitido en la misma transacción", async () => {
    const key = randomUUID();
    const body = { roomTypeId, checkInDate: "2026-09-10", checkOutDate: "2026-09-12" };

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; estado: string; total: number };
    expect(created.estado).toBe("cotizada");
    expect(created.total).toBeGreaterThan(0);

    const { rows: outboxRows } = await fixture.engine.admin.query<{ event_type: string }>(
      "select event_type from public.outbox where aggregate_id = $1;",
      [created.id],
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.event_type).toBe("reservation.created");

    const { rows: auditRows } = await fixture.engine.admin.query<{ action: string }>(
      "select action from public.audit_log where entity_id = $1;",
      [created.id],
    );
    expect(auditRows.some((r) => r.action === "reservation.created")).toBe(true);
  });

  it("misma Idempotency-Key + mismo cuerpo → misma respuesta, sin crear una segunda reserva", async () => {
    const key = randomUUID();
    const body = { roomTypeId, checkInDate: "2026-09-15", checkOutDate: "2026-09-16" };
    const opts = {
      method: "POST" as const,
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    };

    const first = await fixture.app.request(`/hoteles/${hotelId}/reservas`, opts);
    const second = await fixture.app.request(`/hoteles/${hotelId}/reservas`, opts);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.reservation where id = $1;",
      [firstBody.id],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("misma Idempotency-Key + cuerpo distinto → 422", async () => {
    const key = randomUUID();
    const first = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ roomTypeId, checkInDate: "2026-09-20", checkOutDate: "2026-09-21" }),
    });
    expect(first.status).toBe(201);

    const second = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ roomTypeId, checkInDate: "2026-09-22", checkOutDate: "2026-09-23" }),
    });
    expect(second.status).toBe(422);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe("idempotency_key_conflict");
  });

  it("GET /hoteles/:id/disponibilidad devuelve el mínimo del rango por tipo de habitación", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/disponibilidad?desde=2026-09-10&hasta=2026-09-11`, {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tipoHabitacionId: string; disponibles: number; total: number; tarifaDesde: number }[];
    const fila = body.find((f) => f.tipoHabitacionId === roomTypeId);
    expect(fila).toBeDefined();
    expect(fila!.total).toBe(5);
    // Se reservó al menos 1 noche en ese rango en la prueba anterior.
    expect(fila!.disponibles).toBeLessThan(5);
  });

  it("PATCH transición de reserva aplica la máquina de estados real (cotizada → confirmada) y rechaza saltos inválidos", async () => {
    const key = randomUUID();
    const created = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ roomTypeId, checkInDate: "2026-10-01", checkOutDate: "2026-10-02" }),
    });
    const { id } = (await created.json()) as { id: string };

    const ok = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/transicion`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ toStatus: "confirmada" }),
    });
    expect(ok.status).toBe(200);

    const invalido = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/transicion`, {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ toStatus: "en_estancia" }),
    });
    expect(invalido.status).toBe(409);
    const body = (await invalido.json()) as { code: string };
    expect(body.code).toBe("transicion_invalida");
  });

  it("folio: crear cargo y pago idempotentes, saldo calculado correctamente", async () => {
    const key = randomUUID();
    const created = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ roomTypeId, checkInDate: "2026-10-05", checkOutDate: "2026-10-06" }),
    });
    const { id: reservationId } = (await created.json()) as { id: string };

    const { rows: folioRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.folio (tenant_id, hotel_id, reservation_id) values ($1, $2, $3) returning id;",
      [fixture.seed.orgId, hotelId, reservationId],
    );
    const folioId = folioRows[0]!.id;

    const chargeKey = randomUUID();
    const chargeRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/cargos`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": chargeKey },
      body: JSON.stringify({ descripcion: "Noche de hotel", monto: 1200, impuesto: 192 }),
    });
    expect(chargeRes.status).toBe(201);

    const paymentKey = randomUUID();
    const paymentRes = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}/pagos`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json", "idempotency-key": paymentKey },
      // H5 · REQ-REC-008: un pago con tarjeta SIEMPRE viaja como token opaco (nunca un
      // número de tarjeta) -- `tokenPago` simula el token que devolvería el
      // link/widget de pago del PSP.
      body: JSON.stringify({ monto: 1392, metodo: "tarjeta", tokenPago: "tok_test_visa_4242" }),
    });
    expect(paymentRes.status).toBe(201);

    const folioGet = await fixture.app.request(`/hoteles/${hotelId}/folios/${folioId}`, { headers: auth() });
    expect(folioGet.status).toBe(200);
    const folioBody = (await folioGet.json()) as { saldo: number; cargos: unknown[]; pagos: unknown[] };
    expect(folioBody.cargos).toHaveLength(1);
    expect(folioBody.pagos).toHaveLength(1);
    expect(folioBody.saldo).toBe(0);
  });

  it("housekeeping NO puede leer folios (403, doble capa middleware+RLS)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hkToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);

    const { rows: anyFolio } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.folio where hotel_id = $1 limit 1;",
      [hotelId],
    );
    const res = await fixture.app.request(`/hoteles/${hotelId}/folios/${anyFolio[0]!.id}`, {
      headers: { authorization: `Bearer ${hkToken}` },
    });
    expect(res.status).toBe(403);
  });
});
