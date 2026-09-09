/**
 * `PmsPort` -- contrato de integración con el PMS del hotel (Cloudbeds primero, H15-001).
 * Ver docs/ARQUITECTURA.md ADR-007 y docs/referencia/03-investigacion-H12-H21.md §5.
 *
 * Cubre REQ-INT-001 (P0): reservas, tarifas, housekeeping, folio/cargos y perfil de
 * huésped, con webhooks de check-in/checkout. El registro único de conectores
 * (GOB-027/059: prohibido `if provider === X` fuera del registro) vive en quien
 * construye `PmsAdapter` a partir de config, no en este puerto -- este archivo define
 * SOLO la forma del contrato y el mapeo de estados, provider-agnóstico.
 */
import { z } from "zod";
import type { AdapterStatus } from "@atiende-hoteles/mcp-shared";

// ---------------------------------------------------------------------------
// Estados de dominio (mismo enum que `packages/db` migración 0006_reservation.sql,
// ADR-005) -- el adaptador SIEMPRE traduce el estado nativo del PMS a este enum, nunca
// al revés: el resto del sistema no conoce el vocabulario de Cloudbeds/Mews/OHIP.
// ---------------------------------------------------------------------------
export const domainReservationStatuses = [
  "cotizada",
  "confirmada",
  "check_in",
  "en_estancia",
  "check_out",
  "cerrada",
  "cancelada",
  "no_show",
] as const;
export const DomainReservationStatus = z.enum(domainReservationStatuses);
export type DomainReservationStatus = z.infer<typeof DomainReservationStatus>;

/** Estados nativos de Cloudbeds tal como los documenta su API pública `getReservation`. */
export const cloudbedsReservationStatuses = [
  "not_confirmed",
  "confirmed",
  "canceled",
  "checked_in",
  "checked_out",
  "no_show",
  "pending",
] as const;
export const CloudbedsReservationStatus = z.enum(cloudbedsReservationStatuses);
export type CloudbedsReservationStatus = z.infer<typeof CloudbedsReservationStatus>;

/**
 * Mapeo Cloudbeds -> dominio. `checked_in` se traduce a `en_estancia` (el PMS solo
 * reporta el estado vigente del huésped, no el instante de la transición de check-in;
 * el evento discreto `check_in` lo emite nuestro propio flujo de recepción al procesar
 * el webhook, ver `normalizeWebhookEvent`).
 */
export function mapCloudbedsStatusToDomain(
  status: CloudbedsReservationStatus,
): DomainReservationStatus {
  const map: Record<CloudbedsReservationStatus, DomainReservationStatus> = {
    not_confirmed: "cotizada",
    pending: "cotizada",
    confirmed: "confirmada",
    checked_in: "en_estancia",
    checked_out: "check_out",
    canceled: "cancelada",
    no_show: "no_show",
  };
  return map[status];
}

/** Mapeo inverso, usado al construir la petición de actualización hacia Cloudbeds. */
export function mapDomainStatusToCloudbeds(
  status: DomainReservationStatus,
): CloudbedsReservationStatus {
  const map: Partial<Record<DomainReservationStatus, CloudbedsReservationStatus>> = {
    cotizada: "not_confirmed",
    confirmada: "confirmed",
    en_estancia: "checked_in",
    check_out: "checked_out",
    cancelada: "canceled",
    no_show: "no_show",
  };
  const mapped = map[status];
  if (!mapped) {
    throw new Error(
      `mapDomainStatusToCloudbeds: '${status}' no tiene equivalente nativo en Cloudbeds ` +
        `(es un estado interno post-checkout, p.ej. 'cerrada' tras cierre de folio)`,
    );
  }
  return mapped;
}

/** Estados de housekeeping de habitación, mismo vocabulario que H04/H07 (housekeeping). */
export const roomHousekeepingStatuses = [
  "sucia",
  "limpia",
  "inspeccionada",
  "fuera_de_servicio",
] as const;
export const RoomHousekeepingStatus = z.enum(roomHousekeepingStatuses);
export type RoomHousekeepingStatus = z.infer<typeof RoomHousekeepingStatus>;

/** Cloudbeds reporta el estado de limpieza de la habitación como `dirty`/`clean`/`inspected`/`out_of_order`. */
export const cloudbedsRoomStatuses = ["dirty", "clean", "inspected", "out_of_order"] as const;
export const CloudbedsRoomStatus = z.enum(cloudbedsRoomStatuses);
export type CloudbedsRoomStatus = z.infer<typeof CloudbedsRoomStatus>;

export function mapCloudbedsRoomStatusToDomain(status: CloudbedsRoomStatus): RoomHousekeepingStatus {
  const map: Record<CloudbedsRoomStatus, RoomHousekeepingStatus> = {
    dirty: "sucia",
    clean: "limpia",
    inspected: "inspeccionada",
    out_of_order: "fuera_de_servicio",
  };
  return map[status];
}

export function mapDomainRoomStatusToCloudbeds(status: RoomHousekeepingStatus): CloudbedsRoomStatus {
  const map: Record<RoomHousekeepingStatus, CloudbedsRoomStatus> = {
    sucia: "dirty",
    limpia: "clean",
    inspeccionada: "inspected",
    fuera_de_servicio: "out_of_order",
  };
  return map[status];
}

// ---------------------------------------------------------------------------
// Esquemas Zod de entrada/salida del puerto
// ---------------------------------------------------------------------------

