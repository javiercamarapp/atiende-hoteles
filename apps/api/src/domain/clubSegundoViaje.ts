// REQ-RES-010 (P1/F): capa de datos real del "club de segundo viaje" -- carga
// membresía/config desde `hotel_loyalty_member`/`hotel_loyalty_program_config`
// (migración 0123) y delega el CÁLCULO del beneficio a
// `@atiende-hoteles/domain-hotel` (mismo principio de separación que
// `pms/taxConfig.ts`/`domain/atribucionCanal.ts`).
import type { DbClient } from "@atiende-hoteles/db";
import { applyLoyaltyBenefit, isActiveLoyaltyMember, type LoyaltyBenefitResult, type LoyaltyMemberStatus } from "@atiende-hoteles/domain-hotel";

export interface LoyaltyMembership {
  readonly memberCode: string;
  readonly status: LoyaltyMemberStatus;
  readonly enrolledAt: string;
}

export async function loadLoyaltyMembership(db: DbClient, hotelId: string, guestId: string): Promise<LoyaltyMembership | null> {
  const { rows } = await db.query<{ member_code: string; status: string; enrolled_at: string }>(
    `select member_code, status, enrolled_at::text as enrolled_at
     from public.hotel_loyalty_member
     where hotel_id = $1 and guest_id = $2;`,
    [hotelId, guestId],
  );
  const row = rows[0];
  if (!row) return null;
  return { memberCode: row.member_code, status: row.status as LoyaltyMemberStatus, enrolledAt: row.enrolled_at };
}

/** Sin fila de config, el descuento es 0% -- fail-closed hacia "nunca inventes un
 *  beneficio que nadie configuró explícitamente" (mismo criterio que
 *  `resolveCommissionPct` de REQ-RES-020 para un canal sin config). */
export async function loadLoyaltyDiscountPct(db: DbClient, hotelId: string): Promise<number> {
  const { rows } = await db.query<{ discount_pct: string }>(
    "select discount_pct::text as discount_pct from public.hotel_loyalty_program_config where hotel_id = $1;",
    [hotelId],
  );
  return rows[0] ? Number(rows[0].discount_pct) : 0;
}

/**
 * Calcula el beneficio del club para una reserva NUEVA. Sin `guestId` (reserva sin
 * huésped capturado todavía) nunca aplica -- no hay a quién atribuirle la membresía.
 */
export async function computeLoyaltyBenefitForNewReservation(
  db: DbClient,
  params: { hotelId: string; guestId: string | null; isDirectChannel: boolean; netAmount: number },
): Promise<LoyaltyBenefitResult> {
  if (!params.guestId) {
    return { applies: false, discountPct: 0, discountAmount: 0, netAmountAfterDiscount: params.netAmount };
  }
  const [membership, discountPct] = await Promise.all([
    loadLoyaltyMembership(db, params.hotelId, params.guestId),
    loadLoyaltyDiscountPct(db, params.hotelId),
  ]);
  return applyLoyaltyBenefit({
    isActiveMember: isActiveLoyaltyMember(membership?.status),
    isDirectChannel: params.isDirectChannel,
    discountPct,
    netAmount: params.netAmount,
  });
}
