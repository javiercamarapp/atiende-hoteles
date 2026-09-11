// REQ-CRM-008 (P2/F): capa de datos real del programa de lealtad -- carga
// membresía/config desde las MISMAS tablas que REQ-RES-010
// (`hotel_loyalty_member`/`hotel_loyalty_program_config`, ahora extendida por la
// migración 0130) y delega la decisión de elegibilidad a
// `@atiende-hoteles/domain-hotel` (mismo principio de separación que
// `clubSegundoViaje.ts`). El canje se persiste en
// `hotel_loyalty_benefit_redemption` -- la evidencia real de "un huésped miembro
// obteniendo el beneficio configurado" que exige el criterio de aceptación.
import type { DbClient } from "@atiende-hoteles/db";
import {
  evaluateLoyaltyRedemption,
  isActiveLoyaltyMember,
  type LoyaltyBenefitsConfig,
  type LoyaltyMemberStatus,
  type LoyaltyRedeemableBenefitType,
  type LoyaltyRedemptionChannel,
} from "@atiende-hoteles/domain-hotel";

export async function loadLoyaltyBenefitsConfig(db: DbClient, hotelId: string): Promise<LoyaltyBenefitsConfig> {
  const { rows } = await db.query<{ late_checkout_hours: number | null; fnb_credit_amount: string | null; reconocimiento_texto: string | null }>(
    `select late_checkout_hours, fnb_credit_amount::text as fnb_credit_amount, reconocimiento_texto
     from public.hotel_loyalty_program_config where hotel_id = $1;`,
    [hotelId],
  );
  const row = rows[0];
  if (!row) return { lateCheckoutHours: null, fnbCreditAmount: null, reconocimientoTexto: null };
  return {
    lateCheckoutHours: row.late_checkout_hours,
    fnbCreditAmount: row.fnb_credit_amount === null ? null : Number(row.fnb_credit_amount),
    reconocimientoTexto: row.reconocimiento_texto,
  };
}

async function loadMemberStatus(db: DbClient, hotelId: string, guestId: string): Promise<LoyaltyMemberStatus | null> {
  const { rows } = await db.query<{ status: string }>(
    "select status from public.hotel_loyalty_member where hotel_id = $1 and guest_id = $2;",
    [hotelId, guestId],
  );
  return (rows[0]?.status as LoyaltyMemberStatus | undefined) ?? null;
}

export interface LoyaltyRedemptionRecord {
  readonly id: string;
  readonly benefitType: LoyaltyRedeemableBenefitType;
  readonly canal: LoyaltyRedemptionChannel;
  readonly lateCheckoutHours: number | null;
  readonly fnbCreditAmount: number | null;
  readonly reconocimientoTexto: string | null;
  readonly redeemedAt: string;
}

export async function listLoyaltyRedemptions(db: DbClient, hotelId: string, guestId: string): Promise<LoyaltyRedemptionRecord[]> {
  const { rows } = await db.query<{
    id: string;
    benefit_type: string;
    canal: string;
    late_checkout_hours: number | null;
    fnb_credit_amount: string | null;
    reconocimiento_texto: string | null;
    redeemed_at: string;
  }>(
    `select id, benefit_type, canal, late_checkout_hours, fnb_credit_amount::text as fnb_credit_amount,
            reconocimiento_texto, redeemed_at::text as redeemed_at
     from public.hotel_loyalty_benefit_redemption
     where hotel_id = $1 and guest_id = $2
     order by redeemed_at desc;`,
    [hotelId, guestId],
  );
  return rows.map((row) => ({
    id: row.id,
    benefitType: row.benefit_type as LoyaltyRedeemableBenefitType,
    canal: row.canal as LoyaltyRedemptionChannel,
    lateCheckoutHours: row.late_checkout_hours,
    fnbCreditAmount: row.fnb_credit_amount === null ? null : Number(row.fnb_credit_amount),
    reconocimientoTexto: row.reconocimiento_texto,
    redeemedAt: row.redeemed_at,
  }));
}

export interface RedeemLoyaltyBenefitParams {
  readonly orgId: string;
  readonly hotelId: string;
  readonly guestId: string;
  readonly benefitType: LoyaltyRedeemableBenefitType;
  readonly canal: LoyaltyRedemptionChannel;
  readonly staffUserId: string;
}

export type RedeemLoyaltyBenefitResult =
  | { readonly applies: true; readonly redemption: LoyaltyRedemptionRecord }
  | { readonly applies: false; readonly motivoRechazo: "miembro_inactivo" | "beneficio_no_configurado" };

/**
 * Canjea un beneficio para un huésped miembro. Fail-closed (0130/programaLealtad.ts):
 * sin membresía activa o sin ese beneficio configurado, NO inserta ninguna fila --
 * nunca se registra un canje que no ocurrió realmente.
 */
export async function redeemLoyaltyBenefit(db: DbClient, params: RedeemLoyaltyBenefitParams): Promise<RedeemLoyaltyBenefitResult> {
  const [status, config] = await Promise.all([
    loadMemberStatus(db, params.hotelId, params.guestId),
    loadLoyaltyBenefitsConfig(db, params.hotelId),
  ]);

  const evaluation = evaluateLoyaltyRedemption({
    isActiveMember: isActiveLoyaltyMember(status),
    benefitType: params.benefitType,
    config,
  });

  if (!evaluation.applies) {
    return { applies: false, motivoRechazo: evaluation.motivoRechazo! };
  }

  const { rows } = await db.query<{
    id: string;
    late_checkout_hours: number | null;
    fnb_credit_amount: string | null;
    reconocimiento_texto: string | null;
    redeemed_at: string;
  }>(
    `insert into public.hotel_loyalty_benefit_redemption
       (tenant_id, hotel_id, guest_id, benefit_type, late_checkout_hours, fnb_credit_amount, reconocimiento_texto, canal, redeemed_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id, late_checkout_hours, fnb_credit_amount::text as fnb_credit_amount, reconocimiento_texto, redeemed_at::text as redeemed_at;`,
    [
      params.orgId,
      params.hotelId,
      params.guestId,
      params.benefitType,
      evaluation.snapshot.lateCheckoutHours,
      evaluation.snapshot.fnbCreditAmount,
      evaluation.snapshot.reconocimientoTexto,
      params.canal,
      params.staffUserId,
    ],
  );
  const row = rows[0]!;

  await db.query("select public.record_audit_log($1, $2, 'loyalty_benefit.redeemed', 'guest', $3, $4);", [
    params.orgId,
    params.hotelId,
    params.guestId,
    JSON.stringify({ benefitType: params.benefitType, canal: params.canal, redemptionId: row.id }),
  ]);

  return {
    applies: true,
    redemption: {
      id: row.id,
      benefitType: params.benefitType,
      canal: params.canal,
      lateCheckoutHours: row.late_checkout_hours,
      fnbCreditAmount: row.fnb_credit_amount === null ? null : Number(row.fnb_credit_amount),
      reconocimientoTexto: row.reconocimiento_texto,
      redeemedAt: row.redeemed_at,
    },
  };
}
