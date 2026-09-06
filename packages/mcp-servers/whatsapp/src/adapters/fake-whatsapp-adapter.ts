/**
 * `FakeWhatsappAdapter` -- implementación simulada de `MessagingPort` (`simulated:
 * true`). Aplica el límite del tier de mensajería (ventana móvil de 24h) igual que
 * Meta documenta, para que la prueba de contrato pueda verificar "envío N+1 sobre el
 * límite del tier -> bloqueado" sin llamar a la red (ACEPTACION.md REQ-INT-003).
 */
import {
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryIdempotencyStore,
  InMemoryReplayGuard,
  signHmac,
  verifyHmacSignature,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  MESSAGING_TIER_LIMITS,
  MessagingTierLimitError,
  type MessagingPort,
  type MessagingTier,
  type SendInteractiveButtonsInput,
  type SendTemplateMessageInput,
  type SendTextMessageInput,
  type SentMessage,
  type WhatsappWebhookEvent,
} from "../port.ts";

export const FAKE_WHATSAPP_APP_SECRET = "test-secret-whatsapp-simulado";
const WINDOW_MS = 24 * 60 * 60 * 1000;

export class FakeWhatsappAdapter implements MessagingPort {
  readonly simulated = true as const;
  private readonly sendIdempotency = new InMemoryIdempotencyStore<SentMessage>();
  private readonly replayGuard = new InMemoryReplayGuard();
  private readonly sentTimestamps: number[] = [];
  private sequence = 0;
  // H6b: campos explicitos, no "parameter properties" (incompatibles con
  // `node --experimental-strip-types`, el runtime real de apps/api -- ver el mismo
  // comentario en packages/mcp-servers/shared/src/errors.ts).
  private readonly tier: MessagingTier;
  private readonly now: () => number;
  private readonly appSecret: string;
  /** Solo para pruebas: sustituye el límite real del tier (`MESSAGING_TIER_LIMITS`,
   * hasta 1000+) por uno pequeño para poder probar "envío N+1 -> bloqueado" sin enviar
   * miles de mensajes. `undefined` (default) usa el límite real del tier. */
  private readonly limitOverride?: number;

  constructor(
    tier: MessagingTier = "tier_1k",
    now: () => number = Date.now,
    appSecret: string = FAKE_WHATSAPP_APP_SECRET,
    limitOverride?: number,
  ) {
    this.tier = tier;
    this.now = now;
    this.appSecret = appSecret;
    this.limitOverride = limitOverride;
  }

  status(): AdapterStatus {
    return { provider: "meta-whatsapp", available: true, simulated: true };
  }

  /** Cuenta cuántos envíos hay dentro de la ventana móvil de 24h vigente. */
  private countInWindow(): number {
    const cutoff = this.now() - WINDOW_MS;
    while (this.sentTimestamps.length > 0 && this.sentTimestamps[0]! < cutoff) {
      this.sentTimestamps.shift();
    }
    return this.sentTimestamps.length;
  }

  private assertUnderTierLimit(): void {
    const limit = this.limitOverride ?? MESSAGING_TIER_LIMITS[this.tier];
    if (this.countInWindow() >= limit) {
      throw new MessagingTierLimitError(this.tier, limit);
    }
  }

  private record(clientMessageId: string, to: string, status: SentMessage["status"] = "enviado"): SentMessage {
    const existing = this.sendIdempotency.get(clientMessageId);
    if (existing) return existing;
    this.assertUnderTierLimit();
    this.sequence += 1;
    this.sentTimestamps.push(this.now());
    const message: SentMessage = {
      externalMessageId: `WA-MSG-${this.sequence}`,
      to,
      clientMessageId,
      status,
    };
    this.sendIdempotency.set(clientMessageId, message);
    return message;
  }

  async sendTemplateMessage(input: SendTemplateMessageInput): Promise<SentMessage> {
    return this.record(input.clientMessageId, input.to);
  }

  async sendTextMessage(input: SendTextMessageInput): Promise<SentMessage> {
    return this.record(input.clientMessageId, input.to);
  }

  async sendInteractiveButtonsMessage(input: SendInteractiveButtonsInput): Promise<SentMessage> {
    return this.record(input.clientMessageId, input.to);
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<WhatsappWebhookEvent> {
    if (!verifyHmacSignature(rawBody, signatureHeader, this.appSecret)) {
      throw new WebhookSignatureError("meta-whatsapp");
    }
    const payload = JSON.parse(rawBody) as {
      event_id: string;
      type: WhatsappWebhookEvent["type"];
      from?: string;
      message_id?: string;
      status?: "sent" | "delivered" | "read" | "failed";
      text?: string;
      button_id?: string;
      occurred_at: string;
    };
    if (this.replayGuard.seenBefore(payload.event_id)) {
      throw new WebhookReplayError("meta-whatsapp", payload.event_id);
    }
    const statusMap: Record<string, WhatsappWebhookEvent["status"]> = {
      sent: "enviado",
      delivered: "entregado",
      read: "leido",
      failed: "fallido",
    };
    return {
      eventId: payload.event_id,
      type: payload.type,
      from: payload.from,
      externalMessageId: payload.message_id,
      status: payload.status ? statusMap[payload.status] : undefined,
      textBody: payload.text,
      buttonId: payload.button_id,
      occurredAt: payload.occurred_at,
      raw: payload,
    };
  }

  /** Helper de pruebas: número de mensajes actualmente contados en la ventana de 24h. */
  currentWindowCount(): number {
    return this.countInWindow();
  }

  static signWebhookFixture(
    payload: Record<string, unknown>,
    secret: string = FAKE_WHATSAPP_APP_SECRET,
  ): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(payload);
    return { rawBody, signature: signHmac(rawBody, secret) };
  }
}
