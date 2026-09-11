// Trazabilidad (ADR-008/REQ-AGT-006): cada paso del AgentRunner emite un
// AgentTraceEvent listo para audit_log, sin PII (los campos de texto libre deben pasar
// por redact() antes de emitirse). InMemoryCostLedger es el contador de costo por hotel
// (REQ-AGT-020).
//
// REQ-AGT-007 (H19-011/OBS): "toda decisión de un agente que afecte económica o
// legalmente al huésped (p.ej. negar reembolso, aplicar cargo) debe quedar trazable/
// explicable, con registro de la regla/prompt que la originó, verificable ante el
// huésped y ante la autoridad". `toolInput`/`promptVersion` son los dos campos que
// cierran ese gap: antes de este cambio, el `tool_call` de una tool `effect="money"`
// (el único marcador que este catálogo usa para "acción con valor económico", mismo
// criterio que REQ-AGT-003) solo dejaba `message` (el `result.summary` de la propia
// tool, p.ej. "Gasto autorizado") en `audit_log` -- sin el INPUT real que el modelo
// propuso (monto, folio, lo que sea que decidió cobrar/negar) ni QUÉ prompt/versión de
// las instrucciones del agente estaba vigente cuando se tomó esa decisión, ninguna de
// las dos partes ("qué se decidió" y "bajo qué regla") quedaba reconstruible desde el
// registro -- solo el resultado final, sin el "por qué" ni el "con qué datos".
import { createHash } from "node:crypto";
import type { ToolEffect } from "./tool.ts";
import type { AgentGate } from "./roles.ts";

export type AgentTraceKind =
  | "run_started"
  | "llm_call"
  | "tool_call"
  | "tool_skipped_shadow"
  | "approval_requested"
  | "loop_guard"
  | "budget_exceeded"
  | "provider_fallback"
  | "error"
  /** REQ-AGT-003: el ROIEvent de una tool effect="money" ejecutada con exito quedo
   * persistido (ver runner.ts `recordRoiEventForMoneyTool`). */
  | "roi_event_recorded"
  /** REQ-AGT-003: una tool effect="money" se ejecuto con exito pero su ROIEvent NO se
   * pudo derivar/persistir -- la corrida se cierra `roi_event_faltante` justo despues. */
  | "roi_event_faltante"
  /** Patrón Likida/atiende.ai #4: `close()` (runner.ts) reemplazó el `closingMessage`
   * porque mencionaba precio/tarifa/disponibilidad sin que ninguna tool ya ejecutada
   * en esta corrida lo respaldara (`priceHallucinationGuard.ts`) -- el huésped nunca
   * recibió la cifra inventada; esta traza es la evidencia de que se bloqueó. */
  | "price_hallucination_blocked"
  /** Patrón Likida/atiende.ai #7: `close()` (runner.ts) reemplazó el `closingMessage`
   * ("nunca termina sin preguntar") porque un agente con
   * `completionStatusToolName` configurado intentó cerrar "completado" sin evidencia
   * (vía esa tool) de que sus pasos obligatorios ya están completos
   * (`completionStatusGuard.ts`). */
  | "completion_status_blocked"
  | "run_finished";

export interface AgentTraceEvent {
  readonly runId: string;
  readonly orgId: string;
  readonly hotelId: string;
  readonly requestId: string;
  readonly step: number;
  readonly kind: AgentTraceKind;
  /** ISO 8601. */
  readonly at: string;
  readonly modelSlug?: string;
  readonly toolName?: string;
  readonly effect?: ToolEffect;
  readonly gate?: AgentGate;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costUsd?: number;
  /** Texto libre YA redactado (ver redact.ts): nunca PII cruda. */
  readonly message?: string;
  /** REQ-AGT-007: input REAL (ya validado por Zod) con el que se ejecutó una decisión
   * económica/legal de agente (`tool.effect === "money"`), redactado -- MISMO formato
   * que `describeApprovalInput()` (runner.ts) ya usa para que el aprobador humano vea
   * "monto, folio, lo que sea" antes de autorizar (GOB-026); aquí es lo que permite
   * reconstruir DESPUÉS, desde el registro, exactamente qué pidió el agente. Solo se
   * puebla en el `tool_call` de una tool económica -- nunca en tools `read`/`write`/
   * `external` sin valor económico, para no inflar cada fila de `audit_log` con datos
   * que ese criterio no exige. */
  readonly toolInput?: string;
  /** REQ-AGT-007: hash determinista (`computeSystemPromptVersion`) del `systemPrompt`
   * vigente para el agente al momento de esta decisión -- el registro de "la regla/
   * prompt que la originó" que el criterio exige. Verificable ante el huésped/autoridad:
   * quien audite puede tomar el `systemPrompt` real del código en esa fecha (versionado
   * en git, `agents.ts`) y recalcular el mismo hash para confirmar que es EXACTAMENTE el
   * texto que produjo la decisión, sin tener que confiar en una descripción de la regla
   * escrita a mano que pudiera desactualizarse. Mismo alcance que `toolInput`: solo en
   * el `tool_call` de una tool económica. */
  readonly promptVersion?: string;
}

/** REQ-AGT-007: hash canónico (sha256, hex completo) del `systemPrompt` de un agente --
 * el "registro de la regla/prompt que originó" una decisión económica/legal exige poder
 * identificar, sin ambigüedad, EXACTAMENTE qué texto de instrucciones estaba vigente.
 * Un hash (en vez de guardar el prompt completo en cada fila de `audit_log`, que ya
 * queda una sola vez por agente en el código fuente versionado) es lo mínimo verificable:
 * dos corridas con el mismo `systemPrompt` byte-a-byte producen el mismo
 * `promptVersion`, y cualquier cambio de una sola letra en el prompt (una nueva "regla")
 * produce un hash distinto -- reconstruible por cualquiera que tenga el texto real del
 * prompt (el propio hotel, o una autoridad con acceso al código fuente en esa fecha),
 * sin depender de un número de versión que alguien tenga que recordar incrementar a mano. */
export function computeSystemPromptVersion(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex");
}

export interface CostLedger {
  registrar(hotelId: string, modelSlug: string, usd: number): void;
  totalPorHotel(hotelId: string): number;
  detallePorHotel(hotelId: string): Record<string, number>;
}

/** Contador de costo por hotel en memoria (REQ-AGT-020: presupuesto/costo explicito por
 * agente, medido y comparable contra la banda estimada). */
export class InMemoryCostLedger implements CostLedger {
  private readonly byHotel = new Map<string, Map<string, number>>();

  registrar(hotelId: string, modelSlug: string, usd: number): void {
    let perModel = this.byHotel.get(hotelId);
    if (!perModel) {
      perModel = new Map();
      this.byHotel.set(hotelId, perModel);
    }
    perModel.set(modelSlug, (perModel.get(modelSlug) ?? 0) + usd);
  }

  totalPorHotel(hotelId: string): number {
    const perModel = this.byHotel.get(hotelId);
    if (!perModel) return 0;
    return [...perModel.values()].reduce((total, value) => total + value, 0);
  }

  detallePorHotel(hotelId: string): Record<string, number> {
    const perModel = this.byHotel.get(hotelId);
    return perModel ? Object.fromEntries(perModel) : {};
  }
}
