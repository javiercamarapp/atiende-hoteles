/**
 * Patrón Likida/atiende.ai #7 ("onboarding conversacional con guardas deterministas --
 * nunca termina sin preguntar"): mecanismo GENÉRICO (no específico de un agente,
 * configurado como DATOS en `AgentRunnerOptions.completionStatusToolName`, mismo
 * criterio ADR-006 "agentes como datos" que evita una rama `if (agentName === x)`
 * dispersa en `runner.ts`) para que un agente que necesita varios pasos obligatorios
 * antes de darse por terminado (hoy: `onboarding_conversacional`, agents.ts) NUNCA
 * cierre "completado" sin, primero, haber verificado con una tool `effect="read"`
 * dedicada que todo lo obligatorio ya está capturado.
 *
 * Vive junto a `priceHallucinationGuard.ts` (mismo paquete, mismo motivo: agent-core
 * sigue sin depender de domain-hotel, H6a) y usa el MISMO punto de integración en
 * `close()` (runner.ts): el `result.data` de cada tool ejecutada esta corrida, no solo
 * su `summary` de texto libre -- más robusto que parsear texto (mismo criterio que
 * `priceHallucinationGuard.ts` usa comparación de dígitos en vez de comparar prosa).
 */

export interface CompletionStatusResult {
  readonly completo: boolean;
  readonly camposFaltantes?: readonly string[];
}

export interface ToolResultRecord {
  readonly toolName: string;
  readonly summary: string;
  readonly data: unknown;
}

/** Mensaje de seguimiento fijo (nunca generado por el modelo) cuando NINGUNA llamada a
 *  la tool de estado ocurrió esta corrida -- el agente intentó cerrar sin siquiera
 *  verificar. Más genérico que el de "faltan campos" porque aquí no se sabe cuáles. */
export const COMPLETION_STATUS_UNKNOWN_MESSAGE =
  "Antes de terminar necesito confirmar que toda la información quedó registrada -- dame un momento para revisarlo contigo.";

function isCompletionStatusResult(value: unknown): value is CompletionStatusResult {
  return typeof value === "object" && value !== null && "completo" in value && typeof (value as { completo: unknown }).completo === "boolean";
}

export interface EnforceCompletionStatusResult {
  readonly message: string;
  readonly blocked: boolean;
  readonly camposFaltantes: readonly string[];
}

/**
 * `status` es `AgentRunStatus` (runner.ts) -- se recibe como `string` aquí para no
 * crear un ciclo de import entre este módulo y `runner.ts`; el único valor relevante es
 * `"completado"` (cualquier otro status ya tiene su propio mensaje de cierre explícito
 * y NUNCA lo genera el modelo libremente, así que no necesita este guard).
 */
export function enforceCompletionStatusBeforeClosing(
  message: string,
  status: string,
  toolResults: readonly ToolResultRecord[],
  completionStatusToolName: string | undefined,
): EnforceCompletionStatusResult {
  if (!completionStatusToolName || status !== "completado") {
    return { message, blocked: false, camposFaltantes: [] };
  }

  // Última llamada a la tool de estado esta corrida (si el agente la llamó más de una
  // vez, p.ej. verificó, guardó un campo, y volvió a verificar -- la más reciente es la
  // que refleja el estado real al momento de cerrar).
  const last = [...toolResults].reverse().find((r) => r.toolName === completionStatusToolName);

  if (!last || !isCompletionStatusResult(last.data)) {
    // Nunca se llamó (o la tool no devolvió el shape esperado): no hay evidencia de que
    // el onboarding esté completo -- fail-closed, se bloquea igual que si faltaran campos.
    return { message: COMPLETION_STATUS_UNKNOWN_MESSAGE, blocked: true, camposFaltantes: [] };
  }

  if (last.data.completo) {
    return { message, blocked: false, camposFaltantes: [] };
  }

  const camposFaltantes = last.data.camposFaltantes ?? [];
  const pregunta =
    camposFaltantes.length > 0
      ? `Antes de terminar necesito confirmar: ${camposFaltantes.join("; ")}. ¿Seguimos con eso?`
      : COMPLETION_STATUS_UNKNOWN_MESSAGE;
  return { message: pregunta, blocked: true, camposFaltantes };
}
