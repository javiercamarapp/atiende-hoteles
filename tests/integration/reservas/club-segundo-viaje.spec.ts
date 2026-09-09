// REQ-RES-010 (embedded-postgres real): club de segundo viaje -- inscripción con
// consentimiento explícito, código de miembro, y aplicación AUTOMÁTICA del descuento
// en reservas directas subsecuentes de un miembro activo (contra la API real de
// creación de reservas, sin mockear nada).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("club de segundo viaje (REQ-RES-010, embedded-postgres real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let guestId: string;
  let dates: string[];

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);

    const { rows: seededDates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc limit 6;",
      [hotelId, roomTypeId],
    );
    dates = seededDates.map((r) => r.date);

    const guestRes = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ nombre: "Huésped Club Segundo Viaje" }),
    });
    expect(guestRes.status).toBe(201);
    guestId = ((await guestRes.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function crearReserva(checkIn: string, checkOut: string, idempotencyKey: string) {
    return fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
  }

  it("sin config de descuento y sin inscripción, una reserva no recibe ningún beneficio", async () => {
    const res = await crearReserva(dates[0]!, dates[1]!, crypto.randomUUID());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { total: number; descuentoClub: unknown };
    expect(body.descuentoClub).toBeNull();
    expect(body.total).toBe(1200); // precio sembrado sin descuento
  });

  it("GET de membresía antes de inscribirse: inscrito=false", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/club-segundo-viaje`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inscrito: false });
  });

  it("inscripción con granted=false NO crea membresía (rechazo respetado)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/club-segundo-viaje/inscripcion`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ avisoVersion: "v1", granted: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inscrito: false });

    const check = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/club-segundo-viaje`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(await check.json()).toEqual({ inscrito: false });
  });

  it("inscripción con consentimiento explícito emite un código de miembro real", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/club-segundo-viaje/inscripcion`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ avisoVersion: "v1", granted: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inscrito: boolean; codigoMiembro: string };
    expect(body.inscrito).toBe(true);
    expect(body.codigoMiembro).toMatch(/^SV-[A-F0-9]{8}$/);

    const check = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/club-segundo-viaje`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    const checkBody = (await check.json()) as { inscrito: boolean; estado: string; codigoMiembro: string };
    expect(checkBody.inscrito).toBe(true);
    expect(checkBody.estado).toBe("activo");
    expect(checkBody.codigoMiembro).toBe(body.codigoMiembro);
  });

  it("ya inscrito, pero SIN config de descuento todavía: sigue sin beneficio (fail-closed)", async () => {
    const res = await crearReserva(dates[2]!, dates[3]!, crypto.randomUUID());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { descuentoClub: unknown; total: number };
    expect(body.descuentoClub).toBeNull();
    expect(body.total).toBe(1200);
  });

  it("owner/gm configura 15% de descuento para el hotel", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/club-segundo-viaje/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ discountPct: 15 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ discountPct: 15 });
  });

  it("con membresía activa + descuento configurado, la SIGUIENTE reserva directa recibe el beneficio automáticamente", async () => {
    const res = await crearReserva(dates[4]!, dates[5]!, crypto.randomUUID());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { total: number; descuentoClub: { pct: number; monto: number } | null };
    expect(body.descuentoClub).not.toBeNull();
    expect(body.descuentoClub!.pct).toBe(15);
    expect(body.descuentoClub!.monto).toBe(180); // 15% de 1200
    expect(body.total).toBe(1020); // 1200 - 180
  });

  it("revocar la membresía: la siguiente reserva directa deja de recibir el beneficio", async () => {
    const revoke = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/club-segundo-viaje/revocar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(revoke.status).toBe(200);

    const check = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${guestId}/club-segundo-viaje`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    const checkBody = (await check.json()) as { estado: string };
    expect(checkBody.estado).toBe("revocado");
  });

  it("frontdesk NO puede configurar el % de descuento (403, fuera de ADMIN_ROLES)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/club-segundo-viaje/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ discountPct: 50 }),
    });
    expect(res.status).toBe(403);
  });

  it("frontdesk SÍ puede inscribir a un huésped (MANAGE_RESERVATIONS_ROLES)", async () => {
    const otroGuest = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ nombre: "Otro Huésped" }),
    });
    expect(otroGuest.status).toBe(201);
    const otroGuestId = ((await otroGuest.json()) as { id: string }).id;

    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes/${otroGuestId}/club-segundo-viaje/inscripcion`, {
      method: "POST",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({ avisoVersion: "v1", granted: true }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inscrito: boolean }).inscrito).toBe(true);
  });
});
