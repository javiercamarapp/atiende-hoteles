/**
 * Base común de los adaptadores simulados de pago (`FakeStripeAdapter`,
 * `FakeConektaAdapter`, `simulated: true`). Ambos comparten exactamente la misma
 * máquina de estados/idempotencia/expiración de pre-auth -- lo único que cambia es el
 * nombre del proveedor y el secreto de webhook -- para que la prueba de contrato
 * "adapter-swap" (REQ-INT-002) corra la MISMA suite contra los dos y confirme que
 * cambiar de proveedor no requiere tocar lógica de negocio.
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
  PreAuthExpiredError,
  type PaymentProviderPort,
  type ChargeInput,
  type PreAuthorizeInput,
  type PaymentResult,
  type RefundInput,
  type PaymentWebhookEvent,
} from "../port.ts";

interface PreAuthRecord extends PaymentResult {
  expiresAtMs: number;
}

export abstract class FakeGenericPaymentAdapter implements PaymentProviderPort {
  readonly simulated = true as const;
  private readonly resultIdempotency = new InMemoryIdempotencyStore<PaymentResult>();
  private readonly preAuths = new Map<string, PreAuthRecord>();
  private readonly replayGuard = new InMemoryReplayGuard();
  private sequence = 0;

  constructor(
    private readonly providerName: string,
    private readonly webhookSecret: string,
    private readonly now: () => number = Date.now,
  ) {}

  status(): AdapterStatus {
    return { provider: this.providerName, available: true, simulated: true };
  }

  async charge(input: ChargeInput): Promise<PaymentResult> {
    const existing = this.resultIdempotency.get(input.idempotencyKey);
    if (existing) return existing;
    this.sequence += 1;
    const result: PaymentResult = {
      externalPaymentId: `${this.providerName.toUpperCase()}-PAY-${this.sequence}`,
      status: "capturado",
      amount: input.amount,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
    };
    this.resultIdempotency.set(input.idempotencyKey, result);
    return result;
  }

  async preAuthorize(input: PreAuthorizeInput): Promise<PaymentResult> {
    const existing = this.resultIdempotency.get(input.idempotencyKey);
    if (existing) return existing;
    this.sequence += 1;
    const expiresAtMs = this.now() + input.holdMinutes * 60_000;
    const result: PreAuthRecord = {
      externalPaymentId: `${this.providerName.toUpperCase()}-PRE-${this.sequence}`,
      status: "autorizado",
      amount: input.amount,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
      preAuthExpiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    };
    this.resultIdempotency.set(input.idempotencyKey, result);
    this.preAuths.set(result.externalPaymentId, result);
    return result;
  }

  async capturePreAuth(externalPaymentId: string, idempotencyKey: string): Promise<PaymentResult> {
    const existing = this.resultIdempotency.get(idempotencyKey);
    if (existing) return existing;
    const preAuth = this.preAuths.get(externalPaymentId);
    if (!preAuth) throw new Error(`${this.providerName}: pre-autorización desconocida ${externalPaymentId}`);
    if (this.now() > preAuth.expiresAtMs) {
      throw new PreAuthExpiredError(externalPaymentId);
    }
    const result: PaymentResult = {
      externalPaymentId,
      status: "capturado",
      amount: preAuth.amount,
      currency: preAuth.currency,
      idempotencyKey,
    };
    this.resultIdempotency.set(idempotencyKey, result);
    return result;
  }

  async refund(input: RefundInput): Promise<PaymentResult> {
    const existing = this.resultIdempotency.get(input.idempotencyKey);
    if (existing) return existing;
    const result: PaymentResult = {
      externalPaymentId: input.externalPaymentId,
      status: "reembolsado",
      amount: input.amount,
      currency: "MXN",
      idempotencyKey: input.idempotencyKey,
    };
    this.resultIdempotency.set(input.idempotencyKey, result);
    return result;
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<PaymentWebhookEvent> {
    if (!verifyHmacSignature(rawBody, signatureHeader, this.webhookSecret)) {
      throw new WebhookSignatureError(this.providerName);
    }
    const payload = JSON.parse(rawBody) as {
      event_id: string;
      type: PaymentWebhookEvent["type"];
      payment_id: string;
      status: PaymentWebhookEvent["status"];
      occurred_at: string;
    };
    if (this.replayGuard.seenBefore(payload.event_id)) {
      throw new WebhookReplayError(this.providerName, payload.event_id);
    }
    return {
      eventId: payload.event_id,
      type: payload.type,
      externalPaymentId: payload.payment_id,
      status: payload.status,
      occurredAt: payload.occurred_at,
      raw: payload,
    };
  }

  signWebhookFixture(payload: Record<string, unknown>): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(payload);
    return { rawBody, signature: signHmac(rawBody, this.webhookSecret) };
  }
}

export const FAKE_STRIPE_WEBHOOK_SECRET = "test-secret-stripe-simulado";
export const FAKE_CONEKTA_WEBHOOK_SECRET = "test-secret-conekta-simulado";

export class FakeStripeAdapter extends FakeGenericPaymentAdapter {
  constructor(now?: () => number, webhookSecret: string = FAKE_STRIPE_WEBHOOK_SECRET) {
    super("stripe", webhookSecret, now);
  }
}

export class FakeConektaAdapter extends FakeGenericPaymentAdapter {
  constructor(now?: () => number, webhookSecret: string = FAKE_CONEKTA_WEBHOOK_SECRET) {
    super("conekta", webhookSecret, now);
  }
}
