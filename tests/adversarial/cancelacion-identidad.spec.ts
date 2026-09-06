// REQ-RES-005/H03-025: el sistema debe exigir verificación de identidad (código de
// reserva + apellido) antes de procesar cualquier cancelación solicitada por chat/voz
// (POST /reservas/cancelacion-publica, sin sesión de staff — routes/cancelacionPublica.ts,
// SECURITY DEFINER `cancel_reservation_public()` de packages/db). 0 cancelaciones
// ejecutadas ante un dato erróneo; con ambos datos correctos, se procesa.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

describe("adversarial: cancelación pública exige código de reserva + apellido correctos (REQ-RES-005)", () => {
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

  async function crearReservaConHuesped(checkInDate: string, checkOutDate: string, apellido: string) {
    const { rows: guestRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.guest (tenant_id, hotel_id, full_name) values ($1, $2, $3) returning id;",
      [fixture.seed.orgId, hotelId, `Ana ${apellido}`],
    );
    const guestId = guestRows[0]!.id;

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate, checkOutDate }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; codigoConfirmacion: string };
    return body;
  }

  function nightAfter(d: string): string {
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }

  async function seededDate(offset: number): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    return rows[offset]!.date;
  }

  it("código correcto + apellido incorrecto → 0 cancelaciones ejecutadas (rechazada)", async () => {
    const checkIn = await seededDate(0);
    const { id, codigoConfirmacion } = await crearReservaConHuesped(checkIn, nightAfter(checkIn), "Gómez");

    const res = await fixture.app.request("/reservas/cancelacion-publica", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigoReserva: codigoConfirmacion, apellido: "Martínez" }),
    });
    expect(res.status).toBe(401);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.reservation where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("cotizada"); // sin cambios
  });

  it("código incorrecto + apellido correcto → 0 cancelaciones ejecutadas (rechazada, no revela cuál dato falló)", async () => {
    const checkIn = await seededDate(1);
    const { id } = await crearReservaConHuesped(checkIn, nightAfter(checkIn), "Ramírez");

    const res = await fixture.app.request("/reservas/cancelacion-publica", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigoReserva: "FFFFFFFF", apellido: "Ramírez" }),
    });
    expect(res.status).toBe(401);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.reservation where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("cotizada");
  });

  it("código + apellido correctos (coincidencia parcial del apellido dentro del nombre completo) → cancelación procesada", async () => {
    const checkIn = await seededDate(2);
    const { id, codigoConfirmacion } = await crearReservaConHuesped(checkIn, nightAfter(checkIn), "Hernández");

    const res = await fixture.app.request("/reservas/cancelacion-publica", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigoReserva: codigoConfirmacion, apellido: "hernández" }), // sin distinguir mayúsculas
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string };
    expect(body.estado).toBe("cancelada");

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.reservation where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("cancelada");
  });

  it("un código de reserva inexistente nunca revela si el código o el apellido fue el problema", async () => {
    const res = await fixture.app.request("/reservas/cancelacion-publica", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigoReserva: "00000000", apellido: "Nadie" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string };
    expect(body.message).not.toMatch(/no existe|not found/i);
  });
});
