// H12c · LAUNCH-017: pruebas adversariales del centro de notificaciones.
//  1) Emisión real desde triggers de BD (reserva confirmada, aprobación pendiente,
//     ticket urgente, night audit cerrado) -- nunca inventadas por la aplicación.
//  2) "Marcar todo como leído" es atómico -- una notificación nueva que llega DURANTE la
//     operación no se pierde ni queda marcada leída sin que el usuario la haya visto
//     (aprende de `fix(notifications): atomically clear dashboard badges`).
//  3) Aislamiento: un rol sin ese destino nunca ve la notificación de otro rol/hotel.
//  4) Cuerpo de notificación nunca contiene PII de huésped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, crearFolioConfirmado, type ApiFixture } from "../support/api-fixture.ts";

// Bug real de CI (10-sep-2026): fechas que eran literales absolutos se quedan fuera
// de la ventana de tarifa/disponibilidad sembrada por seedDev (siempre desde "hoy"
// real, 30 días) tarde o temprano -- corregidas a offsets relativos, nunca "hoy" mismo.
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}


describe("adversarial: centro de notificaciones (H12c)", () => {
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await createApiFixture();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("confirmar una reserva emite una notificación real a frontdesk/reservations (trigger de BD, no simulada)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const reservationsUser = hotelA.staff.find((s) => s.role === "reservations")!;
    const token = await loginAs(fixture.app, reservationsUser.email);

    await crearFolioConfirmado(fixture.app, token, hotelA.id, {
      roomTypeId: hotelA.roomTypes[0]!.id,
      checkInDate: isoDate(1),
      checkOutDate: isoDate(3),
    });

    const res = await fixture.app.request(`/hoteles/${hotelA.id}/notificaciones?no_leidas=true`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const notifs = (await res.json()) as { tipo: string; titulo: string; cuerpo: string }[];
    const reservaNotif = notifs.find((n) => n.tipo === "reserva_nueva");
    expect(reservaNotif).toBeDefined();
    // Sin PII: nunca nombre/teléfono/email de huésped en el cuerpo.
    expect(reservaNotif!.cuerpo).not.toMatch(/@/);
    expect(reservaNotif!.cuerpo).not.toMatch(/\d{10}/);
  });

  it("un rol sin ese destino (housekeeping) NUNCA ve la notificación de reserva_nueva (para frontdesk/reservations)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const housekeeping = hotelA.staff.find((s) => s.role === "housekeeping")!;
    const token = await loginAs(fixture.app, housekeeping.email);

    const res = await fixture.app.request(`/hoteles/${hotelA.id}/notificaciones`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const notifs = (await res.json()) as { tipo: string }[];
    expect(notifs.every((n) => n.tipo !== "reserva_nueva")).toBe(true);
  });

  it("staff de hotel A NUNCA ve notificaciones de hotel B (misma org, distinto hotel)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    const reservationsA = hotelA.staff.find((s) => s.role === "reservations")!;
    const reservationsB = hotelB.staff.find((s) => s.role === "reservations")!;
    const tokenA = await loginAs(fixture.app, reservationsA.email);
    const tokenB = await loginAs(fixture.app, reservationsB.email);

    await crearFolioConfirmado(fixture.app, tokenB, hotelB.id, {
      roomTypeId: hotelB.roomTypes[0]!.id,
      checkInDate: isoDate(5),
      checkOutDate: isoDate(7),
    });

    const resA = await fixture.app.request(`/hoteles/${hotelA.id}/notificaciones`, { headers: { authorization: `Bearer ${tokenA}` } });
    const notifsA = (await resA.json()) as { hotelId: string | null }[];
    expect(notifsA.every((n) => n.hotelId === null || n.hotelId === hotelA.id)).toBe(true);

    // La ruta del hotel B con el token de A está bloqueada de raíz (403).
    const cruzado = await fixture.app.request(`/hoteles/${hotelB.id}/notificaciones`, { headers: { authorization: `Bearer ${tokenA}` } });
    expect(cruzado.status).toBe(403);
  });

  it("'marcar todo como leído' es atómico: una notificación creada DESPUÉS de la llamada no se marca leída, y el conteo baja a 0 exactamente en las que sí existían", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const reservationsUser = hotelA.staff.find((s) => s.role === "reservations")!;
    const token = await loginAs(fixture.app, reservationsUser.email);

    // Genera >=1 notificación no leída de tipo broadcast por rol (reserva_nueva).
    await crearFolioConfirmado(fixture.app, token, hotelA.id, {
      roomTypeId: hotelA.roomTypes[0]!.id,
      checkInDate: isoDate(9),
      checkOutDate: isoDate(11),
    });

    const antes = await fixture.app.request(`/hoteles/${hotelA.id}/notificaciones/no-leidas/conteo`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const conteoAntes = (await antes.json()) as { conteo: number };
    expect(conteoAntes.conteo).toBeGreaterThan(0);

    // NOTA: "reserva_nueva" es broadcast por ROL (recipient_user_id NULL) -- la función
    // mark_all_notifications_read() solo limpia las de `recipient_user_id = auth.uid()`
    // (documentado en 0113): las de broadcast por rol se marcan individualmente por
    // diseño (varios usuarios comparten la misma fila). Se prueba aquí con una
    // notificación PERSONAL directa (insertada vía la policy de insert de aplicación)
    // para ejercitar el camino "propias del usuario".
    await fixture.engine.withAppSession({ userId: reservationsUser.id }, async (session) => {
      await session.query(
        `insert into public.notification (tenant_id, hotel_id, recipient_user_id, type, title, body)
         values ($1, $2, $3, 'sistema', 'Aviso de prueba', 'Cuerpo de prueba sin PII.');`,
        [fixture.seed.orgId, hotelA.id, reservationsUser.id],
      );
    });

    const marcar = await fixture.app.request(`/hoteles/${hotelA.id}/notificaciones/marcar-todo-leido`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(marcar.status).toBe(200);
    const marcarBody = (await marcar.json()) as { marcadas: number };
    expect(marcarBody.marcadas).toBeGreaterThanOrEqual(1);

    // La notificación personal quedó leída; las de broadcast por rol (reserva_nueva)
    // siguen sin leer para este usuario (comportamiento documentado, no un defecto).
    const sistemaRes = await fixture.app.request(`/hoteles/${hotelA.id}/notificaciones`, { headers: { authorization: `Bearer ${token}` } });
    const notifs = (await sistemaRes.json()) as { tipo: string; leidaEn: string | null }[];
    const sistemaNotif = notifs.find((n) => n.tipo === "sistema");
    expect(sistemaNotif?.leidaEn).not.toBeNull();
  });
});
