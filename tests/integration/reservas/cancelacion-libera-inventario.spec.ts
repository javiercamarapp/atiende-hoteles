// H4 · POST /hoteles/:hotelId/reservas/:id/cancelar (staff): libera TODO el inventario
// de la estancia y aplica `hotel_cancellation_policy` (REQ-RES-004) para calcular la
// penalización. Una reserva ya cancelada/cerrada no admite cancelarse de nuevo.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

function nightAfter(d: string, n = 1): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

describe("cancelación de reserva por staff libera inventario (REQ-RES-004)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let seededDates: string[];

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    // Fechas del inventario YA sembrado (horizonte de 30 días desde "hoy") -- ver
    // overbooking-controlado.spec.ts para el mismo criterio.
    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    seededDates = rows.map((r) => r.date);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("cancela dentro de la ventana libre (sin penalización), libera las 2 noches reservadas Y OTRA RESERVA PUEDE TOMAR ESA MISMA HABITACIÓN (auditoría-1 CRÍTICO)", async () => {
    // Un check-in bien adelante en el horizonte sembrado asegura >24h de anticipación
    // real desde "ahora" (free_until_hours=24 de la política sembrada).
    const checkIn = seededDates[10]!;
    const checkOut = nightAfter(checkIn, 2);

    // Deja solo 1 habitación de cupo en estas 2 noches: así, si la cancelación NO
    // libera de verdad el inventario (el bug original), la SEGUNDA reserva de abajo
    // recibiría 409 "sin_disponibilidad" en vez de 201 -- la prueba deja de poder
    // pasar por casualidad (con 5 habitaciones sembradas, una fuga de inventario podría
    // pasar desapercibida durante mucho tiempo).
    await fixture.engine.admin.query(
      "update public.availability set total_rooms = 1 where hotel_id = $1 and room_type_id = $2 and date in ($3, $4);",
      [hotelId, roomTypeId, checkIn, nightAfter(checkIn, 1)],
    );

    const creada = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(creada.status).toBe(201);
    const { id } = (await creada.json()) as { id: string };

    const { rows: antes } = await fixture.engine.admin.query<{ date: string; booked_rooms: number }>(
      "select date::text as date, booked_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date in ($3, $4);",
      [hotelId, roomTypeId, checkIn, nightAfter(checkIn, 1)],
    );
    expect(antes.every((r) => r.booked_rooms === 1)).toBe(true);

    // Con total_rooms=1 ya ocupado, un segundo intento de reservar la misma
    // habitación/noches debe rechazarse (todavía no se ha cancelado nada).
    const segundoIntentoAntes = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(segundoIntentoAntes.status).toBe(409);

    const cancelada = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(cancelada.status).toBe(200);
    const body = (await cancelada.json()) as { estado: string; montoPenalizacion: number; codigoConfirmacion: string };
    expect(body.estado).toBe("cancelada");
    expect(body.montoPenalizacion).toBe(0);
    expect(body.codigoConfirmacion).toMatch(/^[0-9A-F]{8}$/);

    const { rows: despues } = await fixture.engine.admin.query<{ date: string; booked_rooms: number }>(
      "select date::text as date, booked_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date in ($3, $4);",
      [hotelId, roomTypeId, checkIn, nightAfter(checkIn, 1)],
    );
    expect(despues.every((r) => r.booked_rooms === 0)).toBe(true);

    // La prueba real que pidió la auditoría: OTRA reserva puede tomar la misma
    // habitación/noches ahora que la cancelación liberó el inventario.
    const otraReserva = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(otraReserva.status).toBe(201);
  });

  it("una reserva ya cancelada no admite cancelarse de nuevo (409)", async () => {
    const checkIn = seededDates[15]!;
    const checkOut = nightAfter(checkIn, 1);
    const creada = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    const { id } = (await creada.json()) as { id: string };

    const primeraCancelacion = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(primeraCancelacion.status).toBe(200);

    const segundaCancelacion = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(segundaCancelacion.status).toBe(409);
  });

  it("frontdesk/reservations SÍ pueden cancelar; housekeeping NO (403)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const checkIn = seededDates[20]!;
    const checkOut = nightAfter(checkIn, 1);
    const creada = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    const { id } = (await creada.json()) as { id: string };

    const hkToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);
    const rechazo = await fixture.app.request(`/hoteles/${hotelId}/reservas/${id}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${hkToken}` },
    });
    expect(rechazo.status).toBe(403);
  });
});
