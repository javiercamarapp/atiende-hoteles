// H4 · REQ-RES-004: política de cancelación/depósito estructurada en los 4 puntos
// citados por el encargo (`free_until`, `penalty`, `no_show`, `deposit`), configurable
// por hotel (`hotel_cancellation_policy`). Puramente determinista: nunca decide un LLM.
import { roundCurrency } from "./money.ts";

export interface CancellationPolicyConfig {
  /** Horas antes del check-in dentro de las cuales cancelar no genera penalización. */
  freeUntilHours: number;
  /** % del total que se cobra al cancelar fuera de la ventana libre (0..100). */
  penaltyPct: number;
  /** % del total que se cobra ante un no-show sin cancelación previa (0..100). */
  noShowPct: number;
  /** % del total exigido como depósito de garantía al confirmar (0..100). */
  depositPct: number;
}

export interface CancellationEvaluation {
  isFree: boolean;
  hoursUntilCheckIn: number;
  penaltyAmount: number;
  refundAmount: number;
}

export function hoursBetween(nowIso: string, targetDateIso: string): number {
  const now = new Date(nowIso).getTime();
  // targetDateIso es una fecha calendario (YYYY-MM-DD): se interpreta como medianoche
  // UTC de ese día, el mismo criterio de "día de check-in" que usa quote.ts.
  const target = new Date(`${targetDateIso}T00:00:00Z`).getTime();
  return (target - now) / (1000 * 60 * 60);
}

export function evaluateCancellation(
  policy: CancellationPolicyConfig,
  nowIso: string,
  checkInDateIso: string,
  totalAmount: number,
): CancellationEvaluation {
  const hoursUntilCheckIn = hoursBetween(nowIso, checkInDateIso);
  const isFree = hoursUntilCheckIn >= policy.freeUntilHours;
  const penaltyAmount = isFree ? 0 : roundCurrency(totalAmount * (policy.penaltyPct / 100));
  const refundAmount = roundCurrency(Math.max(totalAmount - penaltyAmount, 0));
  return { isFree, hoursUntilCheckIn, penaltyAmount, refundAmount };
}

export interface NoShowEvaluation {
  chargeAmount: number;
}

/** REQ-RES-008/H02-012: cobro de la primera noche (aproximado aquí por `noShowPct` del
 *  total) ante un no-show. La ejecución real del cobro requiere una pasarela de pago —
 *  fuera de alcance de H4 (ver docs/PROGRESO.md); esta función solo calcula el monto. */
export function evaluateNoShow(policy: CancellationPolicyConfig, totalAmount: number): NoShowEvaluation {
  return { chargeAmount: roundCurrency(totalAmount * (policy.noShowPct / 100)) };
}

export function depositRequired(policy: CancellationPolicyConfig, totalAmount: number): number {
  return roundCurrency(totalAmount * (policy.depositPct / 100));
}
