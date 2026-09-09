/**
 * `FakeBillingAdapter` (`simulated: true`) -- sin credenciales de Stripe/Conekta, es el
 * adaptador que `createApp` instancia por defecto (mismo criterio que `FakeStripeAdapter`
 * de `packages/mcp-servers/payments`). Genera URLs de checkout/portal deterministas
 * (nunca una URL real de un proveedor), y firma/verifica webhooks con HMAC igual que el
 * resto de adaptadores fake del monorepo -- permite escribir la prueba adversarial
 * "webhook con firma inválida se rechaza" sin ninguna credencial real.
 */
import {
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryReplayGuard,
  signHmac,
  verifyHmacSignature,
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

export const FAKE_BILLING_WEBHOOK_SECRET = "test-secret-billing-simulado";

export class FakeBillingAdapter implements BillingProviderPort {
  readonly simulated = true as const;
  private readonly replayGuard = new InMemoryReplayGuard();
  private sequence = 0;

  constructor(
    private readonly providerName: "fake" = "fake",
    private readonly webhookSecret: string = FAKE_BILLING_WEBHOOK_SECRET,
  ) {}

  status(): AdapterStatus {
    return { provider: this.providerName, available: true, simulated: true };
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
    this.sequence += 1;
    const externalSessionId = `FAKE-CHECKOUT-${this.sequence}`;
    return {
      // Nunca un dominio real de un proveedor -- deja explícito en la propia URL que es
      // simulado, para que nadie confunda esto con un checkout real en un log/captura.
      checkoutUrl: `https://billing.simulado.local/checkout/${externalSessionId}?plan=${input.planCode}`,
      externalSessionId,
    };
  }

  async createPortalSession(input: CreatePortalSessionInput): Promise<PortalSessionResult> {
    this.sequence += 1;
    return {
      portalUrl: `https://billing.simulado.local/portal/${input.externalCustomerId}?return=${encodeURIComponent(input.returnUrl)}`,
    };
  }

  async verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<BillingWebhookEvent> {
    if (!verifyHmacSignature(rawBody, signatureHeader, this.webhookSecret)) {
      throw new WebhookSignatureError(this.providerName);
    }
    const payload = JSON.parse(rawBody) as {
      event_id: string;
      type: BillingWebhookEvent["type"];
      external_customer_id?: string;
      external_subscription_id?: string;
      status?: BillingWebhookEvent["status"];
      occurred_at: string;
    };
    if (this.replayGuard.seenBefore(payload.event_id)) {
      throw new WebhookReplayError(this.providerName, payload.event_id);
    }
    return {
      eventId: payload.event_id,
      type: payload.type,
      externalCustomerId: payload.external_customer_id,
      externalSubscriptionId: payload.external_subscription_id,
      status: payload.status,
      occurredAt: payload.occurred_at,
      raw: payload,
    };
  }

  /** Firma un payload de prueba con el secreto del fake -- usado en tests adversariales
   *  para construir un webhook "real" (firmado) y comparar contra uno falsificado. */
  signWebhookFixture(payload: Record<string, unknown>): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(payload);
    return { rawBody, signature: signHmac(rawBody, this.webhookSecret) };
  }
}
