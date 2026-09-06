/**
 * `MessagingPort` -- contrato de integración con WhatsApp Cloud API (Meta, H15-012).
 * Ver docs/ARQUITECTURA.md ADR-007, docs/referencia/02-investigacion-H01-H11.md H09
 * (WhatsApp como canal principal) y docs/referencia/03-investigacion-H12-H21.md §5.
 *
 * Cubre REQ-INT-003 (P0): REST+webhooks+Flows+Calling, un solo portafolio de Meta por
 * hotel (Tech Provider, Embedded Signup), respetando el límite de mensajería del tier.
 */
import { z } from "zod";
import type { AdapterStatus } from "@atiende-hoteles/mcp-shared";

// ---------------------------------------------------------------------------
// Estados de dominio de un mensaje saliente. Meta reporta el estado nativo vía webhook
// de `statuses` con los valores `sent|delivered|read|failed` -- se mapean 1:1 porque ya
// son el vocabulario que el resto del sistema necesita (a diferencia de PMS, aquí no hay
// ambigüedad de proveedor: es el único canal, REQ-INT-003).
// ---------------------------------------------------------------------------
export const domainMessageStatuses = ["enviado", "entregado", "leido", "fallido"] as const;
export const DomainMessageStatus = z.enum(domainMessageStatuses);
export type DomainMessageStatus = z.infer<typeof DomainMessageStatus>;

export const metaMessageStatuses = ["sent", "delivered", "read", "failed"] as const;
export const MetaMessageStatus = z.enum(metaMessageStatuses);
export type MetaMessageStatus = z.infer<typeof MetaMessageStatus>;

export function mapMetaStatusToDomain(status: MetaMessageStatus): DomainMessageStatus {
  const map: Record<MetaMessageStatus, DomainMessageStatus> = {
    sent: "enviado",
    delivered: "entregado",
    read: "leido",
    failed: "fallido",
  };
  return map[status];
}

/**
 * Tiers de mensajería de negocio de Meta (límite de conversaciones iniciadas por el
 * hotel en una ventana de 24h). `unlimited` existe para negocios verificados de alto
 * volumen -- ver H09/H15-012.
 */
export const messagingTiers = ["tier_1k", "tier_10k", "tier_100k", "unlimited"] as const;
export const MessagingTier = z.enum(messagingTiers);
export type MessagingTier = z.infer<typeof MessagingTier>;

export const MESSAGING_TIER_LIMITS: Record<MessagingTier, number> = {
  tier_1k: 1_000,
  tier_10k: 10_000,
  tier_100k: 100_000,
  unlimited: Number.POSITIVE_INFINITY,
};

// ---------------------------------------------------------------------------
// Esquemas Zod de entrada/salida
// ---------------------------------------------------------------------------

export const SendTemplateMessageInput = z.object({
  to: z.string().min(8), // E.164
  templateName: z.string().min(1),
  languageCode: z.string().min(2),
  parameters: z.array(z.string()).default([]),
  /** Clave de idempotencia del llamador -- una plantilla de check-in no se reenvía dos veces por reintento. */
  clientMessageId: z.string().min(1),
});
export type SendTemplateMessageInput = z.infer<typeof SendTemplateMessageInput>;

export const SendTextMessageInput = z.object({
  to: z.string().min(8),
  body: z.string().min(1).max(4096),
  clientMessageId: z.string().min(1),
});
export type SendTextMessageInput = z.infer<typeof SendTextMessageInput>;

// REQ-UX-006 (H09-026/BP-010): "las aprobaciones operativas del gerente deben poder
// ejecutarse mediante botón directamente en el mensaje de WhatsApp, sin requerir
// acceso al panel web." Un mensaje interactivo de "reply buttons" de WhatsApp Cloud
// API admite hasta 3 botones -- suficiente para aprobar/rechazar (y, si aplica, un
// tercero de "ver detalle").
export const InteractiveButton = z.object({
  /** Máximo 256 caracteres por especificación de Meta; el valor real que este sistema
   *  usa (ver aprobacionesWhatsapp.ts) siempre es corto: `aprobar:<uuid>`/`rechazar:<uuid>`. */
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(20),
});
export type InteractiveButton = z.infer<typeof InteractiveButton>;

