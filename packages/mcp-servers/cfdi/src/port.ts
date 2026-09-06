/**
 * `CfdiPort` -- contrato de timbrado CFDI 4.0 vía PAC (H16-007), con dos PAC
 * intercambiables como mitigación de riesgo de timbrado mal formado (H15 §5 "riesgos y
 * mitigaciones"). Cubre REQ-INT-005 (P0). Ver docs/ARQUITECTURA.md ADR-007.
 *
 * Nombres de PAC (`FinkokAdapter`/`SwSapaAdapter`) son ejemplos de proveedores PAC
 * mexicanos reales de conocimiento público -- `docs/REQUISITOS.md`/H15 no fijan un PAC
 * específico, la elección final queda pendiente del fundador (ver README.md).
 */
import { z } from "zod";
import type { AdapterStatus } from "@atiende-hoteles/mcp-shared";

// ---------------------------------------------------------------------------
// Estado de dominio del CFDI. El SAT/PAC reportan "vigente"/"cancelado" de forma nativa
// en español, pero cada PAC usa su propio vocabulario intermedio para el proceso de
// cancelación (p.ej. approval workflow de cancelación 2022+) -- se mapea explícitamente
// para no acoplar el resto del sistema al vocabulario de un PAC.
// ---------------------------------------------------------------------------
export const domainCfdiStatuses = [
  "pendiente",
  "timbrado",
  "en_proceso_cancelacion",
  "cancelado",
  "rechazado",
] as const;
export const DomainCfdiStatus = z.enum(domainCfdiStatuses);
export type DomainCfdiStatus = z.infer<typeof DomainCfdiStatus>;

/** Vocabulario nativo de ejemplo de un PAC (basado en el ciclo de vida documentado por el SAT: timbrado -> vigente -> cancelado, con proceso de aceptación/rechazo de cancelación 2022+). */
export const pacNativeStatuses = ["stamped", "active", "cancellation_pending", "canceled", "rejected"] as const;
export const PacNativeStatus = z.enum(pacNativeStatuses);
export type PacNativeStatus = z.infer<typeof PacNativeStatus>;

export function mapPacStatusToDomain(status: PacNativeStatus): DomainCfdiStatus {
  const map: Record<PacNativeStatus, DomainCfdiStatus> = {
    stamped: "timbrado",
    active: "timbrado",
    cancellation_pending: "en_proceso_cancelacion",
    canceled: "cancelado",
    rejected: "rechazado",
  };
  return map[status];
}

// ---------------------------------------------------------------------------
// Esquemas Zod
// ---------------------------------------------------------------------------

/** Subconjunto de `ImpuestosLocales` (ISH/DSA) que el hotel debe declarar por CFDI de hospedaje. */
export const ImpuestosLocales = z.object({
  ishTasa: z.number().min(0).max(1),
  ishMonto: z.number().nonnegative(),
  dsaMonto: z.number().nonnegative().optional(),
});
export type ImpuestosLocales = z.infer<typeof ImpuestosLocales>;

export const TimbrarInput = z.object({
  /** Referencia interna del hotel -- clave de idempotencia: timbrar dos veces el mismo folio NUNCA emite dos UUID. */
  folio: z.string().min(1),
  rfcEmisor: z.string().min(12).max(13),
  rfcReceptor: z.string().min(12).max(13),
  subtotal: z.number().positive(),
  iva: z.number().nonnegative(),
  impuestosLocales: ImpuestosLocales,
  total: z.number().positive(),
  moneda: z.literal("MXN"),
  usoCfdi: z.string().min(1),
  metodoPago: z.enum(["PUE", "PPD"]),
});
export type TimbrarInput = z.infer<typeof TimbrarInput>;

export const CfdiTimbrado = z.object({
  uuid: z.string().uuid(),
  folio: z.string().min(1),
  status: DomainCfdiStatus,
  selloDigital: z.string().min(1),
  fechaTimbrado: z.string().datetime(),
  pac: z.string().min(1),
});
export type CfdiTimbrado = z.infer<typeof CfdiTimbrado>;

export const CancelarInput = z.object({
  uuid: z.string().uuid(),
  motivo: z.enum(["01", "02", "03", "04"]), // catálogo SAT c_MotivoCancelacion
  folioSustitucion: z.string().uuid().optional(), // obligatorio si motivo === "01"
  idempotencyKey: z.string().min(1),
});
export type CancelarInput = z.infer<typeof CancelarInput>;

export const CfdiCancelacion = z.object({
  uuid: z.string().uuid(),
  status: DomainCfdiStatus,
  fechaSolicitud: z.string().datetime(),
});
export type CfdiCancelacion = z.infer<typeof CfdiCancelacion>;

export const CfdiWebhookEvent = z.object({
  eventId: z.string().min(1),
  type: z.enum(["cfdi.timbrado_confirmado", "cfdi.cancelado", "cfdi.cancelacion_rechazada"]),
  uuid: z.string().uuid(),
  status: DomainCfdiStatus,
  occurredAt: z.string().datetime(),
  raw: z.record(z.string(), z.unknown()),
});
export type CfdiWebhookEvent = z.infer<typeof CfdiWebhookEvent>;

/** Rechaza timbrar dos veces con datos DIFERENTES bajo el mismo folio (la idempotencia no es "ignorar" sino "detectar inconsistencia"). */
export class CfdiFolioConflictError extends Error {
  readonly code = "cfdi_folio_conflict";
  constructor(readonly folio: string) {
    super(`el folio ${folio} ya fue timbrado con datos distintos a los solicitados`);
    this.name = "CfdiFolioConflictError";
  }
}

// ---------------------------------------------------------------------------
// Puerto
// ---------------------------------------------------------------------------

export interface CfdiPort {
  status(): AdapterStatus;

  /** Idempotente por `input.folio`. Lanza `CfdiFolioConflictError` si el folio ya se timbró con otros datos. */
  timbrar(input: TimbrarInput): Promise<CfdiTimbrado>;

  /** Idempotente por `input.idempotencyKey`. */
  cancelar(input: CancelarInput): Promise<CfdiCancelacion>;

  consultarEstado(uuid: string): Promise<DomainCfdiStatus>;

  verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<CfdiWebhookEvent>;
}
