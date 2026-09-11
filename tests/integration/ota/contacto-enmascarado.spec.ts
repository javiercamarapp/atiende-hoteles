// REQ-RES-018: "El agente de reservas debe capturar el teléfono/email real del huésped
// cuando la OTA lo enmascara, mediante un link de check-in enviado por la mensajería
// propia de esa OTA con consentimiento explícito, sin contactar antes por un canal ajeno
// a la plataforma de la OTA."
//
// Criterio de aceptación LITERAL (docs/ACEPTACION.md): "Con teléfono/email enmascarado
// por OTA, el link de check-in se envía por la mensajería propia de esa OTA con
// consentimiento explícito registrado; verificado que ningún contacto sale por un canal
// ajeno a la OTA antes del consentimiento." Ejercitado contra la API real (Hono +
// embedded-postgres, ADR-003) -- nunca llamando las funciones de dominio directo -- y
// contra el gate real de `packages/agent-core` (`isGuestContactMaskedByOta`, mismo
// mecanismo de defensa en profundidad que `isMarketingSendBlocked`).
//
// Cubre:
//  (a) POSITIVO: reserva marcada enmascarada-por-OTA -> `checkin-link-ota` la emite y
//      registra el envío en `message` con `channel='ota'` (nunca 'whatsapp'), simulado.
//  (b) ADVERSARIAL (el corazón del criterio): mientras el contacto sigue enmascarado,
//      `POST .../mensajeria/mensajes` (WhatsApp directo) al MISMO teléfono se rechaza
//      (409) SIN crear ninguna fila en `message` de canal 'whatsapp'.
//  (c) DESENMASCARADO: el huésped completa el check-in online con su contacto real ->
//      `reservation.guest_contact_masked_by_ota` pasa a `false`, `guest.phone`/`email`
//      quedan con el valor real, y queda un `consent` con `consent_kind =
//      'contacto_real_ota'` (explícito, distinto del `tratamiento_datos` genérico).
//  (d) POST-CONSENTIMIENTO: el MISMO teléfono/reserva ya NO está bloqueado para WhatsApp
//      directo (el gate de OTA deja de aplicar; puede seguir pendiente de aprobación
//      humana por otras reglas, pero nunca por `contacto_enmascarado_por_ota`).
//  (e) NEGATIVO: `checkin-link-ota` sobre una reserva que NO está marcada enmascarada se
//      rechaza (409) -- nunca emite un enlace por error para una reserva directa.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPassportMrz } from "@atiende-hoteles/domain-hotel";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("adversarial+integración: REQ-RES-018 -- contacto de huésped enmascarado por OTA", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;

  const TELEFONO_ENMASCARADO = "+5215500001111";
  const TELEFONO_REAL = "+5215500002222";
  const TEMPLATE_TRANSACCIONAL = "confirmacion_reserva";

  const mrz = buildPassportMrz({
    countryCode: "MEX",
    surname: "TORRES LIMA",
    givenNames: "ANA",
    documentNumber: "G1122334",
    nationality: "MEX",
    birthDateYyMmDd: "900101",
    sex: "F",
    expiryDateYyMmDd: "330101",
  });

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    roomTypeId = hotel.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };
  }

  async function seededDate(offset: number): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    return rows[offset]!.date;
  }
  function nightAfter(d: string): string {
    const dt = new Date(`${d}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }

  async function crearHuesped(telefono: string): Promise<string> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ nombre: "Ana Torres Lima", telefono }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function crearReserva(offset: number, guestId: string): Promise<string> {
    const checkIn = await seededDate(offset);
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: checkIn, checkOutDate: nightAfter(checkIn) }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function contarMensajes(channel: string): Promise<number> {
    const { rows } = await fixture.engine.admin.query<{ n: string }>(
      "select count(*)::text as n from public.message where hotel_id = $1 and channel = $2;",
      [hotelId, channel],
    );
    return Number(rows[0]!.n);
  }

  async function enviarWhatsapp(telefono: string): Promise<Response> {
    return fixture.app.request(`/hoteles/${hotelId}/mensajeria/mensajes`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ guestPhone: telefono, templateName: TEMPLATE_TRANSACCIONAL, parameters: [] }),
    });
  }

  let guestId: string;
  let reservationId: string;

  it("(e) NEGATIVO: checkin-link-ota rechaza una reserva que aún no está marcada enmascarada", async () => {
    guestId = await crearHuesped(TELEFONO_ENMASCARADO);
    reservationId = await crearReserva(0, guestId);

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/checkin-link-ota`, {
      method: "POST",
      headers: auth(),
    });
    expect(res.status).toBe(409);
  });

  it("marca la reserva como contacto enmascarado por una OTA (Booking.com)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/contacto-ota`, {
      method: "PATCH",
      headers: auth(),
      body: JSON.stringify({ enmascaradoPorOta: true, canalOta: "booking_com" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canal: string; enmascaradoPorOta: boolean };
    expect(body.canal).toBe("booking_com");
    expect(body.enmascaradoPorOta).toBe(true);
  });

  it("(b) ADVERSARIAL: WhatsApp directo al teléfono enmascarado se rechaza (409), 0 mensajes 'whatsapp'", async () => {
    const antes = await contarMensajes("whatsapp");
    const res = await enviarWhatsapp(TELEFONO_ENMASCARADO);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; message?: string };
    const texto = JSON.stringify(body);
    expect(texto).toMatch(/enmascarado/i);
    const despues = await contarMensajes("whatsapp");
    expect(despues).toBe(antes);
  });

  let checkinToken: string;

  it("(a) POSITIVO: el enlace de check-in se envía por el canal propio de la OTA ('ota'), nunca 'whatsapp'", async () => {
    const antesOta = await contarMensajes("ota");
    const antesWhatsapp = await contarMensajes("whatsapp");

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/checkin-link-ota`, {
      method: "POST",
      headers: auth(),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; canalEnvio: string; simulado: boolean; ruta: string };
    expect(body.canalEnvio).toBe("ota");
    expect(body.simulado).toBe(true);
    checkinToken = body.token;

    expect(await contarMensajes("ota")).toBe(antesOta + 1);
    expect(await contarMensajes("whatsapp")).toBe(antesWhatsapp);
  });

  it("(c) DESENMASCARADO: completar el check-in online con el contacto real limpia el flag y registra consentimiento explícito", async () => {
    const res = await fixture.app.request(`/checkin-publico/${checkinToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nombreCompleto: "Ana Torres Lima",
        email: "ana.torres@example.com",
        telefono: TELEFONO_REAL,
        firmaDataUrl: "data:image/png;base64,AAAA",
        mrzLine1: mrz.line1,
        mrzLine2: mrz.line2,
        consentimientoAvisoPrivacidad: true,
      }),
    });
    expect(res.status).toBe(201);

    const { rows: resRows } = await fixture.engine.admin.query<{ guest_contact_masked_by_ota: boolean; guest_id: string }>(
      "select guest_contact_masked_by_ota, guest_id from public.reservation where id = $1;",
      [reservationId],
    );
    expect(resRows[0]!.guest_contact_masked_by_ota).toBe(false);

    const { rows: guestRows } = await fixture.engine.admin.query<{ phone: string; email: string }>(
      "select phone, email from public.guest where id = $1;",
      [resRows[0]!.guest_id],
    );
    expect(guestRows[0]!.phone).toBe(TELEFONO_REAL);
    expect(guestRows[0]!.email).toBe("ana.torres@example.com");

    const { rows: consentRows } = await fixture.engine.admin.query<{ granted: boolean }>(
      "select granted from public.consent where reservation_id = $1 and consent_kind = 'contacto_real_ota';",
      [reservationId],
    );
    expect(consentRows).toHaveLength(1);
    expect(consentRows[0]!.granted).toBe(true);
  });

  it("(d) POST-CONSENTIMIENTO: el teléfono real ya no está bloqueado por el gate de OTA", async () => {
    const res = await enviarWhatsapp(TELEFONO_REAL);
    // Nunca más el 409 específico de contacto enmascarado por OTA -- puede quedar
    // pendiente de aprobación humana (202) o enviarse directo (201) según config del
    // hotel, pero JAMÁS el rechazo de este REQ.
    expect(res.status).not.toBe(409);
    if (res.status === 409) {
      const body = (await res.json()) as { error?: string; message?: string };
      expect(JSON.stringify(body)).not.toMatch(/enmascarado/i);
    }
  });
});