export const PmsGuestProfile = z.object({
  externalGuestId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
});
export type PmsGuestProfile = z.infer<typeof PmsGuestProfile>;

export const PmsReservation = z.object({
  externalReservationId: z.string().min(1),
  hotelExternalId: z.string().min(1),
  status: DomainReservationStatus,
  roomTypeExternalId: z.string().min(1),
  checkInDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guest: PmsGuestProfile,
  totalAmount: z.number().nonnegative(),
  currency: z.string().length(3),
  /** Versión/`updatedAt` nativa del PMS -- usada para resolución de conflictos (last-write-wins documentado, no silencioso). */
  externalVersion: z.string().min(1),
});
export type PmsReservation = z.infer<typeof PmsReservation>;

export const PmsRatePlan = z.object({
  externalRatePlanId: z.string().min(1),
  roomTypeExternalId: z.string().min(1),
  name: z.string().min(1),
  currency: z.string().length(3),
  nightlyRate: z.number().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type PmsRatePlan = z.infer<typeof PmsRatePlan>;

export const CreateChargeInput = z.object({
  externalReservationId: z.string().min(1),
  description: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3),
  /** Clave de idempotencia provista por el llamador -- NUNCA se genera una nueva por reintento. */
  idempotencyKey: z.string().min(1),
});
export type CreateChargeInput = z.infer<typeof CreateChargeInput>;

export const PmsCharge = z.object({
  externalChargeId: z.string().min(1),
  externalReservationId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3),
  idempotencyKey: z.string().min(1),
});
export type PmsCharge = z.infer<typeof PmsCharge>;

/**
 * REQ-QA-003 (gate `connector`): entrada de una escritura de reserva con concurrencia
 * optimista sobre `externalVersion` -- el llamador declara qué versión CREE vigente
 * (`expectedVersion`, típicamente la última que leyó/recibió por webhook) y qué versión
 * nueva asigna (`newVersion`). Si `expectedVersion` no coincide con la registrada en el
 * conector, `applyReservationUpdate` lanza `PortConflictError` (409) en vez de
 * sobreescribir en silencio -- ver ADR-007.
 */
export const ApplyReservationUpdateInput = z.object({
  externalReservationId: z.string().min(1),
  status: DomainReservationStatus,
  expectedVersion: z.string().min(1),
  newVersion: z.string().min(1),
});
export type ApplyReservationUpdateInput = z.infer<typeof ApplyReservationUpdateInput>;

export const UpdateHousekeepingInput = z.object({
  roomExternalId: z.string().min(1),
  status: RoomHousekeepingStatus,
});
export type UpdateHousekeepingInput = z.infer<typeof UpdateHousekeepingInput>;

export const PmsRoomStatus = z.object({
  roomExternalId: z.string().min(1),
  status: RoomHousekeepingStatus,
  updatedAt: z.string().datetime(),
});
export type PmsRoomStatus = z.infer<typeof PmsRoomStatus>;

/**
 * Evento normalizado (RawEvent, H15-016) que produce `normalizeWebhookEvent` tras
 * verificar la firma HMAC. `eventId` es la clave de deduplicación de replay.
 */
export const PmsWebhookEvent = z.object({
  eventId: z.string().min(1),
  type: z.enum(["reservation.created", "reservation.updated", "reservation.canceled", "room.status_changed"]),
  externalReservationId: z.string().optional(),
  roomExternalId: z.string().optional(),
  occurredAt: z.string().datetime(),
  raw: z.record(z.string(), z.unknown()),
});
export type PmsWebhookEvent = z.infer<typeof PmsWebhookEvent>;

// ---------------------------------------------------------------------------
// Puerto
// ---------------------------------------------------------------------------

export interface PmsPort {
  /** Estado del adaptador: real sin credenciales -> `available:false`; Fake -> `simulated:true`. */
  status(): AdapterStatus;

  getReservation(externalReservationId: string): Promise<PmsReservation>;

  listRatePlans(input: { roomTypeExternalId: string; from: string; to: string }): Promise<PmsRatePlan[]>;

  /** Idempotente por `input.idempotencyKey`: una segunda llamada con la misma clave no duplica el cargo. */
  createCharge(input: CreateChargeInput): Promise<PmsCharge>;

  /**
   * REQ-QA-003 (gate `connector`): aplica una actualización de estado de reserva
   * (típicamente derivada de un webhook ya verificado) con concurrencia optimista sobre
   * `externalVersion`. Lanza `PortConflictError` de `@atiende-hoteles/mcp-shared` (409)
   * si `input.expectedVersion` no coincide con la versión vigente -- nunca sobreescribe
   * en silencio un estado más nuevo que el que el llamador cree tener.
   */
  applyReservationUpdate(input: ApplyReservationUpdateInput): Promise<PmsReservation>;

  updateHousekeepingStatus(input: UpdateHousekeepingInput): Promise<PmsRoomStatus>;

  getGuestProfile(externalGuestId: string): Promise<PmsGuestProfile>;

  /**
   * Verifica la firma HMAC del webhook contra `rawBody` (string crudo, ANTES de parsear)
   * y, si es válida y no es un replay, normaliza el payload a `PmsWebhookEvent`. Lanza
   * `WebhookSignatureError`/`WebhookReplayError` de `@atiende-hoteles/mcp-shared` en caso
   * contrario -- fail-closed, nunca procesa un payload sin firma válida.
   */
  verifyAndNormalizeWebhook(rawBody: string, signatureHeader: string | undefined): Promise<PmsWebhookEvent>;
}
