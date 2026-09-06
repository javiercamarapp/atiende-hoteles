// Prueba de contrato de MessagingPort (REQ-INT-003). Ver docs/ACEPTACION.md: "envío N+1
// sobre el límite del tier -> bloqueado/encolado" y firma HMAC de webhook.
import { describe, expect, it } from "vitest";
import { FakeWhatsappAdapter, MetaWhatsappAdapter, mapMetaStatusToDomain } from "@atiende-hoteles/mcp-whatsapp";
import { PortUnavailableError, WebhookSignatureError, WebhookReplayError } from "@atiende-hoteles/mcp-shared";

const realAdapter = new MetaWhatsappAdapter();
const realCredentialsAvailable = realAdapter.status().available;

describe("mapMetaStatusToDomain", () => {
  it("mapea 1:1 los 4 estados nativos de Meta al vocabulario de dominio", () => {
    expect(mapMetaStatusToDomain("sent")).toBe("enviado");
    expect(mapMetaStatusToDomain("delivered")).toBe("entregado");
    expect(mapMetaStatusToDomain("read")).toBe("leido");
    expect(mapMetaStatusToDomain("failed")).toBe("fallido");
  });
});

describe("FakeWhatsappAdapter -- envío e idempotencia", () => {
  it("sendTemplateMessage retorna un mensaje con estado 'enviado'", async () => {
    const fake = new FakeWhatsappAdapter();
    const message = await fake.sendTemplateMessage({
      to: "+5219981234567",
      templateName: "confirmacion_reserva",
      languageCode: "es_MX",
      parameters: ["Renata"],
      clientMessageId: "client-msg-1",
    });
    expect(message.status).toBe("enviado");
  });

  it("reenviar con el mismo clientMessageId no duplica el envío (idempotencia)", async () => {
    const fake = new FakeWhatsappAdapter();
    const input = {
      to: "+5219981234567",
      body: "Su habitación está lista",
      clientMessageId: "client-msg-2",
    };
    const first = await fake.sendTextMessage(input);
    const second = await fake.sendTextMessage(input);
    expect(second.externalMessageId).toBe(first.externalMessageId);
    expect(fake.currentWindowCount()).toBe(1);
  });
});

describe("FakeWhatsappAdapter -- límite de mensajería por tier (ventana 24h)", () => {
  it("un envío N+1 sobre el límite del tier se bloquea con MessagingTierLimitError", async () => {
    const now = 0;
    // limitOverride:2 para no tener que enviar 1000 mensajes reales del tier_1k.
    const fake = new FakeWhatsappAdapter("tier_1k", () => now, undefined, 2);
    await fake.sendTextMessage({ to: "+52199", body: "1", clientMessageId: "m1" });
    await fake.sendTextMessage({ to: "+52199", body: "2", clientMessageId: "m2" });
    await expect(fake.sendTextMessage({ to: "+52199", body: "3", clientMessageId: "m3" })).rejects.toMatchObject({
      code: "messaging_tier_limit_exceeded",
    });
  });

  it("tras 24h la ventana móvil libera cupo de nuevo", async () => {
    let now = 0;
    const fake = new FakeWhatsappAdapter("tier_1k", () => now, undefined, 1);
    await fake.sendTextMessage({ to: "+52199", body: "1", clientMessageId: "m1" });
    await expect(fake.sendTextMessage({ to: "+52199", body: "2", clientMessageId: "m2" })).rejects.toBeTruthy();
    now += 24 * 60 * 60 * 1000 + 1;
    const afterWindow = await fake.sendTextMessage({ to: "+52199", body: "3", clientMessageId: "m3" });
    expect(afterWindow.status).toBe("enviado");
  });
});

describe("MetaWhatsappAdapter (real) sin credenciales -- declaración honesta", () => {
  it("status() reporta unavailable con la razón exacta cuando faltan credenciales", () => {
    if (realCredentialsAvailable) return;
    const status = realAdapter.status();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/PENDIENTE DE CREDENCIALES/);
  });

  it("sendTextMessage lanza PortUnavailableError en vez de fingir un envío", async () => {
    if (realCredentialsAvailable) return;
    await expect(
      realAdapter.sendTextMessage({ to: "+5219980000000", body: "hola", clientMessageId: "x" }),
    ).rejects.toBeInstanceOf(PortUnavailableError);
  });
});

describe("webhook de WhatsApp -- firma HMAC + replay", () => {
  it("firma válida se acepta y normaliza el evento entrante", async () => {
    const fake = new FakeWhatsappAdapter();
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture({
      event_id: "evt-wa-1",
      type: "message.received",
      from: "+5219981234567",
      text: "¿A qué hora es el check-in?",
      occurred_at: new Date().toISOString(),
    });
    const event = await fake.verifyAndNormalizeWebhook(rawBody, signature);
    expect(event.eventId).toBe("evt-wa-1");
    expect(event.textBody).toContain("check-in");
  });

  it("firma inválida se rechaza", async () => {
    const fake = new FakeWhatsappAdapter();
    const { rawBody } = FakeWhatsappAdapter.signWebhookFixture({
      event_id: "evt-wa-2",
      type: "message.received",
      occurred_at: new Date().toISOString(),
    });
    await expect(fake.verifyAndNormalizeWebhook(rawBody, "sha256=invalida")).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });

  it("un event_id repetido (replay) se rechaza en el segundo intento", async () => {
    const fake = new FakeWhatsappAdapter();
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture({
      event_id: "evt-wa-3",
      type: "message.status_updated",
      message_id: "WA-MSG-1",
      status: "delivered",
      occurred_at: new Date().toISOString(),
    });
    await fake.verifyAndNormalizeWebhook(rawBody, signature);
    await expect(fake.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toBeInstanceOf(WebhookReplayError);
  });
});
