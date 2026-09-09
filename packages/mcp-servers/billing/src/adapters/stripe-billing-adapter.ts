/**
 * Adaptador real contra Stripe Billing (Checkout Sessions + Billing Portal + webhooks
 * firmados), H12c/LAUNCH-015. Esqueleto honesto: rutas REST documentadas, auth con clave
 * secreta, reintentos con backoff, verificación HMAC de `Stripe-Signature` (mismo formato
 * que `packages/mcp-servers/payments/src/adapters/stripe-adapter.ts`). Sin credenciales,
 * se declara `unavailable` -- nunca se fabrica una URL de checkout falsa.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `STRIPE_SECRET_KEY` y `STRIPE_BILLING_WEBHOOK_SECRET`
 * (secreto de webhook DISTINTO del de `mcp-payments`: en Stripe cada "endpoint" de
 * webhook tiene su propio secreto — este vive en el endpoint de facturación SaaS, no en
 * el de cobros a huésped).
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
import { stripeSignedPayload } from "./shared-stripe-signature.ts";

const REQUIRED_ENV = ["STRIPE_SECRET_KEY", "STRIPE_BILLING_WEBHOOK_SECRET"] as const;
export const STRIPE_API_BASE = "https://api.stripe.com/v1";
export const STRIPE_BILLING_ROUTES = {
  checkoutSessions: `${STRIPE_API_BASE}/checkout/sessions`,
  billingPortalSessions: `${STRIPE_API_BASE}/billing_portal/sessions`,
} as const;

export class StripeBillingAdapter implements BillingProviderPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly replayGuard = new InMemoryReplayGuard();

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "stripe-billing", available: true, simulated: false };
    return {
      provider: "stripe-billing",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError("stripe-billing", `faltan variables de entorno: ${this.credentials.missing.join(", ")}`);
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
          throw new PortRateLimitError("stripe-billing", retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined);
        }
        if (!response.ok) throw new Error(`stripe-billing: HTTP ${response.status}`);
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
    throw new PortUnavailableError("stripe-billing", "sin credenciales verificadas en este entorno");
  }

  async createPortalSession(input: CreatePortalSessionInput): Promise<PortalSessionResult> {
    this.assertAvailable();
    void input;
    throw new PortUnavailableError("stripe-billing", "sin credenciales verificadas en este entorno");
  }

  async verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<BillingWebhookEvent> {
    const secret = process.env.STRIPE_BILLING_WEBHOOK_SECRET;
    if (!secret) throw new PortUnavailableError("stripe-billing", "falta STRIPE_BILLING_WEBHOOK_SECRET para verificar webhooks");
    const parts = Object.fromEntries((signatureHeader ?? "").split(",").map((kv) => kv.split("=") as [string, string]));
    const timestamp = parts.t;
    const v1 = parts.v1;
    if (!timestamp || !v1 || !verifyHmacSignature(stripeSignedPayload(timestamp, rawBody), v1, secret, { prefix: "" })) {
      throw new WebhookSignatureError("stripe-billing");
    }
    const payload = JSON.parse(rawBody) as { id?: string };
    const eventId = payload.id;
    if (!eventId) throw new WebhookSignatureError("stripe-billing");
    if (this.replayGuard.seenBefore(eventId)) throw new WebhookReplayError("stripe-billing", eventId);
    throw new PortUnavailableError("stripe-billing", "normalización completa del payload real pendiente de credenciales");
  }
}
