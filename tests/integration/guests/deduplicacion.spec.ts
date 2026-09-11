// REQ-RES-019 (P2/F, embedded-postgres real): "El sistema debe deduplicar contactos
// con emails/teléfonos enmascarados de distintas reservas del mismo huésped en un solo
// perfil." Criterio de aceptación literal (docs/ACEPTACION.md): "Dos reservas del mismo
// huésped con emails/teléfonos enmascarados distintos de la misma OTA se deduplican en
// un único perfil (verificado: 2 reservas → 1 fila `guest`)."
//
// El canal 'booking_com'/'airbnb' de este archivo se escribe MANUALMENTE vía el cliente
// admin sobre la reserva ya creada por la API real -- mismo criterio exacto que
// tests/integration/reservas/atribucion-canal.spec.ts usa para dejar una reserva en un
// canal distinto de 'directo' de verdad en la base, sin simular una conectividad OTA
// propia que este repo no construye (REQ-RES-022).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("deduplicación de contactos de huésped (REQ-RES-019, embedded-postgres real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let dates: string[];

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    const { rows: seededDates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc limit 8;",
      [hotelId, roomTypeId],
    );
    dates = seededDates.map((r) => r.date);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function crearHuesped(body: Record<string, unknown>) {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { id: string; nombre: string; email: string | null; reutilizado: boolean };
    return { status: res.status, json };
  }

  async function crearReservaConCanal(guestId: string, checkIn: string, checkOut: string, canal: string) {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gmToken}`,
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(res.status).toBe(201);
    const { id: reservationId } = (await res.json()) as { id: string };
    // El endpoint real de creación de reservas SOLO produce channel='directo' (migración
    // 0014, REQ-RES-022) -- se reetiqueta manualmente para probar el reporte/dedup sobre
    // un canal de OTA real en la base, igual que atribucion-canal.spec.ts.
    await fixture.engine.admin.query("update public.reservation set channel = $1 where id = $2;", [canal, reservationId]);
    return reservationId;
  }

  it("dos reservas del mismo huésped con contacto enmascarado distinto de la MISMA OTA se deduplican en un único perfil (2 reservas → 1 fila guest)", async () => {
    // Reserva 1: llega el huésped "Laura Gómez Ibáñez" vía Booking.com con un contacto
    // proxy de Booking (cambia por reserva, por diseño de la OTA).
    const primera = await crearHuesped({
      nombre: "Laura Gómez Ibáñez",
      email: "abc123def@guest.booking.com",
      telefono: "+1 415 555 0100",
      canal: "booking_com",
    });
    expect(primera.status).toBe(201);
    expect(primera.json.reutilizado).toBe(false);
    const guestId1 = primera.json.id;
    await crearReservaConCanal(guestId1, dates[0]!, dates[1]!, "booking_com");

    // Reserva 2: LA MISMA persona vuelve a reservar por Booking.com -- el nombre que
    // reporta la OTA es el mismo, pero el email/teléfono proxy que Booking entrega es
    // OTRO (por diseño, nunca coincide con el de la reserva anterior).
    const segunda = await crearHuesped({
      nombre: "Laura Gómez Ibáñez",
      email: "zzz987xyz@guest.booking.com",
      telefono: "+1 415 555 9999",
      canal: "booking_com",
    });
    expect(segunda.status).toBe(200); // reutilizado, no una fila nueva (201 sería creación)
    expect(segunda.json.reutilizado).toBe(true);
    const guestId2 = segunda.json.id;

    // El criterio de aceptación es literal: 2 reservas -> 1 fila `guest`.
    expect(guestId2).toBe(guestId1);
    await crearReservaConCanal(guestId2, dates[2]!, dates[3]!, "booking_com");

    const { rows: guestRows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.guest where hotel_id = $1 and full_name = $2;",
      [hotelId, "Laura Gómez Ibáñez"],
    );
    expect(guestRows[0]!.count).toBe("1");

    const { rows: reservaRows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.reservation where guest_id = $1;",
      [guestId1],
    );
    expect(reservaRows[0]!.count).toBe("2");

    // El contacto guardado sigue siendo el de la PRIMERA reserva -- nunca se sobreescribe
    // con el proxy (distinto) de la segunda; mismo criterio fail-closed que REQ-HUE-023.
    const { rows: contactoRows } = await fixture.engine.admin.query<{ email: string | null }>(
      "select email from public.guest where id = $1;",
      [guestId1],
    );
    expect(contactoRows[0]!.email).toBe("abc123def@guest.booking.com");
  });

  it("caso negativo: dos huéspedes DISTINTOS de la misma OTA (nombre distinto) NO se fusionan (2 reservas → 2 filas guest)", async () => {
    const a = await crearHuesped({ nombre: "Roberto Sánchez Vega", email: "aaa111@guest.booking.com", canal: "booking_com" });
    expect(a.status).toBe(201);
    await crearReservaConCanal(a.json.id, dates[4]!, dates[5]!, "booking_com");

    const b = await crearHuesped({ nombre: "Fernanda Ruiz Ortega", email: "bbb222@guest.booking.com", canal: "booking_com" });
    expect(b.status).toBe(201);
    expect(b.json.reutilizado).toBe(false);
    expect(b.json.id).not.toBe(a.json.id);
    await crearReservaConCanal(b.json.id, dates[6]!, dates[7]!, "booking_com");
  });

  it("caso negativo: mismo nombre en OTAs DISTINTAS (Booking vs Airbnb) NO se fusiona (el canal también debe coincidir)", async () => {
    const a = await crearHuesped({ nombre: "Carlos Medina Rojo", email: "ccc333@guest.booking.com", canal: "booking_com" });
    expect(a.status).toBe(201);
    await crearReservaConCanal(a.json.id, dates[0]!, dates[1]!, "booking_com");

    const b = await crearHuesped({ nombre: "Carlos Medina Rojo", email: "ddd444@airbnb.com", canal: "airbnb" });
    expect(b.status).toBe(201);
    expect(b.json.reutilizado).toBe(false);
    expect(b.json.id).not.toBe(a.json.id);
  });

  it("caso negativo: el canal 'directo' NUNCA deduplica por nombre, aunque coincida exacto con un huésped OTA existente", async () => {
    const ota = await crearHuesped({ nombre: "Directo Nunca Fusiona", email: "eee555@guest.booking.com", canal: "booking_com" });
    expect(ota.status).toBe(201);
    await crearReservaConCanal(ota.json.id, dates[0]!, dates[1]!, "booking_com");

    // Sin `canal` en el body -- mismo comportamiento exacto que el endpoint tenía antes
    // de REQ-RES-019 (compatibilidad hacia atrás: creación manual de staff nunca dedupe).
    const directo = await crearHuesped({ nombre: "Directo Nunca Fusiona", email: "directo@correo-real.com" });
    expect(directo.status).toBe(201);
    expect(directo.json.reutilizado).toBe(false);
    expect(directo.json.id).not.toBe(ota.json.id);
  });

  it("caso negativo: un huésped SIN ninguna reserva todavía nunca es candidato a fusión (evita fusionar por un nombre de alta manual sin OTA real detrás)", async () => {
    // Se crea con canal OTA pero SIN reserva asociada todavía -- no debe ofrecerse como
    // candidato de fusión a una siguiente alta con el mismo nombre+canal.
    const sinReserva = await crearHuesped({ nombre: "Sin Reserva Todavia", email: "fff666@guest.booking.com", canal: "booking_com" });
    expect(sinReserva.status).toBe(201);
    expect(sinReserva.json.reutilizado).toBe(false);

    const segundo = await crearHuesped({ nombre: "Sin Reserva Todavia", email: "ggg777@guest.booking.com", canal: "booking_com" });
    expect(segundo.status).toBe(201);
    expect(segundo.json.reutilizado).toBe(false);
    expect(segundo.json.id).not.toBe(sinReserva.json.id);
  });
});