export const SendInteractiveButtonsInput = z.object({
  to: z.string().min(8),
  body: z.string().min(1).max(1024),
  buttons: z.array(InteractiveButton).min(1).max(3),
  clientMessageId: z.string().min(1),
});
export type SendInteractiveButtonsInput = z.infer<typeof SendInteractiveButtonsInput>;

export const SentMessage = z.object({
  externalMessageId: z.string().min(1),
  to: z.string().min(8),
  clientMessageId: z.string().min(1),
  status: DomainMessageStatus,
});
export type SentMessage = z.infer<typeof SentMessage>;

/** Evento normalizado de un webhook entrante (mensaje del huésped, actualización de
 *  estado, Flow completado, o clic en un botón interactivo -- REQ-UX-006). */
export const WhatsappWebhookEvent = z.object({
  eventId: z.string().min(1),
  type: z.enum(["message.received", "message.status_updated", "flow.completed", "interactive.button_clicked"]),
  from: z.string().optional(),
  externalMessageId: z.string().optional(),
  status: DomainMessageStatus.optional(),
  textBody: z.string().optional(),
  /** Solo presente cuando `type === "interactive.button_clicked"`: el `id` del botón
   *  presionado (ver `InteractiveButton.id` arriba). */
  buttonId: z.string().optional(),
  occurredAt: z.string().datetime(),
  raw: z.record(z.string(), z.unknown()),
});
export type WhatsappWebhookEvent = z.infer<typeof WhatsappWebhookEvent>;

// ---------------------------------------------------------------------------
// Puerto
// ---------------------------------------------------------------------------

/** Se lanza cuando el hotel ya agotó su cupo de conversaciones iniciadas por negocio en la ventana de 24h. */
export class MessagingTierLimitError extends Error {
  readonly code = "messaging_tier_limit_exceeded";
  // H6b: campos explicitos, no "parameter properties" (incompatibles con el modo de
  // solo "strip types" de Node, `node --experimental-strip-types` -- ver el mismo
  // comentario en packages/mcp-servers/shared/src/errors.ts). auditoria-2/arquitectura
  // [ALTO], corregido: apps/api YA NO usa ese flag desde H5 (usa
  // --experimental-transform-types, que si transforma parameter properties) -- este
  // archivo sigue evitando el azucar para seguir siendo valido bajo el modo mas
  // estricto (scripts/check-runtime-flags.ts vigila que package.json y la
  // documentacion no diverjan de nuevo).
  readonly tier: MessagingTier;
  readonly limit: number;

  constructor(tier: MessagingTier, limit: number) {
    super(`límite del tier de mensajería '${tier}' (${limit}) excedido en la ventana de 24h`);
    this.name = "MessagingTierLimitError";
    this.tier = tier;
    this.limit = limit;
  }
}

export interface MessagingPort {
  status(): AdapterStatus;

  /** Requerido fuera de la ventana de 24h de servicio al cliente (Meta exige plantilla aprobada). */
  sendTemplateMessage(input: SendTemplateMessageInput): Promise<SentMessage>;

  /** Solo válido dentro de la ventana de 24h de conversación abierta por el huésped. */
  sendTextMessage(input: SendTextMessageInput): Promise<SentMessage>;

  /** REQ-UX-006: mensaje con botones de respuesta rápida (hasta 3) -- usado para que
   *  el gerente apruebe/rechace directamente desde WhatsApp, sin abrir el panel web. */
  sendInteractiveButtonsMessage(input: SendInteractiveButtonsInput): Promise<SentMessage>;

  verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<WhatsappWebhookEvent>;
}
