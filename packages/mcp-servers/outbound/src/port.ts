/**
 * `OutboundTaskSyncPort` -- conector OUTBOUND genérico y configurable POR HOTEL para
 * empujar tareas locales (housekeeping/mantenimiento/tickets de huésped) hacia el
 * sistema de gestión de tareas propio de un hotel de cadena (HotSOS/Optii-style, ver
 * docs/integraciones/conector-pms-enterprise.md). Contexto de negocio: hoteles
 * grandes/de cadena YA corren su propio sistema de asignación/seguimiento de tareas --
 * este backend no debe ser el sistema de registro final para ese caso, solo la CAPA DE
 * ENTRADA que genera la señal y la empuja al sistema del hotel vía su API.
 *
 * Diferencia deliberada con `PaymentProviderPort`/`CfdiPort` (packages/mcp-servers/
 * payments, cfdi): esos son UN proveedor global por proceso, resuelto por credenciales
 * de variables de entorno (`resolvePaymentPort()`). Aquí la credencial es POR HOTEL --
 * cada hotel de la cadena apunta a un endpoint/secreto distinto de SU PROPIO sistema
 * enterprise -- por eso `pushTask()` recibe el `OutboundTaskDestination` como argumento
 * explícito en cada llamada en vez de leerlo de `process.env` una sola vez para todo el
 * proceso (ver `apps/api/src/lib/resolveOutboundTaskSyncPort.ts` para cómo se resuelve
 * la clase del adaptador, y `packages/agent-core/src/tools/outboundTaskSync.ts` para
 * cómo se resuelve la fila de configuración de cada hotel).
 */
import { z } from "zod";
import type { AdapterStatus } from "@atiende-hoteles/mcp-shared";

// ---------------------------------------------------------------------------
// Tipo de tarea saliente -- exactamente las 3 entidades locales que REQ pide
// enganchar (housekeeping_task/maintenance_ticket/guest_ticket).
// ---------------------------------------------------------------------------
export const outboundTaskTypes = ["housekeeping_task", "maintenance_ticket", "guest_ticket"] as const;
export const OutboundTaskType = z.enum(outboundTaskTypes);
export type OutboundTaskType = z.infer<typeof OutboundTaskType>;

/** Destino de un hotel concreto -- URL del webhook de SU sistema + secreto compartido
 *  para la firma HMAC saliente (ver `signOutboundHmac` en el adaptador real). Nunca un
 *  secreto global: cada hotel de la cadena tiene el suyo (`hotel_pms_outbound_config`,
 *  packages/db/migrations/0129_hotel_pms_outbound_config.sql). */
export const OutboundTaskDestination = z.object({
  url: z.string().url(),
  secret: z.string().min(16),
});
export type OutboundTaskDestination = z.infer<typeof OutboundTaskDestination>;

/** Payload que de verdad se envía (serializado a JSON en el cuerpo del POST). Campos
 *  mínimos y genéricos -- ningún nombre de columna interno de este repo se filtra tal
 *  cual (p.ej. `taskId` es el UUID de negocio, no una referencia a `public.*`). */
export const OutboundTask = z.object({
  /** Único por (hotel, tarea) -- misma clave que Stripe/Meta usan para que el receptor
   *  deduplique reintentos (RFC de idempotencia de webhooks saliente estándar): la
   *  responsabilidad de deduplicar un reintento vive en el RECEPTOR (el sistema del
   *  hotel), este adaptador nunca guarda su propio historial de entregas. */
  idempotencyKey: z.string().min(1),
  taskType: OutboundTaskType,
  taskId: z.string().min(1),
  hotelId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: z.enum(["alta", "media", "baja"]),
  roomCode: z.string().max(20).nullable().optional(),
  department: z.string().max(60).nullable().optional(),
  status: z.string().min(1).max(40),
  /** ISO-8601 -- momento en que la tarea se creó/cambió de estado en el sistema local. */
  occurredAt: z.string().min(1),
});
export type OutboundTask = z.infer<typeof OutboundTask>;

export const OutboundTaskSyncResult = z.object({
  /** `true` solo si el sistema del hotel respondió 2xx. */
  delivered: z.boolean(),
  /** `true` cuando el llamador decidió NO intentar el envío (p.ej. el hotel no tiene
   *  este tipo de tarea habilitado) -- nunca junto con `delivered: true`. */
  skipped: z.boolean().default(false),
  reason: z.string().optional(),
  /** Id que el sistema del hotel haya devuelto para esta tarea, si su contrato lo expone. */
  externalTaskId: z.string().optional(),
  statusCode: z.number().optional(),
});
export type OutboundTaskSyncResult = z.infer<typeof OutboundTaskSyncResult>;

/**
 * No hay credenciales GLOBALES que revisar (a diferencia de `PaymentProviderPort`): la
 * disponibilidad real depende de si CADA hotel configuró su propio destino, algo que
 * `status()` no puede responder sin un `hotelId` -- por eso `status()` aquí solo
 * describe si el mecanismo de envío en sí está activo en este proceso (ver
 * `resolveOutboundTaskSyncPort()`), nunca si un hotel en particular está conectado.
 */
export interface OutboundTaskSyncPort {
  status(): AdapterStatus;
  pushTask(destination: OutboundTaskDestination, task: OutboundTask): Promise<OutboundTaskSyncResult>;
}

/** No-2xx del sistema del hotel (después de agotar reintentos ante 429). Nunca se traga
 *  el detalle -- el llamador (best-effort, ver `outboundTaskSync.ts` de agent-core)
 *  decide si loguearlo y seguir. */
export class OutboundDeliveryError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`conector outbound: HTTP ${status} de ${url}: ${body.slice(0, 300)}`);
    this.name = "OutboundDeliveryError";
  }
}
