// REQ-REV-003 (P0/GOB, fuentes BP-053/BP-054/BP-056/H02-003/H07-007/BP-016): el motor
// de revenue (recomendación/ejecución de tarifas BAR — distinto del agente LLM
// `auditor_nocturno` de packages/agent-core, que solo narra el cierre) debe operar en
// "shadow" (solo registra lo que habría hecho, nunca ejecuta) un MÍNIMO de 90 días,
// exigir un backtest walk-forward (walkForwardBacktest.ts) que demuestre mejora vs.
// baseline antes de poder habilitar "autopilot", pasar entretanto a "propone y ejecuta"
// (cada cambio de tarifa requiere aprobación — puede reutilizarse el adaptador de
// mensajería ya simulado de REQ-UX-006, `apps/api/src/lib/aprobacionEjecutor.ts` /
// `PostgresApprovalQueue` — este módulo NO reimplementa esa cola, solo decide si un
// cambio propuesto es elegible) con un límite de variación de ±10-15% hasta que se
// habilite el autopilot pleno.
//
// Espejo de aplicación de la máquina de estados REAL que exige la base de datos
// (`packages/db/migrations/0082_revenue_engine_gate.sql`), mismo criterio que
// `reservationStateMachine.ts` frente a `0006_reservation.sql`: la autoridad final es
// el trigger de Postgres (nadie puede saltarse esta regla escribiendo SQL a mano fuera
// de la aplicación); este módulo permite validar/explicar una transición ANTES de un
// round-trip a la base y sirve de referencia única para cualquier UI/CLI que quiera
// mostrar por qué una promoción está bloqueada.
//
// Vocabulario compartido con `packages/agent-core/src/roles.ts` (`AgentGate` = mismos 3
// nombres) por diseño — es el mismo concepto de gobierno (BP-016) aplicado a dos
// superficies distintas (un agente LLM vs. este motor determinista de tarifas) — pero
// domain-hotel NUNCA importa de agent-core (capas separadas, ver README de cada
// paquete): este archivo define su propio tipo en vez de depender de aquel.
import type { WalkForwardBacktestResult } from "./walkForwardBacktest.ts";

export type RevenueGateState = "shadow" | "propone" | "autopilot";

export const REVENUE_GATE_STATES: readonly RevenueGateState[] = ["shadow", "propone", "autopilot"];

/** REQ-REV-003: "un mínimo de 90 días" en shadow antes de poder pasar a "propone". */
export const MIN_SHADOW_DAYS = 90;

/** REQ-REV-003: "límite de variación (±10-15%)" mientras el gate es "propone". El
 *  valor exacto dentro de esa banda es configurable por hotel (columna
 *  `revenue_engine_gate.propone_max_variation_pct`, acotada por un CHECK idéntico a
 *  estas constantes) — nunca fuera de [10, 15]. */
export const PROPONE_VARIATION_PCT_MIN = 10;
export const PROPONE_VARIATION_PCT_MAX = 15;

export class RevenueGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevenueGateError";
  }
}

const GATE_ORDER: Readonly<Record<RevenueGateState, number>> = { shadow: 0, propone: 1, autopilot: 2 };

/** Días completos transcurridos desde `since` hasta `now` (piso, nunca redondeado hacia
 *  arriba — "van 89 días" no debe leerse como "ya se cumplieron 90"). */
