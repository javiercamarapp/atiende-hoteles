// REQ-RES-006/H01-010,H02-011 (P1/F, ACEPTACION.md): "Cancelación de una reserva con
// lista de espera activa dispara oferta automática al primer contacto en cola, al
// precio directo (sin comisión), verificado por orden FIFO de la cola." Contra
// embedded-postgres real (RLS real, mismo advisory lock que book_availability/
// release_availability) -- ver tests/unit/domain-hotel/waitlist.spec.ts para la lógica
// pura de selección FIFO/expiración.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

function nightAfter(d: string, n = 1): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

describe("lista de espera automática (REQ-RES-006, embedded-postgres real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hkToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let seededDates: string[];

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    hkToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);

    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    seededDates = rows.map((r) => r.date);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function crearHuesped(nombre: string): Promise<string> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ nombre }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async function unirseALista(guestId: string, checkInDate: string, checkOutDate: string) {
    return fixture.app.request(`/hoteles/${hotelId}/lista-espera`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate, checkOutDate }),
    });
  }

  it("al cancelar una reserva con lista de espera activa, se oferta automáticamente al PRIMER contacto FIFO, al precio directo (mismo neto que la reserva cancelada) — nunca al segundo", async () => {
    const checkIn = seededDates[5]!;
    const checkOut = nightAfter(checkIn, 1);

    // Deja el inventario de esa noche exactamente lleno con UNA reserva: cualquier otro
    // intento directo de reservar esa fecha/room_type se rechaza (por eso existe una
    // lista de espera para empezar).
    await fixture.engine.admin.query(
      "update public.availability set total_rooms = 1, booked_rooms = 0 where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, checkIn],
    );

    const reservaOriginal = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(reservaOriginal.status).toBe(201);
    const { id: reservationId, total: totalOriginal } = (await reservaOriginal.json()) as { id: string; total: number };

    // Confirma que, en efecto, no hay más inventario disponible (justifica la lista de
    // espera).
    const rechazoDirecto = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(rechazoDirecto.status).toBe(409);

    const guestA = await crearHuesped("Contacto A (debe ganar la oferta)");
    const guestB = await crearHuesped("Contacto B (segundo en la cola)");

    // B se inscribe PRIMERO en tiempo real (insertion order) pero su `created_at` se
    // fuerza DESPUÉS del de A a propósito: la prueba real de FIFO es que gana el
    // created_at más antiguo, nunca el orden en que llegaron las requests HTTP (mismo
    // criterio que tests/unit/domain-hotel/waitlist.spec.ts "sin importar el orden de
    // entrada").
    const joinB = await unirseALista(guestB, checkIn, checkOut);
    expect(joinB.status).toBe(201);
    const { id: entryB } = (await joinB.json()) as { id: string };

    const joinA = await unirseALista(guestA, checkIn, checkOut);
    expect(joinA.status).toBe(201);
    const { id: entryA } = (await joinA.json()) as { id: string };

    await fixture.engine.admin.query(
      "update public.hotel_waitlist_entry set created_at = now() - interval '1 hour' where id = $1;",
      [entryA],
    );
    await fixture.engine.admin.query(
      "update public.hotel_waitlist_entry set created_at = now() - interval '10 minutes' where id = $1;",
      [entryB],
    );

    // Antes de cancelar: ambas entradas siguen 'esperando', ninguna oferta existe todavía.
    const { rows: antesDeOfertar } = await fixture.engine.admin.query<{ id: string; status: string }>(
      "select id, status from public.hotel_waitlist_entry where id in ($1, $2);",
      [entryA, entryB],
    );
    expect(antesDeOfertar.every((r) => r.status === "esperando")).toBe(true);

    const cancelacion = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(cancelacion.status).toBe(200);
    const cancelBody = (await cancelacion.json()) as { estado: string; listaEsperaOfertada: boolean };
    expect(cancelBody.estado).toBe("cancelada");
    expect(cancelBody.listaEsperaOfertada).toBe(true);

    const { rows: despuesDeOfertar } = await fixture.engine.admin.query<{
      id: string;
      status: string;
      offer_amount: string | null;
      offer_expires_at: string | null;
    }>(
      "select id, status, offer_amount::text as offer_amount, offer_expires_at::text as offer_expires_at from public.hotel_waitlist_entry where id in ($1, $2);",
      [entryA, entryB],
    );
    const rowA = despuesDeOfertar.find((r) => r.id === entryA)!;
    const rowB = despuesDeOfertar.find((r) => r.id === entryB)!;

    // El PRIMERO de la cola (A, created_at más antiguo) recibió la oferta...
    expect(rowA.status).toBe("ofertada");
    expect(rowA.offer_expires_at).not.toBeNull();
    // ...al precio DIRECTO: exactamente el mismo neto que se cobró en la reserva
    // original que se acaba de cancelar (sin comisión añadida ni descontada).
    expect(Number(rowA.offer_amount)).toBe(totalOriginal);

    // ...y el SEGUNDO (B) sigue esperando: la oferta NUNCA se le adelanta a quien llegó
    // después en la cola.
    expect(rowB.status).toBe("esperando");
    expect(rowB.offer_amount).toBeNull();

    // GET refleja el mismo orden FIFO (A antes que B).
    const listado = await fixture.app.request(`/hoteles/${hotelId}/lista-espera?roomTypeId=${roomTypeId}`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(listado.status).toBe(200);
    const entradas = (await listado.json()) as Array<{ id: string; estado: string }>;
    const idxA = entradas.findIndex((e) => e.id === entryA);
    const idxB = entradas.findIndex((e) => e.id === entryB);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);

    // Aceptar la oferta de A crea la reserva real, al precio congelado en la oferta.
    const aceptar = await fixture.app.request(`/hoteles/${hotelId}/lista-espera/${entryA}/aceptar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(aceptar.status).toBe(200);
    const aceptarBody = (await aceptar.json()) as { id: string; total: number; estado: string };
    expect(aceptarBody.total).toBe(totalOriginal);
    expect(aceptarBody.estado).toBe("cotizada");

    const { rows: entryAFinal } = await fixture.engine.admin.query<{ status: string; reservation_id: string | null }>(
      "select status, reservation_id from public.hotel_waitlist_entry where id = $1;",
      [entryA],
    );
    expect(entryAFinal[0]!.status).toBe("confirmada");
    expect(entryAFinal[0]!.reservation_id).toBe(aceptarBody.id);

    // Una segunda aceptación de la MISMA oferta ya confirmada se rechaza (409).
    const segundaAceptacion = await fixture.app.request(`/hoteles/${hotelId}/lista-espera/${entryA}/aceptar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(segundaAceptacion.status).toBe(409);

    // Cancelar la reserva que acaba de nacer de la oferta de A libera el inventario OTRA
    // VEZ -- ahora le toca a B, el SIGUIENTE de la cola.
    const cancelacion2 = await fixture.app.request(`/hoteles/${hotelId}/reservas/${aceptarBody.id}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(cancelacion2.status).toBe(200);
    const cancel2Body = (await cancelacion2.json()) as { listaEsperaOfertada: boolean };
    expect(cancel2Body.listaEsperaOfertada).toBe(true);

    const { rows: rowBFinal } = await fixture.engine.admin.query<{ status: string; offer_amount: string | null }>(
      "select status, offer_amount::text as offer_amount from public.hotel_waitlist_entry where id = $1;",
      [entryB],
    );
    expect(rowBFinal[0]!.status).toBe("ofertada");
    expect(Number(rowBFinal[0]!.offer_amount)).toBe(totalOriginal);
  });

  it("una cancelación sin ninguna entrada de lista de espera coincidente no oferta nada (listaEsperaOfertada=false)", async () => {
    const checkIn = seededDates[6]!;
    const checkOut = nightAfter(checkIn, 1);

    const reserva = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(reserva.status).toBe(201);
    const { id: reservationId } = (await reserva.json()) as { id: string };

    const cancelacion = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(cancelacion.status).toBe(200);
    const body = (await cancelacion.json()) as { listaEsperaOfertada: boolean };
    expect(body.listaEsperaOfertada).toBe(false);
  });

  it("la cancelación PÚBLICA (código+apellido, REQ-RES-005, sin sesión de staff) TAMBIÉN dispara la oferta automática", async () => {
    const checkIn = seededDates[8]!;
    const checkOut = nightAfter(checkIn, 1);

    await fixture.engine.admin.query(
      "update public.availability set total_rooms = 1, booked_rooms = 0 where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, checkIn],
    );

    const { rows: guestRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.guest (tenant_id, hotel_id, full_name) values ($1, $2, $3) returning id;",
      [fixture.seed.orgId, hotelId, "Huésped Pública Gómez"],
    );
    const guestHuesped = guestRows[0]!.id;

    const reserva = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId: guestHuesped, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(reserva.status).toBe(201);
    const { total: totalOriginal, codigoConfirmacion } = (await reserva.json()) as { total: number; codigoConfirmacion: string };

    const guestEnCola = await crearHuesped("Contacto en cola (cancelación pública)");
    const join = await unirseALista(guestEnCola, checkIn, checkOut);
    expect(join.status).toBe(201);
    const { id: entryId } = (await join.json()) as { id: string };

    const cancelacionPublica = await fixture.app.request("/reservas/cancelacion-publica", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codigoReserva: codigoConfirmacion, apellido: "Gómez" }),
    });
    expect(cancelacionPublica.status).toBe(200);
    const cancelBody = (await cancelacionPublica.json()) as { estado: string; listaEsperaOfertada: boolean };
    expect(cancelBody.estado).toBe("cancelada");
    expect(cancelBody.listaEsperaOfertada).toBe(true);

    const { rows } = await fixture.engine.admin.query<{ status: string; offer_amount: string | null }>(
      "select status, offer_amount::text as offer_amount from public.hotel_waitlist_entry where id = $1;",
      [entryId],
    );
    expect(rows[0]!.status).toBe("ofertada");
    expect(Number(rows[0]!.offer_amount)).toBe(totalOriginal);
  });

  it("housekeeping NO puede inscribir a la lista de espera (403); frontdesk/reservations/gm/owner sí (201)", async () => {
    const checkIn = seededDates[7]!;
    const checkOut = nightAfter(checkIn, 1);
    const guestId = await crearHuesped("Contacto sin permiso de quien inscribe");

    const rechazo = await fixture.app.request(`/hoteles/${hotelId}/lista-espera`, {
      method: "POST",
      headers: { authorization: `Bearer ${hkToken}`, "content-type": "application/json" },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(rechazo.status).toBe(403);

    const permitido = await unirseALista(guestId, checkIn, checkOut);
    expect(permitido.status).toBe(201);
  });
});
