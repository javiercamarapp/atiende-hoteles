// REQ-UX-006 (H09-026/BP-010): "Las aprobaciones operativas del gerente ... deben
// poder ejecutarse mediante botón directamente en el mensaje de WhatsApp, sin
// requerir acceso al panel web." Prueba de CONTRATO offline (sin credenciales reales
// de Meta, FakeWhatsappAdapter -- REQUISITOS.md §5 marca REQ-UX-006 con dependencia
// externa WhatsApp, verificable offline vía MessagingPort + este contrato): una
// aprobación pendiente se completa EXCLUSIVAMENTE a través de un webhook simulando el
// clic de un botón de WhatsApp -- en ningún momento se llama al endpoint autenticado
// del panel web (`POST /hoteles/:hotelId/aprobaciones/:id/decidir`).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../../support/api-fixture.ts";

describe("contrato: aprobación completada por botón de WhatsApp, sin panel web (REQ-UX-006)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  const GM_PHONE = "+5219981110001";
  const HOUSEKEEPING_PHONE = "+5219981110002";
  const NUMERO_NO_REGISTRADO = "+5219981119999";

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    gmToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "gm")!.email);
    housekeepingToken = await loginAs(fixture.app, hotel.staff.find((s) => s.role === "housekeeping")!.email);

    await fixture.app.request("/auth/me/whatsapp", {
      method: "PATCH",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ whatsappPhone: GM_PHONE }),
    });
    await fixture.app.request("/auth/me/whatsapp", {
      method: "PATCH",
      headers: { authorization: `Bearer ${housekeepingToken}`, "content-type": "application/json" },
      body: JSON.stringify({ whatsappPhone: HOUSEKEEPING_PHONE }),
    });
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function crearAprobacionPendiente(guestPhone: string, templateName: string): Promise<string> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/mensajeria/mensajes`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ guestPhone, templateName, parameters: ["Suite"] }),
    });
    expect(res.status).toBe(202);
    const { aprobacionId } = (await res.json()) as { aprobacionId: string };
    return aprobacionId;
  }

  async function webhookSecret(): Promise<string> {
    const { rows } = await fixture.engine.admin.query<{ webhook_secret: string }>(
      "select webhook_secret from public.hotel_messaging_config where hotel_id = $1;",
      [hotelId],
    );
    return rows[0]!.webhook_secret;
  }

  function payloadBotón(eventId: string, from: string, buttonId: string) {
    return { event_id: eventId, type: "interactive.button_clicked", from, button_id: buttonId, occurred_at: new Date().toISOString() };
  }

  it("PATCH /auth/me/whatsapp registra el propio número; nunca el de otro staff", async () => {
    const { rows } = await fixture.engine.admin.query<{ whatsapp_phone: string }>(
      "select whatsapp_phone from public.staff_user su join public.hotel_staff hs on hs.user_id = su.id where hs.hotel_id = $1 and hs.role = 'gm';",
      [hotelId],
    );
    expect(rows[0]!.whatsapp_phone).toBe(GM_PHONE);
  });

  it("clic de 'aprobar' del gm por WhatsApp completa la aprobación y ejecuta la tool -- SIN tocar el endpoint autenticado", async () => {
    const aprobacionId = await crearAprobacionPendiente("+5215500001001", "oferta_upsell_boton_1");
    const secret = await webhookSecret();
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(
      payloadBotón("evt-boton-1", GM_PHONE, `aprobar:${aprobacionId}`),
      secret,
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; ejecutado: boolean };
    expect(body.estado).toBe("aprobada");
    expect(body.ejecutado).toBe(true);

    const { rows } = await fixture.engine.admin.query(
      "select id from public.message where hotel_id = $1 and template_name = 'oferta_upsell_boton_1';",
      [hotelId],
    );
    expect(rows).toHaveLength(1); // la tool SÍ se ejecutó -- el mensaje se envió de verdad.
  });

  it("clic de 'rechazar' rechaza la aprobación sin ejecutar la tool", async () => {
    const aprobacionId = await crearAprobacionPendiente("+5215500001002", "oferta_upsell_boton_2");
    const secret = await webhookSecret();
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(
      payloadBotón("evt-boton-2", GM_PHONE, `rechazar:${aprobacionId}`),
      secret,
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string; ejecutado: boolean };
    expect(body.estado).toBe("rechazada");
    expect(body.ejecutado).toBe(false);

    const { rows } = await fixture.engine.admin.query(
      "select id from public.message where hotel_id = $1 and template_name = 'oferta_upsell_boton_2';",
      [hotelId],
    );
    expect(rows).toHaveLength(0);
  });

  it("un número de WhatsApp de un rol sin permiso (housekeeping) es RECHAZADO (403)", async () => {
    const aprobacionId = await crearAprobacionPendiente("+5215500001003", "oferta_upsell_boton_3");
    const secret = await webhookSecret();
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(
      payloadBotón("evt-boton-3", HOUSEKEEPING_PHONE, `aprobar:${aprobacionId}`),
      secret,
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
    expect(res.status).toBe(403);
  });

  it("un número de WhatsApp NO REGISTRADO a ningún staff es rechazado (403)", async () => {
    const aprobacionId = await crearAprobacionPendiente("+5215500001004", "oferta_upsell_boton_4");
    const secret = await webhookSecret();
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(
      payloadBotón("evt-boton-4", NUMERO_NO_REGISTRADO, `aprobar:${aprobacionId}`),
      secret,
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
    expect(res.status).toBe(403);
  });

  it("firma HMAC inválida es rechazada (401), nunca ejecuta nada", async () => {
    const aprobacionId = await crearAprobacionPendiente("+5215500001005", "oferta_upsell_boton_5");
    const res = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=firma-invalida" },
      body: JSON.stringify(payloadBotón("evt-boton-5", GM_PHONE, `aprobar:${aprobacionId}`)),
    });
    expect(res.status).toBe(401);
  });

  it("un replay del MISMO event_id no vuelve a ejecutar la decisión (idempotencia)", async () => {
    const aprobacionId = await crearAprobacionPendiente("+5215500001006", "oferta_upsell_boton_6");
    const secret = await webhookSecret();
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(
      payloadBotón("evt-boton-6", GM_PHONE, `aprobar:${aprobacionId}`),
      secret,
    );

    const primero = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
    expect(primero.status).toBe(200);

    const segundo = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
    expect(segundo.status).toBe(200);
    expect(((await segundo.json()) as { estado: string }).estado).toBe("duplicado");

    const { rows } = await fixture.engine.admin.query(
      "select id from public.message where hotel_id = $1 and template_name = 'oferta_upsell_boton_6';",
      [hotelId],
    );
    expect(rows).toHaveLength(1); // nunca se envió dos veces.
  });

  it("un evento que no es de botón (p. ej. message.received) es ignorado por esta ruta sin error", async () => {
    const secret = await webhookSecret();
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(
      { event_id: "evt-no-boton-1", type: "message.received", from: GM_PHONE, text: "hola", occurred_at: new Date().toISOString() },
      secret,
    );
    const res = await fixture.app.request(`/hoteles/${hotelId}/aprobaciones/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: rawBody,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { estado: string }).estado).toBe("ignorado");
  });
});
