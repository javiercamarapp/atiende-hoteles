// Prueba de CONTRATO real de `MetaWhatsappAdapter` (H15-012) contra un simulador HTTP
// local del contrato documentado de WhatsApp Cloud API
// (tests/support/whatsappCloudApiSimulator.ts) -- nunca contra graph.facebook.com real
// (ver marca [NO VERIFICADO CONTRA META REAL] en meta-whatsapp-adapter.ts). Verifica: (1)
// que `sendTemplateMessage`/`sendTextMessage`/`sendInteractiveButtonsMessage` SÍ hacen un
// POST HTTP real con el body exacto que Graph API documenta, cosa que la versión anterior
// de este adaptador nunca hacía (los 3 métodos lanzaban `PortUnavailableError`
// incondicionalmente, incluso con credenciales presentes); (2) que la verificación de
// webhook normaliza la forma REAL de Meta (no la forma simplificada del Fake); y (3) el
// caso adversarial obligatorio: firma ausente/inválida/con secreto no configurado SIEMPRE
// se rechaza, nunca se acepta en silencio.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MetaWhatsappAdapter,
  buildMetaButtonReplyWebhookPayload,
  buildMetaStatusWebhookPayload,
  buildMetaTextMessageWebhookPayload,
  signMetaWebhookFixture,
} from "@atiende-hoteles/mcp-whatsapp";
import { PortUnavailableError, WebhookReplayError, WebhookSignatureError } from "@atiende-hoteles/mcp-shared";
import { startWhatsappCloudApiSimulator, type WhatsappCloudApiSimulator } from "../../../support/whatsappCloudApiSimulator.ts";

const APP_SECRET = "test-meta-app-secret-real-contrato";

