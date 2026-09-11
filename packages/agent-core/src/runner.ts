// AgentRunner: bucle de tool-calling con loop-guard, presupuesto, fallback de proveedor
// y salida siempre cerrada hacia el humano (ADR-006, patron Likida `generateWithTools`
// en docs/referencia/06-backoffice-agentes-likida.md §2.6). Ninguna rama de este bucle
// termina en silencio: toda salida es un AgentRunResult con `status` y `message`
// explicitos.

import { randomUUID } from "node:crypto";
import type { ToolContext } from "./context.ts";
import { type ToolDefinition, type ToolRegistry, type ToolResult, type RoiEventDraft } from "./tool.ts";
import type { ApprovalQueue } from "./approval.ts";
import { hashApprovalInput } from "./approval.ts";
import {
  ProviderTransientError,
  type LlmCompletion,
  type LlmMessage,
  type LlmProvider,
} from "./provider.ts";
import { ProviderUnavailableError } from "./errors.ts";
import type { AgentGate } from "./roles.ts";
import type { AgentTraceEvent, CostLedger } from "./trace.ts";
import { estimateCostUsd, type PricingTable } from "./pricing.ts";
import { maskPhoneFieldsForApproval, redact } from "./redact.ts";
import { sanitizeClosingMessage } from "./priceHallucinationGuard.ts";
import { enforceCompletionStatusBeforeClosing, type ToolResultRecord } from "./completionStatusGuard.ts";

/** REQ-AGT-003 (H17-001/GOB-037): quien persiste, del lado del llamador (apps/api, con
 * acceso a Postgres -- agent-core sigue sin depender de un motor de BD concreto, H6a),
 * el `ROIEvent` que una tool `effect="money"` produjo de su propia ejecucion. Debe
 * RECHAZAR la promesa si no pudo persistir -- `AgentRunner` trata cualquier rechazo
 * como cobertura faltante (`roi_event_faltante`), nunca como una ejecucion
 * silenciosamente sin registrar. Ver `tools/roiTools.ts` `createPostgresRoiEventRecorder`
 * para la implementacion real contra `public.roi_event` (migracion 0026). */
export interface RoiEventRecorder {
  record(ctx: ToolContext, agentName: string, draft: RoiEventDraft): Promise<void>;
}

export interface AgentRunnerOptions {
  readonly agentName: string;
  readonly provider: LlmProvider;
  readonly fallbackProvider?: LlmProvider;
  readonly tools: ToolRegistry;
  readonly approvalQueue: ApprovalQueue;
  readonly systemPrompt: string;
  readonly modelSlug: string;
  readonly temperature: number;
  /** MEDIO (auditoria-2 agentico): REQ-AGT-005/REQ-AGT-016 -- effort del modelo para
   * esta corrida, típicamente `roleParamsForChannel(role, canal).effort` (roles.ts)
   * resuelto por el llamador (apps/api) desde el canal real de la conversación
   * (voz/texto). Se reenvía tal cual a `LlmProvider.complete()` en cada llamada. */
  readonly effort?: "low" | "medium" | "high";
  /** Techo duro de rondas (loop-guard). */
  readonly maxSteps: number;
  readonly maxOutputTokensPerCall?: number;
  readonly pricing: PricingTable;
  readonly gate: AgentGate;
  /** Tools cuyo resultado no vuelve al modelo (Likida §2.6 `terminalTools`): son las
   * unicas que se permiten ejecutar en la ultima ronda del loop-guard. */
  readonly terminalToolNames?: readonly string[];
  /** Ventana de llamadas (tool+input) recientes que el loop-guard recuerda para detectar
   * una repeticion NO inmediata (con otra tool intercalada) -- default 5 (aud-1
   * tool-calling.md ALTO #2: antes solo se comparaba contra la ULTIMA llamada). */
  readonly loopGuardWindow?: number;
  /** REQ-HUE-006/GOB-034: texto de disclosure ("soy un asistente de IA...") que se
   * antepone al mensaje de cierre cuando `ctx.isFirstTurn` es true -- el humano/huesped
   * debe saber, desde el primer turno, que quien responde es un agente de IA. Mecanismo
   * minimo dentro de agent-core (aud-1 agentico.md ALTO); la deteccion de "es el primer
   * turno de ESTA conversacion" vive fuera de este paquete (session/API), que resuelve
   * `ServerSession.isFirstTurn`. */
  readonly disclosureMessage?: string;
  readonly costLedger?: CostLedger;
  readonly onTrace?: (event: AgentTraceEvent) => void;
  /** REQ-AGT-003: quien persiste el `ROIEvent` de cada tool `effect="money"` que se
   * ejecuta con exito en esta corrida. Opcional a nivel de tipos (una corrida sin
   * ninguna tool de dinero registrada no lo necesita), pero en la practica obligatorio
   * para cualquier corrida cuyo catalogo incluya una tool `money` -- sin el, esa tool
   * SIGUE pudiendo ejecutarse (la mutacion real ya ocurrio, `AgentRunner` no la revierte),
   * pero la corrida se cierra explicitamente `roi_event_faltante` en vez de reportar
   * exito sin cobertura de ROI. */
  readonly roiEventRecorder?: RoiEventRecorder;
  /** Patrón Likida/atiende.ai #7 ("nunca termina sin preguntar"): nombre de una tool
   * `effect="read"` cuyo `ToolResult.data` (shape `{completo, camposFaltantes?}`, ver
   * `completionStatusGuard.ts`) decide si esta corrida puede cerrar "completado" tal
   * cual. Sin esta tool llamada esta corrida, o llamada con `completo !== true`, el
   * mensaje de cierre se reemplaza por una pregunta de seguimiento fija -- nunca se
   * cierra en silencio dando por completado algo que no lo está. Config por agente
   * (agents.ts), NO una rama especial por nombre de agente en este archivo -- cualquier
   * agente futuro con el mismo requisito reutiliza el mismo mecanismo. `undefined`: sin
   * este requisito (comportamiento actual, todos los demás agentes). */
  readonly completionStatusToolName?: string;
}

