// Enganche generico "best-effort" del conector outbound PMS-enterprise
// (`@atiende-hoteles/mcp-outbound` `OutboundTaskSyncPort`/`OutboundTaskSyncGateway`) a la
// creacion de housekeeping_task/maintenance_ticket/guest_ticket (housekeepingTools.ts,
// ticketTools.ts). Mismo criterio estructural que `WhatsappSenderLike`
// (messagingTools.ts): `OutboundTaskSyncLike` es un tipo ESTRUCTURAL, agent-core NO
// importa `@atiende-hoteles/mcp-outbound` (H6a, nucleo sin dependencias externas al
// paquete) -- `OutboundTaskSyncGateway` de ese paquete la cumple sin adaptador.
//
// Best-effort a proposito: este backend es la CAPA DE ENTRADA para hoteles de cadena que
// YA operan su propio sistema de gestion de tareas (HotSOS/Optii-style, ver
// docs/integraciones/conector-pms-enterprise.md) -- la fuente de verdad LOCAL
// (housekeeping_task/maintenance_ticket/guest_ticket, ya insertada ANTES de llamar aqui)
// nunca depende de que el push saliente tenga exito. Un fallo de red/HTTP hacia el
// sistema del hotel NUNCA revierte ni bloquea la creacion local de la tarea -- se
// captura, se refleja en el resultado de la tool (`data.outboundSync`) para
// observabilidad, y la tool sigue reportando `ok:true` igual.

export const outboundTaskTypes = ["housekeeping_task", "maintenance_ticket", "guest_ticket"] as const;

/** Payload minimo que las tools de creacion arman -- espejo estructural de
 *  `OutboundTask` (mcp-outbound `port.ts`), sin importar ese paquete. */
export interface OutboundTaskPush {
  readonly taskType: (typeof outboundTaskTypes)[number];
  readonly taskId: string;
  readonly hotelId: string;
  readonly title: string;
  readonly description?: string;
  readonly priority: "alta" | "media" | "baja";
  readonly roomCode?: string | null;
  readonly department?: string | null;
  readonly status: string;
  readonly occurredAt: string;
  /** Unico por (hotel, tarea) -- si se omite, se deriva de `taskType:taskId` (ver
   *  `buildOutboundIdempotencyKey`). */
  readonly idempotencyKey?: string;
}

export interface OutboundTaskSyncResultLike {
  readonly delivered: boolean;
  readonly skipped?: boolean;
  readonly reason?: string;
  readonly externalTaskId?: string;
}

/** Forma minima de `OutboundTaskSyncGateway`/`OutboundTaskSyncPort`
 *  (`@atiende-hoteles/mcp-outbound`) que estas tools necesitan. */
export interface OutboundTaskSyncLike {
  syncTask(task: OutboundTaskPush & { idempotencyKey: string }): Promise<OutboundTaskSyncResultLike | null>;
}

export function buildOutboundIdempotencyKey(task: Pick<OutboundTaskPush, "taskType" | "taskId">): string {
  return `${task.taskType}:${task.taskId}`;
}

/** Llama a `outboundSync.syncTask()` si hay una dependencia inyectada -- `undefined`
 *  (el caso comun, ver comentario de archivo) no hace nada. Nunca lanza: cualquier error
 *  inesperado del propio `outboundSync` (aunque ya deberia capturar los suyos,
 *  `OutboundTaskSyncGateway` lo hace) se atrapa aqui tambien, como ultima linea de
 *  defensa -- esta funcion es la unica que las 3 tools de creacion llaman, asi que un
 *  fallo de esta pieza NUNCA debe poder tumbar la creacion local de la tarea. */
export async function syncTaskToOutboundConnectorBestEffort(
  outboundSync: OutboundTaskSyncLike | undefined,
  task: OutboundTaskPush,
): Promise<OutboundTaskSyncResultLike | null> {
  if (!outboundSync) return null;
  const idempotencyKey = task.idempotencyKey ?? buildOutboundIdempotencyKey(task);
  try {
    return await outboundSync.syncTask({ ...task, idempotencyKey });
  } catch (err) {
    return { delivered: false, skipped: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
