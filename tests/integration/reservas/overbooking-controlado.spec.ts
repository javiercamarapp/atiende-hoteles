// REQ-RES-007/H02-010: sobreventa controlada SOLO dentro de reglas explícitas y
// configurables (máximo de habitaciones + umbral de ocupación) — nunca ilimitada. Caso
// límite exacto exigido por docs/ACEPTACION.md: `max_overbook_rooms = 2`, la 3ª
// solicitud de sobreventa se rechaza.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("sobreventa controlada (REQ-RES-007, embedded-postgres real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let date: string;
  let dateSinSobreventa: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    // Fechas leídas del inventario YA sembrado (horizonte de 30 días desde "hoy",
    // packages/db/src/seed.ts) en vez de un literal fijo: una fecha fuera de ese
    // horizonte no tiene fila de `availability`/`rate_plan` y produce un error de "no
    // existe inventario"/"sin tarifa" ajeno a lo que esta prueba quiere verificar.
    const { rows: seededDates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    date = seededDates[0]!.date;
    dateSinSobreventa = seededDates[seededDates.length - 1]!.date;

    // Deja el inventario de esa noche exactamente lleno (1 total, 1 ya reservada:
    // ocupación 100% >= cualquier umbral) y configura la sobreventa: 2 habitaciones
    // extra permitidas más allá del inventario base.
    await fixture.engine.admin.query(
      "update public.availability set total_rooms = 1, booked_rooms = 1 where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, date],
    );
    await fixture.engine.admin.query(
      "update public.room_type set max_overbook_rooms = 2, overbooking_occupancy_threshold_pct = 95 where id = $1;",
      [roomTypeId],
    );
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function nightAfter(d: string): string {
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }

  function crearReserva(idempotencyKey: string) {
    return fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gmToken}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ roomTypeId, checkInDate: date, checkOutDate: nightAfter(date) }),
    });
  }

  it("permite exactamente 2 sobreventas (max_overbook_rooms=2) y rechaza la 3ª con 409", async () => {
    const primera = await crearReserva(randomUUID());
    expect(primera.status).toBe(201);

    const segunda = await crearReserva(randomUUID());
    expect(segunda.status).toBe(201);

    const tercera = await crearReserva(randomUUID());
    expect(tercera.status).toBe(409);
    const body = (await tercera.json()) as { code: string };
    expect(body.code).toBe("sin_disponibilidad");

    const { rows } = await fixture.engine.admin.query<{ booked_rooms: number; total_rooms: number }>(
      "select booked_rooms, total_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, date],
    );
    // 1 (original) + 2 (sobreventa permitida) = 3; la 3ª solicitud NUNCA se contabilizó.
    expect(rows[0]!.booked_rooms).toBe(3);
    expect(rows[0]!.total_rooms).toBe(1);
  });

  it("sin max_overbook_rooms configurado (0, default), un inventario lleno se rechaza igual que antes de H4", async () => {
    const fechaSinSobreventa = dateSinSobreventa;
    await fixture.engine.admin.query(
      "update public.availability set total_rooms = 1, booked_rooms = 1 where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, fechaSinSobreventa],
    );
    await fixture.engine.admin.query("update public.room_type set max_overbook_rooms = 0 where id = $1;", [roomTypeId]);

    const rechazo = await crearReserva2(fechaSinSobreventa);
    expect(rechazo.status).toBe(409);
  });

  function crearReserva2(checkInDate: string) {
    const checkOutDate = new Date(`${checkInDate}T00:00:00Z`);
    checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 1);
    return fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gmToken}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ roomTypeId, checkInDate, checkOutDate: checkOutDate.toISOString().slice(0, 10) }),
    });
  }
});
