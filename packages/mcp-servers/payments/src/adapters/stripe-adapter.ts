/**
 * Adaptador real contra Stripe (modo MX), H15-007. Esqueleto honesto: rutas REST
 * documentadas de la API de PaymentIntents, auth con clave secreta, reintentos con
 * backoff, verificación HMAC de `Stripe-Signature` (formato `t=<ts>,v1=<hex>` sobre
 * `<ts>.<body>`). Sin credenciales, se declara `unavailable`.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`.
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
  PaymentProviderPort,
  ChargeInput,
  PreAuthorizeInput,
  PaymentResult,
  RefundInput,
  PaymentWebhookEvent,
} from "../port.ts";

const REQUIRED_ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;
export const STRIPE_API_BASE = "https://api.stripe.com/v1";
export const STRIPE_ROUTES = {
  paymentIntents: `${STRIPE_API_BASE}/payment_intents`,
  refunds: `${STRIPE_API_BASE}/refunds`,
} as const;

/** Reconstruye el payload firmado que Stripe realmente firma: `${timestamp}.${rawBody}`. */
export function stripeSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export class StripeAdapter implements PaymentProviderPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly replayGuard = new InMemoryReplayGuard();

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "stripe", available: true, simulated: false };
    return {
      provider: "stripe",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError("stripe", `faltan variables de entorno: ${this.credentials.missing.join(", ")}`);
    }
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, {
          ...init,
          headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...init.headers },
        });
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          throw new PortRateLimitError("stripe", retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined);
        }
        if (!response.ok) throw new Error(`stripe: HTTP ${response.status}`);
        return (await response.json()) as T;
      },
      {
        maxAttempts: 4,
        isRetryable: (error) => error instanceof PortRateLimitError,
        retryAfterMs: (error) => (error instanceof PortRateLimitError ? error.retryAfterMs : undefined),
      },
    );
  }

  async charge(input: ChargeInput): Promise<PaymentResult> {
    this.assertAvailable();
    void input;
    void this.request;
    throw new PortUnavailableError("stripe", "sin credenciales verificadas en este entorno");
  }

  async preAuthorize(input: PreAuthorizeInput): Promise<PaymentResult> {
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("stripe", "sin credenciales verificadas en este entorno");
  }

  async capturePreAuth(externalPaymentId: string, idempotencyKey: string): Promise<PaymentResult> {
    this.assertAvailable();
    void externalPaymentId;
    void idempotencyKey;
    throw new PortUnavailableError("stripe", "sin credenciales verificadas en este entorno");
  }

  async refund(input: RefundInput): Promise<PaymentResult> {
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("stripe", "sin credenciales verificadas en este entorno");
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<PaymentWebhookEvent> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new PortUnavailableError("stripe", "falta STRIPE_WEBHOOK_SECRET para verificar webhooks");
    // Formato real: `Stripe-Signature: t=<ts>,v1=<hex>`. Se extrae ts/v1 y se recalcula
    // sobre `stripeSignedPayload(ts, rawBody)`.
    const parts = Object.fromEntries(
      (signatureHeader ?? "").split(",").map((kv) => kv.split("=") as [string, string]),
    );
    const timestamp = parts.t;
    const v1 = parts.v1;
    if (!timestamp || !v1 || !verifyHmacSignature(stripeSignedPayload(timestamp, rawBody), v1, secret, { prefix: "" })) {
      throw new WebhookSignatureError("stripe");
    }
    const payload = JSON.parse(rawBody) as { id?: string };
    const eventId = payload.id;
    if (!eventId) throw new WebhookSignatureError("stripe");
    if (this.replayGuard.seenBefore(eventId)) throw new WebhookReplayError("stripe", eventId);
    throw new PortUnavailableError("stripe", "normalización completa del payload real pendiente de credenciales");
  }
}