export type AgentRunStatus =
  | "completado"
  | "esperando_aprobacion"
  /** Una tool con needsApproval fue RECHAZADA por un humano: estado terminal explicito,
   * nunca se reporta como "esperando_aprobacion" (aud-1 tool-calling.md ALTO #4). */
  | "accion_rechazada"
  | "agotado_pasos"
  | "presupuesto_agotado"
  | "no_configurado"
  | "error_proveedor"
  /** El modelo propuso mas de una tool effect="money" en la misma ronda: REQ-AGT-004
   * exige que el core nunca permita decidir dos acciones de dinero a la vez (aud-1
   * agentico.md ALTO #4). */
  | "paralelismo_dinero_bloqueado"
  /** REQ-AGT-003 (H17-001/GOB-037): una tool `effect="money"` se ejecuto con
   * `result.ok===true` (valor economico real, ya materializado -- esta corrida NO lo
   * revierte) pero su `ROIEvent` no se pudo derivar/persistir (falta `deriveRoiEvent`,
   * devolvio `null`, no hay `roiEventRecorder` configurado, o la persistencia fallo).
   * Fail-closed explicito: nunca se reporta "completado" cuando la cobertura de ROI de
   * el 100% de las acciones economicas, sin excepcion, no quedo garantizada. */
  | "roi_event_faltante"
  | "truncado";

export interface AgentRunResult {
  readonly status: AgentRunStatus;
  readonly runId: string;
  readonly finalText: string | null;
  readonly steps: number;
  readonly pendingApprovalIds: string[];
  /** Mensaje SIEMPRE cerrado hacia el humano: nunca "se trabo" en silencio. */
  readonly message: string;
}

function sortKeysForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysForDisplay);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysForDisplay(record[key])]),
    );
  }
  return value;
}

/** Resumen legible del input REAL validado por Zod que recibio la tool, para que el
 * aprobador humano (GOB-026) sepa exactamente que esta autorizando -- monto, folio,
 * cualquier dato de negocio que traiga `parsed.data` -- nunca solo el nombre de la tool.
 * Redactado (nunca PII cruda en lo que se persiste como `textoExacto`/`audit_log`) --
 * EXCEPTO el telefono destinatario (T1, auditoria-2 tool-calling CRITICO): `redact()`
 * a ciegas sobre el JSON completo convertia `guestPhone` en "[TARJETA]"/"[TEL]",
 * dejando al aprobador SIN forma de detectar un destinatario equivocado -- el propio
 * dato que este mecanismo existe para que el humano pueda verificar. Un campo cuyo
 * NOMBRE indica que es un telefono destinatario (`guestPhone` y variantes,
 * `maskPhoneFieldsForApproval`) se enmascara PARCIALMENTE (ultimos 4 digitos
 * visibles) ANTES de la redaccion ciega, en vez de ocultarse por completo. */
