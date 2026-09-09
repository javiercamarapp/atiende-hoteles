// REQ-RES-010 (P1/F): "club de segundo viaje" -- programa de reserva directa: registro
// con consentimiento explícito, emisión de código de miembro (ver
// packages/db/migrations/0123_club_segundo_viaje.sql, `member_code` lo genera la BD,
// mismo criterio que `reservation.confirmation_code`) y aplicación AUTOMÁTICA del
// beneficio en reservas DIRECTAS subsecuentes. Este módulo es el cálculo puro (sin
// I/O) de CUÁNDO/CUÁNTO aplica el descuento -- contraparte determinista de
// `apps/api/src/domain/clubSegundoViaje.ts` (que carga membresía/config reales y llama
// esto), mismo principio de separación que `cancellationPolicy.ts`.
import { roundCurrency } from "../money.ts";

export const LOYALTY_MEMBER_STATUSES = ["activo", "revocado"] as const;
export type LoyaltyMemberStatus = (typeof LOYALTY_MEMBER_STATUSES)[number];

export function isActiveLoyaltyMember(status: LoyaltyMemberStatus | null | undefined): boolean {
  return status === "activo";
}

export function assertValidLoyaltyDiscountPct(discountPct: number): void {
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    throw new Error(`descuento_invalido: discountPct debe estar en [0, 100], recibido ${discountPct}`);
  }
}

export interface LoyaltyBenefitInput {
  /** `true` solo si la fila de `hotel_loyalty_member` del huésped existe y su `status` es 'activo'. */
  readonly isActiveMember: boolean;
  /** El beneficio SOLO aplica a reservas directas (REQ-RES-010: "reservas directas
   *  subsecuentes") -- una reserva de OTA/agente externo nunca lo recibe, sin importar
   *  la membresía. */
  readonly isDirectChannel: boolean;
  /** `hotel_loyalty_program_config.discount_pct`, 0..100. */
  readonly discountPct: number;
  /** Monto neto (sin impuestos) de la cotización ANTES del beneficio. */
  readonly netAmount: number;
}

export interface LoyaltyBenefitResult {
  readonly applies: boolean;
  /** 0 cuando `applies` es `false` -- nunca se reporta un % "que hubiera aplicado". */
  readonly discountPct: number;
  readonly discountAmount: number;
  readonly netAmountAfterDiscount: number;
}

/**
 * Decide si el beneficio del club aplica a ESTA reserva y calcula el monto. Fail-closed
 * en las 3 condiciones (miembro activo Y canal directo Y descuento > 0) -- cualquiera
 * que falte, no hay descuento y el neto queda intacto (redondeado igual que el resto
 * del motor de cotización, `roundCurrency`, para que nunca diverja de `computeQuote`).
 */
export function applyLoyaltyBenefit(input: LoyaltyBenefitInput): LoyaltyBenefitResult {
  const netAmountRounded = roundCurrency(input.netAmount);
  if (!input.isActiveMember || !input.isDirectChannel || input.discountPct <= 0) {
    return { applies: false, discountPct: 0, discountAmount: 0, netAmountAfterDiscount: netAmountRounded };
  }
  const discountAmount = roundCurrency(netAmountRounded * (input.discountPct / 100));
  return {
    applies: true,
    discountPct: input.discountPct,
    discountAmount,
    netAmountAfterDiscount: roundCurrency(netAmountRounded - discountAmount),
  };
}
