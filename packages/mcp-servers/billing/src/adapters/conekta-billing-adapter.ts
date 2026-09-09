/**
 * Adaptador real contra Conekta Suscripciones (segundo proveedor de facturación SaaS,
 * H12c/LAUNCH-015) -- existe para probar el mismo criterio de REQ-INT-002 aplicado a
 * facturación: cambiar de proveedor no debe requerir tocar la lógica de negocio.
 * Esqueleto honesto, mismas garantías que `StripeBillingAdapter`.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `CONEKTA_PRIVATE_KEY` y
 * `CONEKTA_BILLING_WEBHOOK_SECRET`.
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
  BillingProviderPort,
  CreateCheckoutSessionInput,
  CheckoutSessionResult,
  CreatePortalSessionInput,
  PortalSessionResult,
  BillingWebhookEvent,
} from "../port.ts";

const REQUIRED_ENV = ["CONEKTA_PRIVATE_KEY", "CONEKTA_BILLING_WEBHOOK_SECRET"] as const;
export const CONEKTA_API_BASE = "https://api.conekta.io";
export const CONEKTA_BILLING_ROUTES = {
  subscriptions: `${CONEKTA_API_BASE}/customers/{customer_id}/subscription`,
  customers: `${CONEKTA_API_BASE}/customers`,
} as const;

export class ConektaBillingAdapter implements BillingProviderPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly replayGuard = new InMemoryReplayGuard();

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "conekta-billing", available: true, simulated: false };
    return {
      provider: "conekta-billing",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError("conekta-billing", `faltan variables de entorno: ${this.credentials.missing.join(", ")}`);
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
          throw new PortRateLimitError("conekta-billing", retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined);
        }
        if (!response.ok) throw new Error(`conekta-billing: HTTP ${response.status}`);
        return (await response.json()) as T;
      },
      {
        maxAttempts: 4,
        isRetryable: (error) => error instanceof PortRateLimitError,
        retryAfterMs: (error) => (error instanceof PortRateLimitError ? error.retryAfterMs : undefined),
      },
    );
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
    this.assertAvailable();
    void input;
    void this.request;
    throw new PortUnavailableError("conekta-billing", "sin credenciales verificadas en este entorno");
  }

  async createPortalSession(input: CreatePortalSessionInput): Promise<PortalSessionResult> {
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("conekta-billing", "sin credenciales verificadas en este entorno");
  }

  async verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<BillingWebhookEvent> {
    const secret = process.env.CONEKTA_BILLING_WEBHOOK_SECRET;
    if (!secret) throw new PortUnavailableError("conekta-billing", "falta CONEKTA_BILLING_WEBHOOK_SECRET para verificar webhooks");
    if (!verifyHmacSignature(rawBody, signatureHeader, secret)) {
      throw new WebhookSignatureError("conekta-billing");
    }
    const payload = JSON.parse(rawBody) as { id?: string };
    const eventId = payload.id;
    if (!eventId) throw new WebhookSignatureError("conekta-billing");
    if (this.replayGuard.seenBefore(eventId)) throw new WebhookReplayError("conekta-billing", eventId);
    throw new PortUnavailableError("conekta-billing", "normalización completa del payload real pendiente de credenciales");
  }
}
