// H6b/REQ-UX-006 · lógica compartida de "decidir una aprobación pendiente y, si queda
// aprobada, ejecutar la tool de dominio correspondiente" -- extraída de
// routes/aprobaciones.ts (endpoint autenticado del panel web) para que
// routes/aprobacionesWhatsapp.ts (webhook de botón de WhatsApp, REQ-UX-006: "sin
// requerir acceso al panel web") ejecute EXACTAMENTE la misma lógica de negocio,
// nunca una copia que pueda divergir.
import type { DbClient } from "@atiende-hoteles/db";
import { ApprovalError, PostgresApprovalQueue, buildToolContext, createRunBudget, getAgentDefinition } from "@atiende-hoteles/agent-core";
import { buildToolExecutors } from "./agentTools.ts";
import { sharedWhatsappAdapter } from "./messaging.ts";
import { ApiError, Errors } from "./errors.ts";
import { costoDelMes, resolveAgentConfig } from "../routes/agentes.ts";

/** `AgentRunner`/`runner.ts` construye `requestedBy` como
 *  `agent:<agentName>:<actorId>` para toda solicitud de aprobación que sale de una
 *  corrida real -- es el único registro de qué agente originó esta aprobación (el
 *  esquema de `agent_approval` no tiene una columna `agent_name` propia). */
function agentNameFromRequestedBy(requestedBy: string): string | undefined {
  const match = /^agent:([^:]+):/.exec(requestedBy);
  return match?.[1];
}

export interface DecidirAprobacionParams {
  db: DbClient;
  hotelId: string;
  approvalId: string;
  actor: string;
  role?: string;
  decision: "aprobar" | "rechazar";
  textoExacto: string;
  requestId: string;
}

export interface DecidirAprobacionResultado {
  id: string;
  estado: string;
  ejecutado: boolean;
  summary?: unknown;
}

export async function decidirYEjecutarAprobacion(params: DecidirAprobacionParams): Promise<DecidirAprobacionResultado> {
  const approvalQueue = new PostgresApprovalQueue(params.db);
  let decided;
  try {
    decided = await approvalQueue.decide({
      approvalId: params.approvalId,
      actor: params.actor,
      role: params.role,
      decision: params.decision,
      textoExacto: params.textoExacto,
    });
  } catch (err) {
    if (err instanceof ApprovalError) throw new ApiError(409, "approval_invalid", err.message);
    throw err;
  }
  if (decided.hotelId !== params.hotelId) throw Errors.notFound("Solicitud de aprobación no encontrada.");

  if (decided.status !== "aprobada") {
    return { id: decided.id, estado: decided.status, ejecutado: false };
  }

  // A2 (auditoria-2 agentico CRÍTICO): la ejecución DIFERIDA de una aprobación (este
  // ejecutor corre fuera de una corrida en vivo de AgentRunner, potencialmente minutos
  // después de que se pidió la aprobación) debe re-comprobar el gate vigente del
  // agente justo antes de ejecutar -- el único lugar donde `shadow`/`propone`/
  // `autopilot` se hacía cumplir era dentro de AgentRunner.run(), en el momento en que
  // la tool SE SOLICITA, nunca en el momento en que SE EJECUTA. Un gerente que baja el
  // agente a `shadow` como freno de emergencia (p.ej. sospecha de un ticket
  // fabricado) no tenía ninguna garantía de que una aprobación ya en la cola se
  // detuviera -- se ejecutaba igual, exactamente como si el gate siguiera en
  // `autopilot`. También se re-comprueba el presupuesto mensual del agente: si ya se
  // agotó desde que se pidió la aprobación, tampoco se ejecuta "gratis".
  //
  // Solo aplica cuando la aprobación de verdad la originó un AGENTE (`requestedBy`
  // con el prefijo `agent:<agentName>:...` que usa `runner.ts`) -- una aprobación que
  // un STAFF pidió directamente por una ruta de negocio (p.ej.
  // `POST /mantenimiento/:id/cerrar-con-costo`, `requestedBy: "staff:<userId>:..."`)
  // no tiene ningún agente/gate que gobierne su ejecución, así que no aplica este
  // freno -- solo GOB-026 (doble confirmación), ya cubierto por `decide()`.
  const agentName = agentNameFromRequestedBy(decided.requestedBy);
  if (agentName) {
    const agentDef = getAgentDefinition(agentName);
    if (agentDef) {
      const agentConfig = await resolveAgentConfig(params.db, decided.hotelId, agentDef);
      if (agentConfig.gate === "shadow") {
        return { id: decided.id, estado: "bloqueada_por_gate_shadow", ejecutado: false };
      }
      const consumido = await costoDelMes(params.db, decided.hotelId, agentName);
      if (consumido >= agentConfig.monthlyCeilingUsd) {
        return { id: decided.id, estado: "bloqueada_por_presupuesto_agotado", ejecutado: false };
      }
    }
  }

  // A4 (auditoria-2): reclamación atómica -- si esta aprobación ya se ejecutó antes
  // (por `AgentRunner` en una corrida en vivo, o por una llamada anterior/concurrente
  // a este mismo ejecutor, p.ej. panel web y botón de WhatsApp casi simultáneos),
  // `markExecuted()` devuelve `false` y NUNCA se vuelve a correr la tool.
  const puedeEjecutar = await approvalQueue.markExecuted(decided.id);
  if (!puedeEjecutar) {
    return { id: decided.id, estado: decided.status, ejecutado: false };
  }

  const storedInput = await approvalQueue.getStoredInput(decided.id);
  const executors = buildToolExecutors({ db: params.db, messaging: sharedWhatsappAdapter, simulated: true });
  const tool = executors[decided.toolName];
  if (!tool) {
    throw Errors.internal(`No hay ejecutor registrado para la tool "${decided.toolName}" (aprobación ${decided.id}).`);
  }
  const parsed = tool.inputSchema.safeParse(storedInput);
  if (!parsed.success) {
    throw Errors.internal(`El input almacenado para la aprobación ${decided.id} ya no es válido contra la tool.`);
  }

  const ctx = buildToolContext(
    { orgId: decided.orgId, hotelId: decided.hotelId, actor: { type: "staff", id: params.actor }, requestId: params.requestId },
    createRunBudget({}),
  );
  const result = await tool.run(ctx, parsed.data);

  return { id: decided.id, estado: decided.status, ejecutado: true, summary: result.summary };
}
