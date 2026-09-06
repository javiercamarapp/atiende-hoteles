/**
 * Adaptador real contra WhatsApp Cloud API (Meta Graph API), H15-012. Esqueleto
 * honesto: rutas Graph documentadas, auth Bearer con el token del Tech Provider,
 * reintentos con backoff, verificación HMAC (`X-Hub-Signature-256`) de webhooks. Sin
 * credenciales, se declara `unavailable` y ningún método llama a la red real.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `WHATSAPP_ACCESS_TOKEN`,
 * `WHATSAPP_PHONE_NUMBER_ID` y `WHATSAPP_APP_SECRET` (para verificar webhooks, HMAC
 * sobre el body con el App Secret -- ver README.md).
 */
import {
  PortUnavailableError,
  PortRateLimitError,
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryReplayGuard,
  retryWithBackoff,
  verifyHmacSignature,
  checkEnvCredentials,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import type {
  MessagingPort,
  SendTemplateMessageInput,
  SendTextMessageInput,
  SentMessage,
  WhatsappWebhookEvent,
} from "../port.ts";

const REQUIRED_ENV = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET"] as const;

export const GRAPH_API_VERSION = "v21.0";
export function graphMessagesUrl(phoneNumberId: string): string {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
}

export class MetaWhatsappAdapter implements MessagingPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly replayGuard = new InMemoryReplayGuard();

  status(): AdapterStatus {
    if (this.credentials.available) {
      return { provider: "meta-whatsapp", available: true, simulated: false };
    }
    return {
      provider: "meta-whatsapp",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError(
        "meta-whatsapp",
        `faltan variables de entorno: ${this.credentials.missing.join(", ")}`,
      );
    }
  }

  /** Esqueleto de la llamada real con backoff/rate-limit -- no se ejecuta sin credenciales. */
  private async postMessage(body: unknown): Promise<unknown> {
    const url = graphMessagesUrl(process.env.WHATSAPP_PHONE_NUMBER_ID!);
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          throw new PortRateLimitError(
            "meta-whatsapp",
            retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined,
          );
        }
        if (!response.ok) throw new Error(`meta-whatsapp: HTTP ${response.status}`);
        return response.json();
      },
      {
        maxAttempts: 4,
        isRetryable: (error) => error instanceof PortRateLimitError,
        retryAfterMs: (error) => (error instanceof PortRateLimitError ? error.retryAfterMs : undefined),
      },
    );
  }

  async sendTemplateMessage(input: SendTemplateMessageInput): Promise<SentMessage> {
    this.assertAvailable();
    void input;
    void this.postMessage;
    throw new PortUnavailableError("meta-whatsapp", "sin credenciales verificadas en este entorno");
  }

  async sendTextMessage(input: SendTextMessageInput): Promise<SentMessage> {
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("meta-whatsapp", "sin credenciales verificadas en este entorno");
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<WhatsappWebhookEvent> {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) {
      throw new PortUnavailableError("meta-whatsapp", "falta WHATSAPP_APP_SECRET para verificar webhooks");
    }
    if (!verifyHmacSignature(rawBody, signatureHeader, secret)) {
      throw new WebhookSignatureError("meta-whatsapp");
    }
    const payload = JSON.parse(rawBody) as { entry?: Array<{ id: string }> };
    const eventId = payload.entry?.[0]?.id;
    if (!eventId) throw new WebhookSignatureError("meta-whatsapp");
    if (this.replayGuard.seenBefore(eventId)) {
      throw new WebhookReplayError("meta-whatsapp", eventId);
    }
    throw new PortUnavailableError(
      "meta-whatsapp",
      "normalización completa del payload real de Graph API pendiente de credenciales",
    );
  }
}
