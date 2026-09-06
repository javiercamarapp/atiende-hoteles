// ToolContext resuelto en servidor (ADR-006): org_id/hotel_id/actor/role/request_id/budget
// SIEMPRE vienen de la sesion autenticada del servidor, nunca de un argumento generado por
// el modelo. buildContext() implementa el aislamiento de contexto entre tenants exigido por
// REQ-AGT-022/GOB-025 (distinto y complementario al RLS de base de datos, REQ-TEN-001).

import { CrossTenantContextError } from "./errors.ts";
import type { RunBudget } from "./budget.ts";

/**
 * Debe alinearse con `public.hotel_role` (packages/db/migrations/0003_membership_and_rls_helpers.sql,
 * REQ-TEN-003): 8 roles hoteleros exactos. Copia local intencional — agent-core no importa
 * codigo de packages/db en este hito (H6a es nucleo puro sin dependencias externas al paquete),
 * solo replica el contrato de nombres para que ambos lados no diverjan en silencio.
 */
export type StaffRole =
  | "owner"
  | "gm"
  | "frontdesk"
  | "reservations"
  | "housekeeping"
  | "maintenance"
  | "fnb"
  | "accountant";

export type ActorType = "staff" | "guest" | "system";

export interface AgentActor {
  readonly type: ActorType;
  readonly id: string;
  readonly staffRole?: StaffRole;
}

/** Lo que la capa de sesion del servidor ya resolvio antes de invocar al agente. */
export interface ServerSession {
  readonly orgId: string;
  readonly hotelId: string;
  readonly actor: AgentActor;
  readonly requestId: string;
}

/**
 * Contexto que reciben las tools en `run(ctx, input)`. Nunca se construye a partir de
 * datos que el modelo proponga: siempre a partir de `ServerSession` + el `RunBudget` de
 * la corrida en curso.
 */
export interface ToolContext {
  readonly orgId: string;
  readonly hotelId: string;
  readonly actor: AgentActor;
  readonly requestId: string;
  readonly budget: RunBudget;
}

export function buildToolContext(session: ServerSession, budget: RunBudget): ToolContext {
  if (!session.orgId || !session.hotelId || !session.requestId || !session.actor?.id) {
    throw new Error(
      "ServerSession incompleta: orgId, hotelId, requestId y actor.id son obligatorios para construir un ToolContext",
    );
  }
  return {
    orgId: session.orgId,
    hotelId: session.hotelId,
    actor: session.actor,
    requestId: session.requestId,
    budget,
  };
}

export type ContextScope = "hotel" | "public";

/** Un fragmento candidato a entrar al prompt de sistema/contexto del agente. */
export interface ContextFragment {
  /** Ignorado cuando scope === "public"; obligatorio y verificado cuando scope === "hotel". */
  readonly tenantId: string;
  readonly scope: ContextScope;
  readonly label: string;
  readonly content: string;
}

/**
 * Arma el contexto de una invocacion exclusivamente con datos del hotel/tenant en curso y
 * hechos publicos (REQ-AGT-022, GOB-025). Cualquier fragmento con scope="hotel" cuyo
 * tenantId no coincida con `hotelId` se RECHAZA lanzando `CrossTenantContextError`
 * (fail-closed): nunca se filtra en silencio sin dejar rastro, porque una fuga de contexto
 * entre hoteles es, segun docs/auditoria/RUBROS.md, el eje de seguridad propio de este
 * producto. Este control es independiente del aislamiento por RLS a nivel de base de datos
 * (REQ-TEN-001/ADR-003/004): uno protege la fila en Postgres, el otro protege lo que
 * efectivamente entra al prompt del LLM.
 */
export function buildContext(hotelId: string, fragments: readonly ContextFragment[]): string[] {
  const allowed: string[] = [];
  for (const fragment of fragments) {
    if (fragment.scope === "public") {
      allowed.push(fragment.content);
      continue;
    }
    if (fragment.tenantId !== hotelId) {
      throw new CrossTenantContextError(fragment.tenantId, hotelId, fragment.label);
    }
    allowed.push(fragment.content);
  }
  return allowed;
}
