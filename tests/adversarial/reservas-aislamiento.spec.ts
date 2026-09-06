// H4 · Un usuario con rol solo en el hotel A nunca ve/afecta reservas del hotel B
// (misma org o distinta), aunque intente el header X-Hotel-Id o adivinar el id de la
// reserva del otro hotel en la URL. Complementa
// tests/adversarial/aislamiento-tenant-hotel.spec.ts (que cubre /resumen) con el caso
// explícito de /reservas citado por el encargo.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: aislamiento de reservas entre hoteles", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  let otherHotelId: string;
  let reservationId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    hotelId = hotelA.id;
    otherHotelId = hotelB.id;
    const gmTokenA = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, hotelA.roomTypes[0]!.id],
    );
    const checkIn = rows[0]!.date;
    const dt = new Date(`${checkIn}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    const checkOut = dt.toISOString().slice(0, 10);

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmTokenA}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId: hotelA.roomTypes[0]!.id, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(res.status).toBe(201);
    reservationId = (await res.json() as { id: string }).id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("GET /hoteles/:hotelB/reservas NUNCA incluye una reserva del hotel A", async () => {
    const hotelB = fixture.seed.hotels[1]!;
    const gmTokenB = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);

    const res = await fixture.app.request(`/hoteles/${otherHotelId}/reservas`, {
      headers: { authorization: `Bearer ${gmTokenB}` },
    });
    expect(res.status).toBe(200);
    const reservas = (await res.json()) as { id: string }[];
    expect(reservas.map((r) => r.id)).not.toContain(reservationId);
  });

  it("staff del hotel B no puede leer la reserva del hotel A ni por su id directo (403)", async () => {
    const hotelB = fixture.seed.hotels[1]!;
    const gmTokenB = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);

    const res = await fixture.app.request(`/hoteles/${otherHotelId}/reservas/${reservationId}`, {
      headers: { authorization: `Bearer ${gmTokenB}` },
    });
    // requireHotelMembership ya bloquea antes de tocar la tabla: el usuario SÍ
    // pertenece a otherHotelId, pero la reserva pertenece a hotelId -- 404 (0 filas),
    // nunca los datos del otro hotel.
    expect(res.status).toBe(404);
  });

  it("staff del hotel B no puede cancelar ni modificar la reserva del hotel A", async () => {
    const hotelB = fixture.seed.hotels[1]!;
    const gmTokenB = await loginAs(fixture.app, hotelB.staff.find((s) => s.role === "gm")!.email);

    const cancelar = await fixture.app.request(`/hoteles/${otherHotelId}/reservas/${reservationId}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmTokenB}` },
    });
    expect(cancelar.status).toBe(404);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.reservation where id = $1;",
      [reservationId],
    );
    expect(rows[0]!.status).toBe("cotizada");
  });

  it("el header X-Hotel-Id no permite cruzar hacia el hotel ajeno (403 antes de llegar a la reserva)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const gmTokenA = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}`, {
      headers: { authorization: `Bearer ${gmTokenA}`, "x-hotel-id": otherHotelId },
    });
    expect(res.status).toBe(403);
  });
});
