/**
 * Adaptador real contra Conekta (segundo proveedor de pago, H15-007) -- existe
 * precisamente para probar REQ-INT-002: "cambiar de proveedor no requiere tocar la
 * lógica de negocio". Esqueleto honesto, mismas garantías que `StripeAdapter`.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `CONEKTA_PRIVATE_KEY` y `CONEKTA_WEBHOOK_SECRET`.
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

const REQUIRED_ENV = ["CONEKTA_PRIVATE_KEY", "CONEKTA_WEBHOOK_SECRET"] as const;
export const CONEKTA_API_BASE = "https://api.conekta.io";
export const CONEKTA_ROUTES = {
  orders: `${CONEKTA_API_BASE}/orders`,
} as const;

export class ConektaAdapter implements PaymentProviderPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly replayGuard = new InMemoryReplayGuard();

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "conekta", available: true, simulated: false };
    return {
      provider: "conekta",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError("conekta", `faltan variables de entorno: ${this.credentials.missing.join(", ")}`);
    }
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, {
          ...init,
          headers: { Authorization: `Bearer ${process.env.CONEKTA_PRIVATE_KEY}`, ...init.headers },
        });
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          throw new PortRateLimitError("conekta", retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined);
        }
        if (!response.ok) throw new Error(`conekta: HTTP ${response.status}`);
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
    throw new PortUnavailableError("conekta", "sin credenciales verificadas en este entorno");
  }

  async preAuthorize(input: PreAuthorizeInput): Promise<PaymentResult> {
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("conekta", "sin credenciales verificadas en este entorno");
  }

  async capturePreAuth(externalPaymentId: string, idempotencyKey: string): Promise<PaymentResult> {
    this.assertAvailable();
    void externalPaymentId;
    void idempotencyKey;
    throw new PortUnavailableError("conekta", "sin credenciales verificadas en este entorno");
  }

  async refund(input: RefundInput): Promise<PaymentResult> {
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("conekta", "sin credenciales verificadas en este entorno");
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<PaymentWebhookEvent> {
    const secret = process.env.CONEKTA_WEBHOOK_SECRET;
    if (!secret) throw new PortUnavailableError("conekta", "falta CONEKTA_WEBHOOK_SECRET para verificar webhooks");
    if (!verifyHmacSignature(rawBody, signatureHeader, secret)) throw new WebhookSignatureError("conekta");
    const payload = JSON.parse(rawBody) as { id?: string };
    const eventId = payload.id;
    if (!eventId) throw new WebhookSignatureError("conekta");
    if (this.replayGuard.seenBefore(eventId)) throw new WebhookReplayError("conekta", eventId);
    throw new PortUnavailableError("conekta", "normalización completa del payload real pendiente de credenciales");
  }
}