export function daysElapsed(since: Date, now: Date = new Date()): number {
  const ms = now.getTime() - since.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

export function hasMetMinimumShadowPeriod(shadowStartedAt: Date, now: Date = new Date()): boolean {
  return daysElapsed(shadowStartedAt, now) >= MIN_SHADOW_DAYS;
}

/** Promoción = avanzar exactamente un escalón (shadow->propone o propone->autopilot).
 *  Nunca hay promoción de más de un escalón (shadow->autopilot directo, prohibido). */
export function isPromotion(from: RevenueGateState, to: RevenueGateState): boolean {
  return GATE_ORDER[to] === GATE_ORDER[from] + 1;
}

/** Democión = retroceder a un gate más conservador — el "freno de emergencia" (mismo
 *  criterio documentado en `apps/api/src/lib/aprobacionEjecutor.ts`: un gerente que baja
 *  un agente a shadow porque sospecha algo no necesita pedirle permiso a nadie).
 *  SIEMPRE permitida, sin ninguna de las condiciones de abajo. */
export function isDemotion(from: RevenueGateState, to: RevenueGateState): boolean {
  return GATE_ORDER[to] < GATE_ORDER[from];
}

export interface PromotionContext {
  /** Momento en que el hotel entró (o volvió a entrar tras una democión) en shadow —
   *  requerido para evaluar shadow -> propone. */
  readonly shadowStartedAt?: Date;
  /** Momento en que el hotel entró (o volvió a entrar tras una democión) en propone —
   *  requerido para evaluar propone -> autopilot (el backtest debe ser posterior). */
  readonly proponeStartedAt?: Date;
  readonly now?: Date;
  /** Resultado del backtest walk-forward más reciente — requerido para propone ->
   *  autopilot (REQ-REV-003: "backtesting walk-forward obligatorio"). */
  readonly backtest?: WalkForwardBacktestResult;
  /** Fecha en que se corrió ese backtest — debe ser posterior a `proponeStartedAt`
   *  (un backtest de antes de entrar en modo propone no certifica el desempeño real de
   *  "propone y ejecuta", solo el de shadow). */
  readonly backtestRanAt?: Date;
  /** REQ-GOB-012 (`founder_reserved_category.shadow_a_autopilot_revenue`, migración
   *  0081): el paso de revenue de shadow a autopilot es una decisión reservada al
   *  fundador — este flag representa si esa aprobación YA existe y está vigente. La
   *  base de datos (`require_founder_decision_approval`) es la autoridad real; este
   *  módulo solo puede reflejar lo que el llamador ya verificó. */
  readonly founderApprovalGranted?: boolean;
}

export interface GateTransitionEvaluation {
  readonly allowed: boolean;
  /** Vacío cuando `allowed` es `true`. Cada razón es un código estable (prefijo antes
   *  de ":") seguido de una explicación en español, mismo estilo que los mensajes de
   *  excepción de las migraciones de este repo. */
  readonly reasons: readonly string[];
}

const ALLOWED = { allowed: true, reasons: [] } as const;

/**
 * Evalúa si la transición `from -> to` es válida AHORA MISMO dado el contexto. Nunca
 * lanza — devuelve las razones de bloqueo para que quien llama pueda mostrarlas (panel
 * web, CLI, o el propio mensaje de error del trigger de Postgres, que replica estas
 * mismas reglas — ver 0082_revenue_engine_gate.sql).
 */
export function evaluateGateTransition(
  from: RevenueGateState,
  to: RevenueGateState,
  ctx: PromotionContext = {},
): GateTransitionEvaluation {
  if (from === to) return ALLOWED;
  if (isDemotion(from, to)) return ALLOWED;

  if (!isPromotion(from, to)) {
    return {
      allowed: false,
      reasons: [`transicion_no_permitida: no se puede pasar directamente de "${from}" a "${to}" (REQ-REV-003 exige pasar por "propone")`],
    };
  }

  const now = ctx.now ?? new Date();
  const reasons: string[] = [];

  if (from === "shadow" /* && to === "propone" */) {
    if (!ctx.shadowStartedAt) {
      reasons.push("shadow_started_at_faltante: no se puede evaluar el mínimo de 90 días sin saber cuándo empezó el shadow");
    } else if (!hasMetMinimumShadowPeriod(ctx.shadowStartedAt, now)) {
      reasons.push(
        `shadow_insuficiente: se requieren ${MIN_SHADOW_DAYS} días en shadow antes de pasar a "propone" (REQ-REV-003), van ${daysElapsed(ctx.shadowStartedAt, now)}`,
      );
    }
  }

  if (from === "propone" /* && to === "autopilot" */) {
    if (!ctx.backtest) {
      reasons.push("backtest_faltante: no se proporcionó un backtest walk-forward (REQ-REV-003 lo exige antes de habilitar autopilot)");
    } else if (!ctx.backtest.passes) {
      reasons.push(
        `backtest_no_supera_baseline: el backtest walk-forward no demuestra mejora suficiente vs. baseline (${ctx.backtest.failureReasons.join("; ") || "sin detalle"})`,
      );
    } else if (ctx.proponeStartedAt && ctx.backtestRanAt && ctx.backtestRanAt < ctx.proponeStartedAt) {
      reasons.push("backtest_obsoleto: el backtest walk-forward disponible es anterior a que este hotel entrara en modo \"propone\"");
    }
    if (!ctx.founderApprovalGranted) {
      reasons.push(
        'aprobacion_fundador_requerida: REQ-GOB-012 ("paso de revenue de shadow a autopilot") exige una aprobación registrada y vigente del fundador',
      );
    }
  }

  return reasons.length === 0 ? ALLOWED : { allowed: false, reasons };
}

/** REQ-REV-003: el límite de variación configurado para "propone" debe estar dentro de
 *  la banda ±10-15% — nunca 0 (eso sería "no propone nada"), nunca >15% (dejaría de ser
 *  un límite conservador de transición). */
export function assertValidProponeVariationPct(pct: number): void {
  if (!Number.isFinite(pct) || pct < PROPONE_VARIATION_PCT_MIN || pct > PROPONE_VARIATION_PCT_MAX) {
    throw new RevenueGateError(
      `variacion_invalida: el límite de variación en modo "propone" debe estar entre ${PROPONE_VARIATION_PCT_MIN}% y ${PROPONE_VARIATION_PCT_MAX}% (REQ-REV-003), recibido ${pct}`,
    );
  }
}

/** ¿El cambio de `baselinePrice` a `proposedPrice` cabe dentro de `maxVariationPct`? */
export function isPriceChangeWithinProponeLimit(baselinePrice: number, proposedPrice: number, maxVariationPct: number): boolean {
  if (!Number.isFinite(baselinePrice) || baselinePrice <= 0) {
    throw new RevenueGateError("baseline_invalido: el precio baseline debe ser un número positivo");
  }
  if (!Number.isFinite(proposedPrice) || proposedPrice < 0) {
    throw new RevenueGateError("precio_propuesto_invalido: el precio propuesto debe ser un número no negativo");
  }
  assertValidProponeVariationPct(maxVariationPct);
  const variationPct = (Math.abs(proposedPrice - baselinePrice) / baselinePrice) * 100;
  // Épsilon para tolerar error de punto flotante en la frontera exacta (ej. 15.000000001).
  return variationPct <= maxVariationPct + 1e-9;
}

export interface RevenueProposalCheck {
  /** "shadow" nunca requiere aprobación porque nunca ejecuta nada. */
  readonly requiresApproval: boolean;
  readonly withinVariationLimit: boolean;
  /** Verdadero solo si el gate permite ejecutar ESTE cambio concreto — no implica que
   *  ya esté aprobado: en "propone" sigue faltando el paso real de aprobación (fuera de
   *  este módulo, ver `aprobacionEjecutor.ts`/REQ-UX-006). */
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

/**
 * Decide si una propuesta de cambio de tarifa concreta es elegible para ejecutarse dado
 * el gate vigente del motor. No sustituye la cola de aprobaciones (`agent_approval` +
 * `PostgresApprovalQueue`, REQ-UX-006) — solo aplica las dos reglas de REQ-REV-003 que
 * son propias del motor de revenue: (a) en "shadow" nunca se ejecuta nada, solo se
 * registra; (b) en "propone" el cambio debe caer dentro del límite de variación vigente
 * y de todos modos requiere aprobación humana antes de ejecutarse.
 */
export function evaluateRevenueProposal(
  gate: RevenueGateState,
  params: { readonly baselinePrice: number; readonly proposedPrice: number; readonly maxVariationPct: number },
): RevenueProposalCheck {
  if (gate === "shadow") {
    return {
      requiresApproval: false,
      withinVariationLimit: true,
      allowed: false,
      reasons: ['modo_shadow: el motor solo registra lo que habría hecho (REQ-REV-003), nunca ejecuta un cambio de tarifa'],
    };
  }

  if (gate === "propone") {
    const within = isPriceChangeWithinProponeLimit(params.baselinePrice, params.proposedPrice, params.maxVariationPct);
    return {
      requiresApproval: true,
      withinVariationLimit: within,
      allowed: within,
      reasons: within
        ? []
        : [`variacion_excede_limite: el cambio propuesto excede el límite de ±${params.maxVariationPct}% vigente en modo "propone"`],
    };
  }

  // autopilot pleno: sin límite de variación ni aprobación por cambio individual —
  // exactamente lo que REQ-REV-003 llama "autopilot pleno" (fin de la fase gateada).
  return { requiresApproval: false, withinVariationLimit: true, allowed: true, reasons: [] };
}
