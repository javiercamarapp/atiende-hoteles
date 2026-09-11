// Trazabilidad (ADR-008/REQ-AGT-006): cada paso del AgentRunner emite un
// AgentTraceEvent listo para audit_log, sin PII (los campos de texto libre deben pasar
// por redact() antes de emitirse). InMemoryCostLedger es el contador de costo por hotel
// (REQ-AGT-020).

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
