// Hallazgo de auditoría corregido: `apps/api/src/lib/messaging.ts` tenía
// `sharedWhatsappAdapter` HARDCODEADO a `FakeWhatsappAdapter`, sin ninguna selección
// condicional por variable de entorno -- a diferencia del patrón ya usado para correo
// (`resolveEmailPort`). Esta prueba verifica la selección misma: con las 3 credenciales
// de Meta presentes, `resolveWhatsappAdapter()` devuelve un adaptador real disponible;
// sin ellas, el Fake -- exactamente como `resolveEmailPort` (Resend/SMTP configurado ->
// real; si no, Fake).
import { afterEach, describe, expect, it } from "vitest";
import { FakeWhatsappAdapter, MetaWhatsappAdapter } from "@atiende-hoteles/mcp-whatsapp";
import { resolveWhatsappAdapter, resolveWhatsappWebhookVerifier } from "../../../apps/api/src/lib/messaging.ts";

const ENV_KEYS = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET"] as const;

function clearWhatsappEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("apps/api lib/messaging.ts -- selección condicional del adaptador de WhatsApp", () => {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("sin ninguna credencial de Meta configurada, resuelve FakeWhatsappAdapter (simulated:true)", () => {
    clearWhatsappEnv();
    const adapter = resolveWhatsappAdapter();
    expect(adapter).toBeInstanceOf(FakeWhatsappAdapter);
    expect(adapter.status()).toMatchObject({ available: true, simulated: true });
  });

  it("con las 3 credenciales de Meta presentes, resuelve MetaWhatsappAdapter real (simulated:false)", () => {
    clearWhatsappEnv();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-x";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-x";
    process.env.WHATSAPP_APP_SECRET = "secret-x";
    const adapter = resolveWhatsappAdapter();
    expect(adapter).toBeInstanceOf(MetaWhatsappAdapter);
    expect(adapter.status()).toMatchObject({ available: true, simulated: false });
  });

  it("con solo UNA de las 3 credenciales, sigue resolviendo el Fake (no 'a medias' real)", () => {
    clearWhatsappEnv();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-x";
    const adapter = resolveWhatsappAdapter();
    expect(adapter).toBeInstanceOf(FakeWhatsappAdapter);
  });

  it("resolveWhatsappWebhookVerifier: sin credenciales, verifica con el webhook_secret POR HOTEL (Fake)", async () => {
    clearWhatsappEnv();
    const verifier = resolveWhatsappWebhookVerifier("secreto-de-este-hotel");
    const { rawBody, signature } = FakeWhatsappAdapter.signWebhookFixture(
      { event_id: "evt-1", type: "message.received", from: "+5219980000000", occurred_at: new Date().toISOString() },
      "secreto-de-este-hotel",
    );
    const event = await verifier.verifyAndNormalizeWebhook(rawBody, signature);
    expect(event.eventId).toBe("evt-1");
  });

  it("resolveWhatsappWebhookVerifier: con credenciales de Meta, IGNORA el secreto por hotel y exige WHATSAPP_APP_SECRET real", async () => {
    clearWhatsappEnv();
    process.env.WHATSAPP_ACCESS_TOKEN = "token-x";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-x";
    process.env.WHATSAPP_APP_SECRET = "app-secret-real";
    const verifier = resolveWhatsappWebhookVerifier("secreto-de-este-hotel-que-ya-no-aplica");
    expect(verifier).toBeInstanceOf(MetaWhatsappAdapter);
    // Firmar con el secreto POR HOTEL (el criterio viejo) ya NO sirve para validar --
    // Meta real firma con el App Secret único de la app, nunca con un secreto por hotel.
    const { FakeWhatsappAdapter: Fake } = await import("@atiende-hoteles/mcp-whatsapp");
    const { rawBody, signature } = Fake.signWebhookFixture(
      { event_id: "evt-2", type: "message.received", from: "+5219980000000", occurred_at: new Date().toISOString() },
      "secreto-de-este-hotel-que-ya-no-aplica",
    );
    await expect(verifier.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toBeTruthy();
  });
});