function describeApprovalInput(input: unknown): string {
  if (input === null || input === undefined) {
    return "(sin datos adicionales del modelo)";
  }
  if (typeof input === "object" && Object.keys(input as object).length === 0) {
    // Patron Likida properties:{} (ADR-006): el input esta vacio a proposito, los
    // identificadores reales vienen del ToolContext de la conversacion en curso.
    return "(sin datos en el input; los identificadores vienen del contexto de la conversacion en curso)";
  }
  return redact(JSON.stringify(sortKeysForDisplay(maskPhoneFieldsForApproval(input))));
}

export class AgentRunner {
  // H6b: campo explicito en vez del azucar de "parameter property" (`constructor(private
  // readonly options: ...)`) -- ese azucar NO esta soportado por el modo "strip types" de
  // Node (`node --experimental-strip-types`, el runtime real de apps/api,
  // ver apps/api/package.json "dev"/"start"): con el azucar, CUALQUIER import de
  // `@atiende-hoteles/agent-core` en tiempo de ejecucion (incluso de una sola tool)
  // tumbaba el proceso completo con `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` al cargar este
  // modulo. Mismo comportamiento, sintaxis compatible.
  private readonly options: AgentRunnerOptions;

  // Patrones Likida/atiende.ai #4 y #7: `{toolName, summary, data}` de CADA tool
  // ejecutada en la corrida EN CURSO -- la única fuente que `close()` acepta como (a)
  // respaldo de una cifra de precio/disponibilidad que el modelo mencione en su mensaje
  // de cierre (`priceHallucinationGuard.ts`, usa `.summary`) y (b) evidencia de que un
  // agente con pasos obligatorios (p.ej. `onboarding_conversacional`) de verdad verificó
  // su estado antes de cerrar (`completionStatusGuard.ts`, usa `.data`). Campo de
  // instancia (no local a `run()`) para que `close()` -- un metodo PRIVADO SEPARADO, sin
  // acceso a las variables locales de `run()` -- pueda leerlo sin cambiar la firma de
  // sus 13 puntos de llamada. Seguro porque cada `AgentRunner` se construye NUEVO por
  // request (ver unico sitio real de construccion, apps/api/src/routes/agentes.ts) --
  // nunca se reusa entre corridas concurrentes; se reinicia al inicio de `run()` de
  // todos modos por si alguna vez se reutiliza la misma instancia dos veces.
  private toolResultsThisRun: ToolResultRecord[] = [];

  constructor(options: AgentRunnerOptions) {
    this.options = options;
  }

