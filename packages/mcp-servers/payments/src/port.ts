/**
 * `PaymentProviderPort` -- contrato de pagos intercambiable (Stripe MX/Conekta como
 * base, H15-007). Ver docs/ARQUITECTURA.md ADR-007. Cubre REQ-INT-002 (P0): "cambiar de
 * proveedor de pago no requiere cambios en la lógica de negocio, compartida entre el
 * módulo hotel y el módulo restaurante bajo el mismo adquirente" -- verificado corriendo
 * la MISMA suite de contrato contra 2 adaptadores (Stripe y Conekta).
 */
import { z } from "zod";
import type { AdapterStatus } from "@atiende-hoteles/mcp-shared";

// ---------------------------------------------------------------------------
// Estado de dominio del pago. Mitigación de riesgo H15 ("cobro erróneo de VCC/pre-auth
// vencida: máquina de estados de pago con expiresAt") -- por eso `preAuthExpiresAt` es
// parte del esquema, no un detalle interno del adaptador.
// ---------------------------------------------------------------------------
export const domainPaymentStatuses = [
  "pendiente",
  "autorizado",
  "capturado",
  "fallido",
  "reembolsado",
  "expirado",
] as const;
export const DomainPaymentStatus = z.enum(domainPaymentStatuses);
export type DomainPaymentStatus = z.infer<typeof DomainPaymentStatus>;

/** Estados nativos de Stripe PaymentIntent, documentados públicamente. */
export const stripePaymentIntentStatuses = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "requires_capture",
  "succeeded",
  "canceled",
] as const;
export const StripePaymentIntentStatus = z.enum(stripePaymentIntentStatuses);
export type StripePaymentIntentStatus = z.infer<typeof StripePaymentIntentStatus>;

export function mapStripeStatusToDomain(status: StripePaymentIntentStatus): DomainPaymentStatus {
  const map: Record<StripePaymentIntentStatus, DomainPaymentStatus> = {
    requires_payment_method: "pendiente",
    requires_confirmation: "pendiente",
    requires_action: "pendiente",
    processing: "pendiente",
    requires_capture: "autorizado",
    succeeded: "capturado",
    canceled: "fallido",
  };
  return map[status];
}

/** Estados nativos de Conekta (orders/charges), documentados públicamente. */
export const conektaOrderStatuses = [
  "pending_payment",
  "paid",
  "declined",
  "expired",
  "refunded",
  "partially_refunded",
] as const;
export const ConektaOrderStatus = z.enum(conektaOrderStatuses);
export type ConektaOrderStatus = z.infer<typeof ConektaOrderStatus>;

export function mapConektaStatusToDomain(status: ConektaOrderStatus): DomainPaymentStatus {
  const map: Record<ConektaOrderStatus, DomainPaymentStatus> = {
    pending_payment: "pendiente",
    paid: "capturado",
    declined: "fallido",
    expired: "expirado",
    refunded: "reembolsado",
    partially_refunded: "reembolsado",
  };
  return map[status];
}

// ---------------------------------------------------------------------------
// Esquemas Zod de entrada/salida -- iguales para cualquier adaptador (Stripe/Conekta):
// esta es exactamente la garantía que REQ-INT-002 exige poder probar.
// ---------------------------------------------------------------------------

export const ChargeInput = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
  paymentMethodToken: z.string().min(1),
  /** Clave de idempotencia -- una doble llamada con la misma clave NUNCA cobra dos veces. */
  idempotencyKey: z.string().min(1),
});
export type ChargeInput = z.infer<typeof ChargeInput>;

export const PreAuthorizeInput = ChargeInput.extend({
  /** Minutos hasta que la pre-autorización expira si no se captura (mitigación H15). */
  holdMinutes: z.number().int().positive().default(60 * 24 * 7),
});
export type PreAuthorizeInput = z.infer<typeof PreAuthorizeInput>;

export const PaymentResult = z.object({
  externalPaymentId: z.string().min(1),
  status: DomainPaymentStatus,
  amount: z.number().positive(),
  currency: z.string().length(3),
  idempotencyKey: z.string().min(1),
  /** Solo presente cuando `status === "autorizado"` -- ver mitigación de pre-auth vencida. */
  preAuthExpiresAt: z.string().datetime().optional(),
});
export type PaymentResult = z.infer<typeof PaymentResult>;

export const RefundInput = z.object({
  externalPaymentId: z.string().min(1),
  amount: z.number().positive(),
  idempotencyKey: z.string().min(1),
});
export type RefundInput = z.infer<typeof RefundInput>;

export const PaymentWebhookEvent = z.object({
  eventId: z.string().min(1),
  type: z.enum(["payment.succeeded", "payment.failed", "payment.refunded", "preauth.expired"]),
  externalPaymentId: z.string().min(1),
  status: DomainPaymentStatus,
  occurredAt: z.string().datetime(),
  raw: z.record(z.string(), z.unknown()),
});
export type PaymentWebhookEvent = z.infer<typeof PaymentWebhookEvent>;

// ---------------------------------------------------------------------------
// Errores específicos del dominio de pagos
// ---------------------------------------------------------------------------

/** Intento de capturar una pre-autorización cuyo `preAuthExpiresAt` ya pasó -- fail-closed, nunca se cobra. */
export class PreAuthExpiredError extends Error {
  readonly code = "preauth_expired";
  constructor(readonly externalPaymentId: string) {
    super(`la pre-autorización ${externalPaymentId} ya expiró: no se puede capturar`);
    this.name = "PreAuthExpiredError";
  }
}

// ---------------------------------------------------------------------------
// Puerto
// ---------------------------------------------------------------------------

export interface PaymentProviderPort {
  status(): AdapterStatus;

  /** Cobro directo (sin retención previa). Idempotente por `input.idempotencyKey`. */
  charge(input: ChargeInput): Promise<PaymentResult>;

  /** Retiene el monto sin capturarlo (garantía de reserva/no-show). Idempotente. */
  preAuthorize(input: PreAuthorizeInput): Promise<PaymentResult>;

  /** Captura una pre-autorización vigente. Lanza `PreAuthExpiredError` si ya venció. */
  capturePreAuth(externalPaymentId: string, idempotencyKey: string): Promise<PaymentResult>;

  /** Reembolso total o parcial. Idempotente por `input.idempotencyKey`. */
  refund(input: RefundInput): Promise<PaymentResult>;

  verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<PaymentWebhookEvent>;
}
