/**
 * `BillingProviderPort` -- contrato de facturación SaaS (Atiende cobrando AL HOTEL,
 * H18/LAUNCH-015), intercambiable entre Stripe Billing y Conekta -- mismo criterio que
 * `PaymentProviderPort` de `packages/mcp-servers/payments` (que cobra al HUÉSPED, un
 * dominio distinto: nunca se reutiliza el mismo puerto para los dos, porque el ciclo de
 * vida es diferente -- suscripción recurrente vs. cargo/pre-auth puntual). Ver
 * docs/ARQUITECTURA.md ADR-007 y el README de este paquete.
 */
import { z } from "zod";
import type { AdapterStatus } from "@atiende-hoteles/mcp-shared";

export const billingSubscriptionStatuses = ["trial", "activa", "vencida", "cancelada"] as const;
export const BillingSubscriptionStatus = z.enum(billingSubscriptionStatuses);
export type BillingSubscriptionStatus = z.infer<typeof BillingSubscriptionStatus>;

/** Estados nativos de Stripe Subscription, documentados públicamente. */
export const stripeSubscriptionStatuses = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
] as const;
export const StripeSubscriptionStatus = z.enum(stripeSubscriptionStatuses);
export type StripeSubscriptionStatus = z.infer<typeof StripeSubscriptionStatus>;

export function mapStripeStatusToDomain(status: StripeSubscriptionStatus): BillingSubscriptionStatus {
  const map: Record<StripeSubscriptionStatus, BillingSubscriptionStatus> = {
    trialing: "trial",
    active: "activa",
    past_due: "vencida",
    unpaid: "vencida",
    canceled: "cancelada",
    incomplete: "vencida",
    incomplete_expired: "cancelada",
  };
  return map[status];
}

/** Estados nativos de Conekta (subscriptions), documentados públicamente. */
export const conektaSubscriptionStatuses = ["trial", "active", "past_due", "paused", "canceled"] as const;
export const ConektaSubscriptionStatus = z.enum(conektaSubscriptionStatuses);
export type ConektaSubscriptionStatus = z.infer<typeof ConektaSubscriptionStatus>;

export function mapConektaStatusToDomain(status: ConektaSubscriptionStatus): BillingSubscriptionStatus {
  const map: Record<ConektaSubscriptionStatus, BillingSubscriptionStatus> = {
    trial: "trial",
    active: "activa",
    past_due: "vencida",
    paused: "vencida",
    canceled: "cancelada",
  };
  return map[status];
}

// ---------------------------------------------------------------------------
// Esquemas de entrada/salida -- iguales para cualquier adaptador.
// ---------------------------------------------------------------------------

export const CreateCheckoutSessionInput = z.object({
  orgId: z.string().uuid(),
  planCode: z.string().min(1),
  customerEmail: z.string().email(),
  /** Id de cliente ya existente en el proveedor (si el org ya tuvo una suscripción antes). */
  externalCustomerId: z.string().min(1).optional(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  idempotencyKey: z.string().min(1),
});
export type CreateCheckoutSessionInput = z.infer<typeof CreateCheckoutSessionInput>;

export const CheckoutSessionResult = z.object({
  checkoutUrl: z.string().url(),
  externalSessionId: z.string().min(1),
});
export type CheckoutSessionResult = z.infer<typeof CheckoutSessionResult>;

export const CreatePortalSessionInput = z.object({
  externalCustomerId: z.string().min(1),
  returnUrl: z.string().url(),
});
export type CreatePortalSessionInput = z.infer<typeof CreatePortalSessionInput>;

export const PortalSessionResult = z.object({
  portalUrl: z.string().url(),
});
export type PortalSessionResult = z.infer<typeof PortalSessionResult>;

export const BillingWebhookEvent = z.object({
  eventId: z.string().min(1),
  type: z.enum(["subscription.updated", "subscription.canceled", "invoice.paid", "invoice.payment_failed"]),
  externalCustomerId: z.string().min(1).optional(),
  externalSubscriptionId: z.string().min(1).optional(),
  status: BillingSubscriptionStatus.optional(),
  occurredAt: z.string().datetime(),
  raw: z.record(z.string(), z.unknown()),
});
export type BillingWebhookEvent = z.infer<typeof BillingWebhookEvent>;

// ---------------------------------------------------------------------------
// Puerto
// ---------------------------------------------------------------------------

export interface BillingProviderPort {
  status(): AdapterStatus;

  /** Sesión de checkout hospedada por el proveedor (Stripe Checkout / Conekta Checkout). */
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult>;

  /** Portal de autoservicio del cliente (cambiar tarjeta, cancelar, ver facturas pasadas). */
  createPortalSession(input: CreatePortalSessionInput): Promise<PortalSessionResult>;

  /** Verifica firma HMAC + normaliza el payload; lanza si la firma es inválida o el
   *  evento ya se procesó (ver `InMemoryReplayGuard` -- la idempotencia PERSISTIDA vive
   *  además en `public.billing_webhook_event`, 0112, para sobrevivir un reinicio del
   *  proceso). */
  verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<BillingWebhookEvent>;
}