describe("MetaWhatsappAdapter -- contrato real contra el simulador de WhatsApp Cloud API", () => {
  let sim: WhatsappCloudApiSimulator;
  const originalEnv = {
    token: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    secret: process.env.WHATSAPP_APP_SECRET,
    baseUrlOverride: process.env.WHATSAPP_GRAPH_BASE_URL_OVERRIDE,
  };

  beforeAll(async () => {
    sim = await startWhatsappCloudApiSimulator();
    process.env.WHATSAPP_ACCESS_TOKEN = sim.accessToken;
    process.env.WHATSAPP_PHONE_NUMBER_ID = sim.phoneNumberId;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_GRAPH_BASE_URL_OVERRIDE = sim.baseUrl;
  });

  afterAll(async () => {
    await sim.close();
    process.env.WHATSAPP_ACCESS_TOKEN = originalEnv.token;
    process.env.WHATSAPP_PHONE_NUMBER_ID = originalEnv.phoneId;
    process.env.WHATSAPP_APP_SECRET = originalEnv.secret;
    process.env.WHATSAPP_GRAPH_BASE_URL_OVERRIDE = originalEnv.baseUrlOverride;
  });

  afterEach(() => {
    sim.sentMessages.length = 0;
  });

  it("status() reporta available:true, simulated:false con las 3 credenciales presentes", () => {
    const adapter = new MetaWhatsappAdapter();
    expect(adapter.status()).toEqual({ provider: "meta-whatsapp", available: true, simulated: false });
  });

  it("sendTemplateMessage hace un POST real con el body exacto documentado por Graph API", async () => {
    const adapter = new MetaWhatsappAdapter();
    const before = sim.sentMessages.length;
    const sent = await adapter.sendTemplateMessage({
      to: "+5219981234567",
      templateName: "confirmacion_reserva",
      languageCode: "es_MX",
      parameters: ["Renata", "Suite Jr."],
      clientMessageId: "real-1",
    });
    expect(sim.sentMessages).toHaveLength(before + 1);
    expect(sim.sentMessages.at(-1)).toEqual({
      messaging_product: "whatsapp",
      to: "+5219981234567",
      type: "template",
      template: {
        name: "confirmacion_reserva",
        language: { code: "es_MX" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Renata" }, { type: "text", text: "Suite Jr." }] }],
      },
    });
    expect(sent.status).toBe("enviado");
    expect(sent.externalMessageId).toMatch(/^wamid\.SIMULADO\d+$/);
  });

  it("sendTemplateMessage sin parámetros omite `components` (Meta no lo acepta vacío)", async () => {
    const adapter = new MetaWhatsappAdapter();
    await adapter.sendTemplateMessage({
      to: "+5219981234567",
      templateName: "checkin_confirmado",
      languageCode: "es_MX",
      parameters: [],
      clientMessageId: "real-2",
    });
    const body = sim.sentMessages.at(-1) as { template: Record<string, unknown> };
    expect(body.template).not.toHaveProperty("components");
  });

  it("sendTextMessage hace un POST real de tipo texto", async () => {
    const adapter = new MetaWhatsappAdapter();
    const sent = await adapter.sendTextMessage({ to: "+5219981234567", body: "Su habitación está lista", clientMessageId: "real-3" });
    expect(sim.sentMessages.at(-1)).toEqual({
      messaging_product: "whatsapp",
      to: "+5219981234567",
      type: "text",
      text: { body: "Su habitación está lista", preview_url: false },
    });
    expect(sent.status).toBe("enviado");
  });

  it("sendInteractiveButtonsMessage hace un POST real con hasta 3 reply buttons (REQ-UX-006)", async () => {
    const adapter = new MetaWhatsappAdapter();
    await adapter.sendInteractiveButtonsMessage({
      to: "+5219981234567",
      body: "¿Aprueba el upsell de Suite?",
      buttons: [
        { id: "aprobar:abc", title: "Aprobar" },
        { id: "rechazar:abc", title: "Rechazar" },
      ],
      clientMessageId: "real-4",
    });
    expect(sim.sentMessages.at(-1)).toEqual({
      messaging_product: "whatsapp",
      to: "+5219981234567",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "¿Aprueba el upsell de Suite?" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "aprobar:abc", title: "Aprobar" } },
            { type: "reply", reply: { id: "rechazar:abc", title: "Rechazar" } },
          ],
        },
      },
    });
  });

  it("reenviar con el mismo clientMessageId NO vuelve a llamar a Graph API (idempotencia real)", async () => {
    const adapter = new MetaWhatsappAdapter();
    const input = { to: "+5219981234567", body: "hola", clientMessageId: "real-idempotente-1" };
    const before = sim.sentMessages.length;
    const first = await adapter.sendTextMessage(input);
    const second = await adapter.sendTextMessage(input);
    expect(sim.sentMessages).toHaveLength(before + 1); // Graph API solo se llamó UNA vez.
    expect(second.externalMessageId).toBe(first.externalMessageId);
  });

  it("un 429 real con Retry-After se reintenta con backoff y termina en éxito", async () => {
    const adapter = new MetaWhatsappAdapter();
    sim.failNextWithRateLimit(0); // 0s -- el test no necesita esperar de verdad.
    const before = sim.sentMessages.length;
    const sent = await adapter.sendTextMessage({ to: "+5219981234567", body: "reintento", clientMessageId: "real-retry-1" });
    expect(sent.status).toBe("enviado");
    expect(sim.sentMessages).toHaveLength(before + 1); // el intento fallido (429) no cuenta como mensaje enviado.
  });

  it("un token de acceso incorrecto es rechazado por el simulador (401), el adaptador propaga el error", async () => {
    const original = process.env.WHATSAPP_ACCESS_TOKEN;
    process.env.WHATSAPP_ACCESS_TOKEN = "token-incorrecto";
    const adapter = new MetaWhatsappAdapter();
    await expect(
      adapter.sendTextMessage({ to: "+5219981234567", body: "x", clientMessageId: "real-401" }),
    ).rejects.toThrow(/HTTP 401/);
    process.env.WHATSAPP_ACCESS_TOKEN = original;
  });

  describe("verifyAndNormalizeWebhook -- forma REAL del payload de WhatsApp Cloud API", () => {
    it("normaliza un mensaje de texto entrante, incluida la conversión de 'from' a E.164", async () => {
      const adapter = new MetaWhatsappAdapter();
      const payload = buildMetaTextMessageWebhookPayload({
        from: "5219981234567", // Meta manda SIN "+"
        text: "¿A qué hora es el check-in?",
        messageId: "wamid.EVT-REAL-1",
      });
      const { rawBody, signature } = signMetaWebhookFixture(payload, APP_SECRET);
      const event = await adapter.verifyAndNormalizeWebhook(rawBody, signature);
      expect(event).toMatchObject({
        eventId: "wamid.EVT-REAL-1",
        type: "message.received",
        from: "+5219981234567",
        textBody: "¿A qué hora es el check-in?",
      });
    });

    it("normaliza un clic de Interactive Reply Button (REQ-UX-006)", async () => {
      const adapter = new MetaWhatsappAdapter();
      const payload = buildMetaButtonReplyWebhookPayload({
        from: "5219981110001",
        buttonId: "aprobar:aaaa-bbbb",
        messageId: "wamid.EVT-REAL-2",
      });
      const { rawBody, signature } = signMetaWebhookFixture(payload, APP_SECRET);
      const event = await adapter.verifyAndNormalizeWebhook(rawBody, signature);
      expect(event).toMatchObject({ type: "interactive.button_clicked", from: "+5219981110001", buttonId: "aprobar:aaaa-bbbb" });
    });

    it("normaliza una actualización de estado de entrega, mapeando sent/delivered/read/failed", async () => {
      const adapter = new MetaWhatsappAdapter();
      const payload = buildMetaStatusWebhookPayload({
        messageId: "wamid.EVT-REAL-3",
        status: "delivered",
        recipientId: "5219981234567",
      });
      const { rawBody, signature } = signMetaWebhookFixture(payload, APP_SECRET);
      const event = await adapter.verifyAndNormalizeWebhook(rawBody, signature);
      expect(event).toMatchObject({ type: "message.status_updated", externalMessageId: "wamid.EVT-REAL-3", status: "entregado" });
    });

    it("dos actualizaciones de estado del MISMO wamid (sent, luego delivered) NO se tratan como replay una de otra", async () => {
      const adapter = new MetaWhatsappAdapter();
      const sent = signMetaWebhookFixture(
        buildMetaStatusWebhookPayload({ messageId: "wamid.EVT-REAL-4", status: "sent", recipientId: "5219981234567" }),
        APP_SECRET,
      );
      const delivered = signMetaWebhookFixture(
        buildMetaStatusWebhookPayload({ messageId: "wamid.EVT-REAL-4", status: "delivered", recipientId: "5219981234567" }),
        APP_SECRET,
      );
      await expect(adapter.verifyAndNormalizeWebhook(sent.rawBody, sent.signature)).resolves.toMatchObject({ status: "enviado" });
      // Antes del fix, `eventId` era `entry[0].id` (constante por WABA) -- este segundo
      // evento real habría sido rechazado como replay del primero.
      await expect(adapter.verifyAndNormalizeWebhook(delivered.rawBody, delivered.signature)).resolves.toMatchObject({ status: "entregado" });
    });

    it("un replay EXACTO del mismo evento sí se rechaza", async () => {
      const adapter = new MetaWhatsappAdapter();
      const { rawBody, signature } = signMetaWebhookFixture(
        buildMetaTextMessageWebhookPayload({ from: "5219981234567", text: "hola", messageId: "wamid.EVT-REAL-5" }),
        APP_SECRET,
      );
      await adapter.verifyAndNormalizeWebhook(rawBody, signature);
      await expect(adapter.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toBeInstanceOf(WebhookReplayError);
    });
  });

  describe("verifyAndNormalizeWebhook -- adversarial: fail-closed SIEMPRE", () => {
    it("firma ausente se rechaza", async () => {
      const adapter = new MetaWhatsappAdapter();
      const { rawBody } = signMetaWebhookFixture(buildMetaTextMessageWebhookPayload({ from: "521998", text: "x" }), APP_SECRET);
      await expect(adapter.verifyAndNormalizeWebhook(rawBody, undefined)).rejects.toBeInstanceOf(WebhookSignatureError);
    });

    it("firma con formato válido pero valor incorrecto se rechaza", async () => {
      const adapter = new MetaWhatsappAdapter();
      const { rawBody } = signMetaWebhookFixture(buildMetaTextMessageWebhookPayload({ from: "521998", text: "x" }), APP_SECRET);
      await expect(adapter.verifyAndNormalizeWebhook(rawBody, "sha256=" + "0".repeat(64))).rejects.toBeInstanceOf(WebhookSignatureError);
    });

    it("cuerpo alterado DESPUÉS de firmarlo (tampering) se rechaza -- la firma ya no coincide", async () => {
      const adapter = new MetaWhatsappAdapter();
      const { rawBody, signature } = signMetaWebhookFixture(buildMetaTextMessageWebhookPayload({ from: "521998", text: "monto original" }), APP_SECRET);
      const tampered = rawBody.replace("monto original", "monto alterado");
      await expect(adapter.verifyAndNormalizeWebhook(tampered, signature)).rejects.toBeInstanceOf(WebhookSignatureError);
    });

    it("firmado con un secreto DISTINTO al configurado se rechaza", async () => {
      const adapter = new MetaWhatsappAdapter();
      const { rawBody, signature } = signMetaWebhookFixture(buildMetaTextMessageWebhookPayload({ from: "521998", text: "x" }), "secreto-equivocado");
      await expect(adapter.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toBeInstanceOf(WebhookSignatureError);
    });

    it("sin WHATSAPP_APP_SECRET configurado, se rechaza SIEMPRE (nunca cae a un secreto por defecto)", async () => {
      const original = process.env.WHATSAPP_APP_SECRET;
      delete process.env.WHATSAPP_APP_SECRET;
      const adapter = new MetaWhatsappAdapter();
      const { rawBody, signature } = signMetaWebhookFixture(buildMetaTextMessageWebhookPayload({ from: "521998", text: "x" }), APP_SECRET);
      await expect(adapter.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toBeInstanceOf(PortUnavailableError);
      process.env.WHATSAPP_APP_SECRET = original;
    });

    it("una firma válida pero un cuerpo que no es JSON se rechaza (fail-closed, nunca 500 silencioso)", async () => {
      const adapter = new MetaWhatsappAdapter();
      const rawBody = "esto no es json";
      const { signHmac } = await import("@atiende-hoteles/mcp-shared");
      const signature = signHmac(rawBody, APP_SECRET);
      await expect(adapter.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toBeInstanceOf(WebhookSignatureError);
    });
  });
});
