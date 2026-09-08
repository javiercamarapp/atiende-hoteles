// REQ-AGT-001/GOB-026: registro de auditoria de una tool con efecto externo. Envuelve
// `record_audit_log()` (packages/db/migrations/0008_audit_log.sql -- append-only, hash
// encadenado, SECURITY DEFINER) con el payload que exige el criterio de aceptacion:
// timestamp (columna `created_at`, la pone el propio trigger de la tabla, nunca el
// llamador), agente (quien disparo la tool: tipo+id del `AgentActor` del `ToolContext`,
// nunca inventado) y valor anterior/nuevo (estado del recurso antes y despues de la
// operacion, tal cual lo trae cada tool -- este modulo no interpreta el dominio).
//
// Mismo patron que ya usa `apps/api/src/routes/agentes.ts` (payload.agente) para las
// trazas paso a paso del AgentRunner, pero reutilizable desde cualquier tool de dominio en
// vez de repetir el `JSON.stringify` inline en cada una. `actor_user_id` (columna nativa
// de `audit_log`, resuelta por `auth.uid()` dentro de `record_audit_log()`) NO alcanza para
// identificar al agente aqui: el actor de una tool puede ser "system"/"guest", que no
// corresponde a una sesion de Supabase Auth real -- por eso el agente va en el payload,
// igual que agentes.ts.

import type { SqlClient } from "./sql.ts";
import type { AgentActor } from "./context.ts";

export interface RecordToolAuditParams {
  readonly db: SqlClient;
  readonly orgId: string;
  readonly hotelId: string;
  /** Quien disparo la tool -- SIEMPRE `ToolContext.actor` (resuelto por el servidor),
   * nunca un valor que el modelo proponga. */
  readonly actor: AgentActor;
  /** Nombre de la tool (`ToolDefinition.name`) que causo el cambio. */
  readonly toolName: string;
  /** Accion legible para audit_log, convencion `dominio.evento` (ver agentes.ts/reservas.ts). */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /** Estado del recurso ANTES de la operacion (`null` si es una creacion). */
  readonly before: unknown;
  /** Estado del recurso DESPUES de la operacion. */
  readonly after: unknown;
}

/**
 * Inserta una fila en `audit_log` via `record_audit_log()`. No devuelve la fila: el
 * llamador que necesite verificarla (p.ej. una prueba) la relee de `audit_log` -- mismo
 * patron que `tests/unit/audit-log.spec.ts` -- para no depender de que el `SqlClient`
 * concreto soporte expansion de tipo compuesto (`(fn()).*`) en todos los motores.
 */
export async function recordToolAudit(params: RecordToolAuditParams): Promise<void> {
  const payload = {
    agente: {
      toolName: params.toolName,
      actorType: params.actor.type,
      actorId: params.actor.id,
    },
    valorAnterior: params.before ?? null,
    valorNuevo: params.after ?? null,
  };
  await params.db.query("select public.record_audit_log($1, $2, $3, $4, $5, $6::jsonb);", [
    params.orgId,
    params.hotelId,
    params.action,
    params.entityType,
    params.entityId,
    JSON.stringify(payload),
  ]);
}