  async run(ctx: ToolContext, userMessage: string): Promise<AgentRunResult> {
    const opts = this.options;
    const runId = randomUUID();
    const messages: LlmMessage[] = [{ role: "user", content: userMessage }];
    const pendingApprovalIds: string[] = [];
    const terminal = new Set(opts.terminalToolNames ?? []);
    this.toolResultsThisRun = [];

    let activeProvider = opts.provider;
    let usedFallback = false;
    // aud-1 tool-calling.md ALTO #2: ventana de las ultimas N firmas tool+input (no solo
    // la ULTIMA) para detectar una repeticion no inmediata (con otra tool intercalada).
    const recentToolSignatures: string[] = [];
    const loopGuardWindow = Math.max(1, opts.loopGuardWindow ?? 5);
    let step = 0;

    this.emit(ctx, runId, 0, "run_started", {});

    while (step < opts.maxSteps) {
      if (ctx.budget.agotado()) {
        this.emit(ctx, runId, step, "budget_exceeded", {});
        return this.close(
          ctx,
          runId,
          step,
          "presupuesto_agotado",
          null,
          pendingApprovalIds,
          "El presupuesto (tokens/tiempo/costo) de esta corrida se agoto antes de terminar; " +
            "se detiene para que un humano revise, no se sigue en silencio.",
        );
      }

      const isLastRound = step === opts.maxSteps - 1;

      let completion: LlmCompletion;
      try {
        completion = await activeProvider.complete({
          modelSlug: opts.modelSlug,
          system: opts.systemPrompt,
          messages,
          toolNames: opts.tools.list().map((tool) => tool.name),
          temperature: opts.temperature,
          effort: opts.effort,
          maxOutputTokens: opts.maxOutputTokensPerCall ?? 1024,
          // REQ-AGT-004 / aud-1 agentico.md ALTO: nunca se le pide al proveedor que
          // decida en paralelo dos (o mas) tool calls en la misma respuesta.
          disableParallelToolUse: true,
        });
      } catch (err) {
        if (err instanceof ProviderTransientError && !usedFallback && opts.fallbackProvider) {
          usedFallback = true;
          activeProvider = opts.fallbackProvider;
          this.emit(ctx, runId, step, "provider_fallback", { message: redact(err.message) });
          continue; // reintenta la MISMA ronda con el fallback; ninguna tool ya ejecutada se repite
        }
        if (err instanceof ProviderUnavailableError) {
          this.emit(ctx, runId, step, "error", { message: redact(err.message) });
          return this.close(ctx, runId, step, "no_configurado", null, pendingApprovalIds, err.message);
        }
        // aud-1 tool-calling.md MEDIO #6: `AgentRunResult.message` es "SIEMPRE cerrado
        // hacia el humano" (puede reenviarse tal cual a un huesped por WhatsApp/voz) --
        // NUNCA debe llevar detalle interno de implementacion (nombre de variable de
        // entorno, numero de hito, nombre de paquete). El detalle tecnico completo SI
        // queda en la traza (`redact(err.message)`, ya emitida abajo), solo no en el
        // mensaje de cierre. `ProviderNotImplementedError`/`ProviderTransientError` (sin
        // fallback) y cualquier otro error de proveedor comparten el mismo mensaje
        // generico y seguro.
        this.emit(ctx, runId, step, "error", { message: redact((err as Error).message) });
        return this.close(
          ctx,
          runId,
          step,
          "error_proveedor",
          null,
          pendingApprovalIds,
          "El proveedor de modelo no esta disponible o su integracion no esta completa en " +
            "este entorno; se cierra explicitamente para que un humano revise (el detalle " +
            "tecnico queda solo en la traza interna, nunca en este mensaje).",
        );
      }

      const costUsd = estimateCostUsd(
        opts.pricing,
        completion.modelSlug,
        completion.usage.inputTokens,
        completion.usage.outputTokens,
      );
      ctx.budget.registrarTokens(completion.usage.inputTokens, completion.usage.outputTokens);
      ctx.budget.registrarCostoUsd(costUsd);
      opts.costLedger?.registrar(ctx.hotelId, completion.modelSlug, costUsd);
      this.emit(ctx, runId, step, "llm_call", {
        modelSlug: completion.modelSlug,
        tokensIn: completion.usage.inputTokens,
        tokensOut: completion.usage.outputTokens,
        costUsd,
      });

      if (completion.truncated) {
        this.emit(ctx, runId, step, "error", { message: "respuesta truncada por limite de tokens" });
        return this.close(
          ctx,
          runId,
          step,
          "truncado",
          completion.text,
          pendingApprovalIds,
          "La respuesta del modelo se trunco antes de terminar; se trata como error " +
            "explicito, nunca se usa una respuesta parcial como si fuera completa.",
        );
      }

      if (completion.toolCalls.length === 0) {
        return this.close(ctx, runId, step + 1, "completado", completion.text, pendingApprovalIds, completion.text ?? "");
      }

      // aud-1 agentico.md MEDIO: el presupuesto se comprobaba solo al TOPE del while (antes
      // de la llamada al proveedor), nunca DESPUES de contabilizar el costo real de la
      // respuesta que se acaba de recibir -- una ronda que rebasaba el techo todavia
      // ejecutaba su(s) tool call(s) "gratis", y el cierre honesto ("presupuesto_agotado")
      // solo llegaba en la ronda SIGUIENTE. Se comprueba de nuevo aqui, ANTES de ejecutar
      // cualquier tool de esta ronda (de lectura o de escritura).
      if (ctx.budget.agotado()) {
        this.emit(ctx, runId, step, "budget_exceeded", {
          message: "presupuesto agotado tras contabilizar el costo real de esta ronda",
        });
        return this.close(
          ctx,
          runId,
          step + 1,
          "presupuesto_agotado",
          null,
          pendingApprovalIds,
          "El presupuesto se agoto justo despues de esta llamada; se detiene antes de " +
            "ejecutar la(s) tool(s) que trajo, no se ejecuta ninguna mutacion de mas.",
        );
      }

      // aud-1 agentico.md ALTO: REQ-AGT-004 exige que el nucleo nunca deje que el modelo
      // decida en paralelo dos (o mas) acciones de dinero en una sola generacion. Se pide
      // `disableParallelToolUse: true` al proveedor arriba, pero eso depende de que el
      // proveedor real lo honre -- este es el guardarraiz de refuerzo DENTRO del core: si
      // pese a todo la respuesta trae mas de una tool effect="money", NINGUNA se ejecuta.
      const moneyCallCount = completion.toolCalls.filter(
        (call) => opts.tools.get(call.name)?.effect === "money",
      ).length;
      if (moneyCallCount > 1) {
        this.emit(ctx, runId, step, "loop_guard", {
          message: `el modelo propuso ${moneyCallCount} tools effect="money" en la misma ronda (REQ-AGT-004)`,
        });
        return this.close(
          ctx,
          runId,
          step + 1,
          "paralelismo_dinero_bloqueado",
          null,
          pendingApprovalIds,
          "El modelo propuso mas de una accion de dinero en la misma respuesta; ninguna se " +
            "ejecuta -- REQ-AGT-004 exige decidir las acciones de dinero de una en una.",
        );
      }

      const hayTerminalDisponible = completion.toolCalls.some((call) => terminal.has(call.name));
      if (isLastRound && !hayTerminalDisponible) {
        // Loop-guard (Likida §2.6): corta ANTES de ejecutar el Promise.all de tool
        // calls -- no se paga una mutacion mas por un resultado que nadie va a leer.
        this.emit(ctx, runId, step, "loop_guard", { message: "ultima ronda sin tools terminales disponibles" });
        return this.close(
          ctx,
          runId,
          step + 1,
          "agotado_pasos",
          null,
          pendingApprovalIds,
          "Se alcanzo el maximo de pasos sin una tool terminal disponible; se detiene " +
            "antes de ejecutar una mutacion mas, no se sigue intentando en silencio.",
        );
      }

      const toolResultMessages: LlmMessage[] = [];
      for (const call of completion.toolCalls) {
        if (isLastRound && !terminal.has(call.name)) {
          toolResultMessages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: "ultima ronda: tool no terminal omitida por loop-guard",
          });
          continue;
        }

        const tool = opts.tools.get(call.name);
        if (!tool) {
          toolResultMessages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: "tool desconocida" });
          continue;
        }

        // aud-1 agentico.md ALTO #4: la firma del loop-guard se calcula sobre el input YA
        // VALIDADO/COERCIONADO por Zod (`parsed.data`), no sobre `call.input` crudo del
        // modelo -- `{habitacion: 204}` y `{habitacion: "204"}` deben producir la MISMA
        // firma cuando el schema los coerciona al mismo valor (tipos normalizados);
        // `hashApprovalInput` ya ordena claves de forma canonica.
        const parsed = tool.inputSchema.safeParse(call.input);
        if (!parsed.success) {
          toolResultMessages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: "entrada invalida para la tool",
          });
          continue;
        }

        const signature = `${call.name}::${hashApprovalInput(parsed.data)}`;
        if (recentToolSignatures.includes(signature)) {
          this.emit(ctx, runId, step, "loop_guard", {
            toolName: call.name,
            message: `repeticion de la misma tool+input dentro de la ventana de ${loopGuardWindow} llamadas`,
          });
          return this.close(
            ctx,
            runId,
            step + 1,
            "agotado_pasos",
            null,
            pendingApprovalIds,
            "El agente repitio la misma herramienta con el mismo argumento sin avanzar; " +
              "se detiene (loop-guard) en vez de seguir gastando presupuesto.",
          );
        }
        recentToolSignatures.push(signature);
        if (recentToolSignatures.length > loopGuardWindow) {
          recentToolSignatures.shift();
        }

        if (tool.effect !== "read" && opts.gate === "shadow") {
          this.emit(ctx, runId, step, "tool_skipped_shadow", {
            toolName: call.name,
            effect: tool.effect,
            gate: opts.gate,
          });
          toolResultMessages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: "modo shadow: accion registrada pero NO ejecutada",
          });
          continue;
        }

        if (tool.needsApproval && !tool.alwaysApprove) {
          // aud-1 tool-calling.md CRITICO #2: el aprobador no puede firmar a ciegas --
          // textoMostrado/inputSummary DEBEN incluir el input real (monto, folio, lo que
          // traiga `parsed.data`), redactado, no solo el nombre de la tool y el hotel.
          const inputSummary = describeApprovalInput(parsed.data);
          const approval = await opts.approvalQueue.request({
            toolName: tool.name,
            input: parsed.data,
            orgId: ctx.orgId,
            hotelId: ctx.hotelId,
            // T2 (auditoria-2 tool-calling CRÍTICO): cuando la corrida tiene un
            // huésped vinculado (`ctx.guestPhone`, resuelto por la capa de sesión
            // desde la reserva/conversación real -- NUNCA del modelo), se codifica
            // aquí para que `createTransactionalTemplateApprovalQueue`
            // (messagingTools.ts) pueda verificar que, cuando la plantilla es
            // "transaccional", el destinatario que el modelo puso en el input sea
            // EXACTAMENTE ese huésped -- nunca uno que el modelo haya elegido por su
            // cuenta. Sin huésped vinculado, se usa actor+tipo como antes (sin
            // afectar la idempotencia por requestedBy, solo el prefijo cambia).
            requestedBy: ctx.guestPhone
              ? `agent:${opts.agentName}:guest:${ctx.guestPhone}`
              : `agent:${opts.agentName}:${ctx.actor.type}:${ctx.actor.id}`,
            isMoney: tool.effect === "money",
            textoMostrado:
              `${opts.agentName} solicita ejecutar "${tool.name}" en hotel ${ctx.hotelId} ` +
              `con datos: ${inputSummary}`,
            inputSummary,
          });
          this.emit(ctx, runId, step, "approval_requested", {
            toolName: tool.name,
            effect: tool.effect,
            message: approval.id,
          });
          if (approval.status === "rechazada") {
            // aud-1 tool-calling.md ALTO #4: una solicitud RECHAZADA es un estado
            // TERMINAL, nunca se reporta como "pendiente"/"esperando_aprobacion" -- el
            // humano/huesped recibe el cierre explicito que ADR-006 promete, en vez de
            // quedar atrapado creyendo que todavia se esta esperando una decision que ya
            // se tomo.
            this.emit(ctx, runId, step, "loop_guard", {
              toolName: tool.name,
              message: `solicitud ${approval.id} ya fue rechazada por un humano`,
            });
            return this.close(
              ctx,
              runId,
              step + 1,
              "accion_rechazada",
              null,
              pendingApprovalIds,
              `La accion "${tool.name}" fue rechazada por un humano (solicitud ${approval.id}); ` +
                "no se ejecuta ni se reporta como pendiente.",
            );
          }
          if (approval.status !== "aprobada") {
            pendingApprovalIds.push(approval.id);
            toolResultMessages.push({
              role: "tool",
              toolCallId: call.id,
              toolName: call.name,
              content: `pendiente de aprobacion humana: ${approval.id}`,
            });
            continue;
          }
          // A4 (auditoria-2): `request()` reusa CUALQUIER solicitud vigente por
          // (hotel,tool,hash(input),requestedBy) sin importar su status -- si el
          // modelo propone la MISMA tool+input dentro del TTL (reintento, otro turno
          // de la conversacion), esta rama vuelve a ver `status==="aprobada"` sobre
          // la MISMA fila. `markExecuted()` es la reclamacion atomica: solo la
          // PRIMERA vez que se llama para esta aprobacion devuelve `true`; cualquier
          // llamada posterior (aqui o desde `aprobacionEjecutor.ts` fuera de banda)
          // ve `false` y NUNCA vuelve a ejecutar la tool sin una decision humana
          // nueva.
          const puedeEjecutar = await opts.approvalQueue.markExecuted(approval.id);
          if (!puedeEjecutar) {
            this.emit(ctx, runId, step, "loop_guard", {
              toolName: tool.name,
              message: `solicitud ${approval.id} ya se ejecuto antes; no se repite sin una nueva decision humana`,
            });
            toolResultMessages.push({
              role: "tool",
              toolCallId: call.id,
              toolName: call.name,
              content: `esta accion ya se ejecuto con la aprobacion ${approval.id}; no se repite`,
            });
            continue;
          }
        }

        const result = await tool.run(ctx, parsed.data);
        this.emit(ctx, runId, step, "tool_call", {
          toolName: tool.name,
          effect: tool.effect,
          gate: opts.gate,
          message: redact(result.summary),
        });

        // REQ-AGT-003 (H17-001/GOB-037): toda tool effect="money" que en verdad movio
        // valor economico (result.ok===true) debe dejar su ROIEvent registrado ANTES de
        // que la corrida continue -- nunca depende de que el modelo decida llamar aparte
        // "registrar_evento_roi" (ese camino sigue existiendo para eventos que ninguna
        // tool money produce). Fail-closed: la mutacion real ya ocurrio y esta corrida no
        // la revierte, pero si no se pudo derivar/persistir el ROIEvent, se cierra
        // explicitamente en vez de reportar exito sin esa cobertura.
        if (tool.effect === "money" && result.ok) {
          const roi = await this.recordRoiEventForMoneyTool(ctx, tool, parsed.data, result);
          if (roi.ok) {
            this.emit(ctx, runId, step, "roi_event_recorded", { toolName: tool.name, effect: tool.effect });
          } else {
            this.emit(ctx, runId, step, "roi_event_faltante", {
              toolName: tool.name,
              effect: tool.effect,
              message: roi.reason,
            });
            return this.close(
              ctx,
              runId,
              step + 1,
              "roi_event_faltante",
              null,
              pendingApprovalIds,
              `La accion "${tool.name}" genero valor economico pero no se pudo registrar su ` +
                "ROIEvent asociado (REQ-AGT-003 exige cobertura del 100%, sin excepcion); se " +
                "detiene explicitamente para que un humano revise.",
            );
          }
        }

        toolResultMessages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: result.summary });
        // Patrones Likida/atiende.ai #4 y #7: ver comentario de `toolResultsThisRun`.
        this.toolResultsThisRun.push({ toolName: tool.name, summary: result.summary, data: result.data });
      }

      if (pendingApprovalIds.length > 0) {
        return this.close(
          ctx,
          runId,
          step + 1,
          "esperando_aprobacion",
          null,
          pendingApprovalIds,
          `Esperando aprobacion humana para ${pendingApprovalIds.length} accion(es) antes de continuar.`,
        );
      }

      messages.push({ role: "assistant", content: completion.text ?? "" });
      messages.push(...toolResultMessages);
      step += 1;
    }

    this.emit(ctx, runId, step, "loop_guard", { message: "maximo de pasos alcanzado" });
    return this.close(
      ctx,
      runId,
      step,
      "agotado_pasos",
      null,
      pendingApprovalIds,
      "Se alcanzo el maximo de pasos configurado sin que el agente terminara; se cierra " +
        "explicitamente para que un humano revise la conversacion.",
    );
  }

  private close(
    ctx: ToolContext,
    runId: string,
    steps: number,
    status: AgentRunStatus,
    finalText: string | null,
    pendingApprovalIds: string[],
    message: string,
  ): AgentRunResult {
    // Patrón Likida/atiende.ai #4: `message` (el texto que puede venir directo del
    // modelo, p.ej. `completion.text` en la rama "completado") se verifica ANTES de
    // combinarse con el disclosure -- si menciona precio/tarifa/disponibilidad sin que
    // ninguna tool YA ejecutada en esta corrida lo respalde, se reemplaza por completo
    // (nunca se deja pasar la cifra inventada). El disclosure en sí (texto fijo,
    // `this.options.disclosureMessage`) nunca pasa por este chequeo -- no lo genera el
    // modelo.
    const sanitized = sanitizeClosingMessage(message, this.toolResultsThisRun.map((r) => r.summary));
    if (sanitized.blocked) {
      this.emit(ctx, runId, steps, "price_hallucination_blocked", {
        message: redact(message),
      });
    }

    // Patrón Likida/atiende.ai #7: "nunca termina sin preguntar" -- ver
    // `completionStatusGuard.ts`. Se aplica DESPUÉS del guard de precio (sobre
    // `sanitized.message`, no sobre `message` crudo) para que, si AMBOS guards
    // tuvieran algo que decir, el mensaje final sea siempre el más específico/reciente
    // -- en la práctica los dos guards nunca se activan a la vez (agentes distintos).
    const completionChecked = enforceCompletionStatusBeforeClosing(
      sanitized.message,
      status,
      this.toolResultsThisRun,
      this.options.completionStatusToolName,
    );
    if (completionChecked.blocked) {
      this.emit(ctx, runId, steps, "completion_status_blocked", {
        message: redact(sanitized.message),
      });
    }

    // aud-1 agentico.md ALTO: REQ-HUE-006/GOB-034 exige que el humano/huesped sepa, desde
    // el PRIMER turno de la conversacion, que quien responde es un agente de IA. Se
    // antepone aqui, en el UNICO punto de salida de run(), para que se aplique sin
    // importar como termine la corrida (completado, esperando_aprobacion, error...).
    const closingMessage =
      ctx.isFirstTurn && this.options.disclosureMessage
        ? `${this.options.disclosureMessage} ${completionChecked.message}`.trim()
        : completionChecked.message;
    // aud-1 agentico.md ALTO: `run_finished` estaba DECLARADO en AgentTraceKind pero
    // jamas se emitia -- si el proceso muere justo despues de que run() retorna (antes
    // de que el llamador, fuera de este paquete, persista el AgentRunResult), no quedaba
    // ningun rastro en `onTrace` de como termino la corrida. Se emite aqui, en el UNICO
    // punto de salida de run(), para las 8 ramas de cierre sin excepcion.
    this.emit(ctx, runId, steps, "run_finished", { message: redact(closingMessage) });
    return {
      status,
      runId,
      finalText,
      steps,
      pendingApprovalIds: [...pendingApprovalIds],
      message: closingMessage,
    };
  }

  /** REQ-AGT-003: deriva (via `tool.deriveRoiEvent`) y persiste (via
   * `opts.roiEventRecorder`) el ROIEvent de UNA ejecucion concreta de una tool
   * effect="money" que ya termino `result.ok===true`. Nunca lanza -- cualquier motivo
   * de no-cobertura (falta la funcion, devuelve null, no hay recorder, la persistencia
   * rechaza) se devuelve como `{ ok: false, reason }` para que el llamador decida el
   * cierre explicito de la corrida (fail-closed), en vez de propagar una excepcion sin
   * `AgentRunResult`. */
  private async recordRoiEventForMoneyTool(
    ctx: ToolContext,
    tool: ToolDefinition,
    input: unknown,
    result: ToolResult,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const opts = this.options;
    if (typeof tool.deriveRoiEvent !== "function") {
      return { ok: false, reason: `la tool "${tool.name}" (effect="money") no declara deriveRoiEvent` };
    }
    let draft: RoiEventDraft | null;
    try {
      draft = tool.deriveRoiEvent(ctx, input, result);
    } catch (err) {
      return { ok: false, reason: `deriveRoiEvent de "${tool.name}" lanzo: ${redact((err as Error).message)}` };
    }
    if (!draft) {
      return { ok: false, reason: `la tool "${tool.name}" no produjo un ROIEvent para esta ejecucion` };
    }
    if (!opts.roiEventRecorder) {
      return { ok: false, reason: "no hay un RoiEventRecorder configurado en esta corrida" };
    }
    try {
      await opts.roiEventRecorder.record(ctx, opts.agentName, draft);
    } catch (err) {
      return { ok: false, reason: redact((err as Error).message) };
    }
    return { ok: true };
  }

  private emit(
    ctx: ToolContext,
    runId: string,
    step: number,
    kind: AgentTraceEvent["kind"],
    extra: Partial<AgentTraceEvent>,
  ): void {
    this.options.onTrace?.({
      runId,
      orgId: ctx.orgId,
      hotelId: ctx.hotelId,
      requestId: ctx.requestId,
      step,
      kind,
      at: new Date().toISOString(),
      ...extra,
    });
  }
}
