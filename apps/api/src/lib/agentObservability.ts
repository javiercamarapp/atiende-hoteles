// REQ-AGT-006 (GOB-035): "PII debe redactarse ANTES de persistir cualquier traza de
// observabilidad de agentes". `agent-core` (runner.ts) ya redacta cada
// `AgentTraceEvent.message` en el punto de EMISIÓN (`redact()` antes de cada `emit()`),
// pero este módulo es el punto real de PERSISTENCIA (lo que `apps/api/src/routes/
// agentes.ts` inserta en `audit_log`/`agent_run`) -- defensa en profundidad: si algún
// `onTrace` futuro, o una rama nueva de `AgentRunner.close()`, alguna vez emitiera/
// devolviera texto sin pasar por `redact()`, esta es la ÚLTIMA barrera antes de que ese
// texto quede grabado de forma permanente (append-only) en una traza de observabilidad.
//
// Gap real que este módulo cierra (encontrado releyendo el código, no documentado antes
// en ACEPTACION.md/TRAZABILIDAD.md como excepción): `AgentRunner.close()` (runner.ts)
// SÍ redacta el mensaje de cierre para el evento `run_finished` que va a `audit_log`
// (`this.emit(..., { message: redact(closingMessage) })`), pero el `AgentRunResult.
// message` que RETORNA (la misma `closingMessage`, sin redactar) es el valor que
// `apps/api/src/routes/agentes.ts` insertaba TAL CUAL en la columna `agent_run.message`
// -- un texto de cierre que puede citar de vuelta un dato del huésped que el modelo trae
// en contexto (p.ej. "confirmado a tu correo juan@ejemplo.com") se persistía en esa
// tabla sin pasar nunca por `redact()`. `persistAgentRunSummary()` de abajo es ahora el
// ÚNICO punto de INSERT a `agent_run.message` y aplica `redact()` ahí. El valor SIN
// redactar sigue siendo lo que la ruta devuelve en la respuesta HTTP (`mensaje: result.
// message`) -- eso no es "persistir una traza de observabilidad", es la respuesta viva
// al actor (staff/huésped) que disparó la corrida, que necesita leer el dato real.
//
// REQ-AGT-007 (H19-011/OBS): `event.toolInput`/`event.promptVersion` (agent-core
// `trace.ts`, poblados por `AgentRunner` SOLO en el `tool_call` de una tool
// económica/legal -- `effect==="money"` o `isPriceOrEmission`) se persisten aquí bajo
// `inputHerramienta`/`versionPrompt` -- son el "registro de la regla/prompt que la
// originó" que el criterio de aceptación exige poder reconstruir desde `audit_log`, sin
// tener que reproducir la corrida ni confiar en la memoria de quien la ejecutó.
import { redact, type AgentTraceEvent } from "@atiende-hoteles/agent-core";
import type { DbClient } from "@atiende-hoteles/db";

export interface PersistAgentTraceEventsParams {
  readonly db: DbClient;
  readonly orgId: string;
  readonly hotelId: string;
  readonly agentName: string;
  readonly events: readonly AgentTraceEvent[];
}

/**
 * Inserta cada `AgentTraceEvent` de una corrida como una fila de `audit_log` (vía
 * `record_audit_log()`), EN ORDEN (la cadena de hash de esa función depende del orden de
 * inserción). Debe llamarse dentro de la MISMA transacción por-request que el INSERT de
 * `agent_run` (`persistAgentRunSummary`) que sigue, para que "agent_run + audit_log
 * encadenado" sea atómico frente a cualquier error a mitad de camino.
 */
export async function persistAgentTraceEvents(params: PersistAgentTraceEventsParams): Promise<void> {
  for (const event of params.events) {
    await params.db.query("select public.record_audit_log($1, $2, $3, $4, $5, $6::jsonb);", [
      params.orgId,
      params.hotelId,
      `agente.${event.kind}`,
      "agent_run",
      null,
      JSON.stringify({
        agente: params.agentName,
        runId: event.runId,
        paso: event.step,
        modelo: event.modelSlug,
        tool: event.toolName,
        efecto: event.effect,
        gate: event.gate,
        tokensEntrada: event.tokensIn,
        tokensSalida: event.tokensOut,
        costoUsd: event.costUsd,
        // Defensa en profundidad (ver comentario de archivo): redact() otra vez aquí,
        // aunque agent-core `runner.ts` ya debió haberlo hecho antes de `emit()`.
        mensaje: event.message === undefined ? undefined : redact(event.message),
        // REQ-AGT-007: input real (ya redactado por `describeApprovalInput` en
        // agent-core) y hash del `systemPrompt` vigente -- solo presentes en el
        // `tool_call` de una tool económica/legal (ver comentario de archivo). Defensa
        // en profundidad igual que `mensaje`: si `event.toolInput` trajera PII sin pasar
        // por `redact()` en agent-core, se redacta otra vez aquí antes del INSERT.
        inputHerramienta: event.toolInput === undefined ? undefined : redact(event.toolInput),
        versionPrompt: event.promptVersion,
      }),
    ]);
  }
}

export interface PersistAgentRunSummaryParams {
  readonly db: DbClient;
  readonly runId: string;
  readonly orgId: string;
  readonly hotelId: string;
  readonly agentName: string;
  readonly modelRole: string;
  readonly providerId: string;
  readonly modelSlug: string;
  readonly gate: string;
  readonly status: string;
  readonly steps: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
  readonly requestId: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly durationMs: number;
  /** Mensaje de cierre YA seguro para el humano/huésped (`AgentRunResult.message`),
   * CRUDO -- sin redactar todavía. Esta función es la que aplica `redact()` antes de
   * persistirlo en `agent_run.message` (REQ-AGT-006); el llamador debe seguir usando el
   * valor original SIN redactar para la respuesta HTTP -- ver comentario de archivo. */
  readonly message: string;
}

/**
 * Inserta el resumen agregado de una corrida completa de `AgentRunner` en `agent_run`
 * (REQ-AGT-020: costo/steps/duración totales por corrida, base del techo mensual por
 * hotel/agente). `message` se redacta AQUÍ, justo antes del INSERT -- ver comentario de
 * archivo para el gap real que este punto único de escritura cierra.
 */
export async function persistAgentRunSummary(params: PersistAgentRunSummaryParams): Promise<void> {
  await params.db.query(
    `insert into public.agent_run
       (run_id, org_id, hotel_id, agent_name, model_role, provider_id, model_slug, gate, status,
        steps, tokens_in, tokens_out, cost_usd, request_id, actor_type, actor_id, duration_ms, message)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18);`,
    [
      params.runId,
      params.orgId,
      params.hotelId,
      params.agentName,
      params.modelRole,
      params.providerId,
      params.modelSlug,
      params.gate,
      params.status,
      params.steps,
      params.tokensIn,
      params.tokensOut,
      params.costUsd,
      params.requestId,
      params.actorType,
      params.actorId,
      params.durationMs,
      redact(params.message),
    ],
  );
}
