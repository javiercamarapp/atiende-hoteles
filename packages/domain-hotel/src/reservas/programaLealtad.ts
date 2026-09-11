// REQ-CRM-008 (P2/F): cálculo PURO (sin I/O, mismo principio de separación que
// `clubSegundoViaje.ts`) de elegibilidad para los 3 beneficios del programa de
// lealtad que se CANJEAN puntualmente (a diferencia de "tarifa directa con
// descuento", que ya se aplica automáticamente en cada reserva directa vía
// `applyLoyaltyBenefit`/`computeLoyaltyBenefitForNewReservation`, REQ-RES-010).
//
// Fail-closed en las mismas 2 condiciones que el descuento: miembro activo Y
// beneficio configurado (valor no nulo) -- cualquiera que falte, el canje se
// rechaza ANTES de que la capa de I/O intente insertar una fila de canje.

export const LOYALTY_REDEEMABLE_BENEFIT_TYPES = ["late_checkout", "credito_fnb", "reconocimiento"] as const;
export type LoyaltyRedeemableBenefitType = (typeof LOYALTY_REDEEMABLE_BENEFIT_TYPES)[number];

export const LOYALTY_REDEMPTION_CHANNELS = ["crm", "whatsapp"] as const;
export type LoyaltyRedemptionChannel = (typeof LOYALTY_REDEMPTION_CHANNELS)[number];

/** `hotel_loyalty_program_config`, columnas agregadas por la migración 0130. `null` en
 *  cualquier campo = ese beneficio no está configurado/habilitado para el hotel. */
export interface LoyaltyBenefitsConfig {
  readonly lateCheckoutHours: number | null;
  readonly fnbCreditAmount: number | null;
  readonly reconocimientoTexto: string | null;
}

export interface EvaluateLoyaltyRedemptionInput {
  readonly isActiveMember: boolean;
  readonly benefitType: LoyaltyRedeemableBenefitType;
  readonly config: LoyaltyBenefitsConfig;
}

export type LoyaltyRedemptionRejectReason = "miembro_inactivo" | "beneficio_no_configurado";

export interface LoyaltyRedemptionSnapshot {
  readonly lateCheckoutHours: number | null;
  readonly fnbCreditAmount: number | null;
  readonly reconocimientoTexto: string | null;
}

export interface EvaluateLoyaltyRedemptionResult {
  readonly applies: boolean;
  /** Ausente cuando `applies` es `true`. */
  readonly motivoRechazo?: LoyaltyRedemptionRejectReason;
  /** Snapshot del valor configurado a persistir en el canje (0 en los campos que no
   *  aplican a este tipo de beneficio) -- nunca se reporta un valor "que hubiera
   *  aplicado" cuando `applies` es `false`. */
  readonly snapshot: LoyaltyRedemptionSnapshot;
}

const EMPTY_SNAPSHOT: LoyaltyRedemptionSnapshot = { lateCheckoutHours: null, fnbCreditAmount: null, reconocimientoTexto: null };

function rejected(motivo: LoyaltyRedemptionRejectReason): EvaluateLoyaltyRedemptionResult {
  return { applies: false, motivoRechazo: motivo, snapshot: EMPTY_SNAPSHOT };
}

/**
 * Decide si un miembro puede canjear ESTE beneficio ahora mismo y qué snapshot de
 * valor debe quedar registrado en el canje.
 */
export function evaluateLoyaltyRedemption(input: EvaluateLoyaltyRedemptionInput): EvaluateLoyaltyRedemptionResult {
  if (!input.isActiveMember) return rejected("miembro_inactivo");

  switch (input.benefitType) {
    case "late_checkout": {
      const hours = input.config.lateCheckoutHours;
      if (hours === null || hours === undefined || hours <= 0) return rejected("beneficio_no_configurado");
      return { applies: true, snapshot: { ...EMPTY_SNAPSHOT, lateCheckoutHours: hours } };
    }
    case "credito_fnb": {
      const amount = input.config.fnbCreditAmount;
      if (amount === null || amount === undefined || amount <= 0) return rejected("beneficio_no_configurado");
      return { applies: true, snapshot: { ...EMPTY_SNAPSHOT, fnbCreditAmount: amount } };
    }
    case "reconocimiento": {
      const texto = input.config.reconocimientoTexto;
      if (texto === null || texto === undefined || texto.trim().length === 0) return rejected("beneficio_no_configurado");
      return { applies: true, snapshot: { ...EMPTY_SNAPSHOT, reconocimientoTexto: texto } };
    }
  }
}

export function assertValidLateCheckoutHours(hours: number): void {
  if (!Number.isInteger(hours) || hours < 1 || hours > 6) {
    throw new Error(`late_checkout_invalido: lateCheckoutHours debe ser un entero en [1, 6], recibido ${hours}`);
  }
}

export function assertValidFnbCreditAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`credito_fnb_invalido: fnbCreditAmount debe ser >= 0, recibido ${amount}`);
  }
}

export function assertValidReconocimientoTexto(texto: string): void {
  if (texto.trim().length === 0) {
    throw new Error("reconocimiento_invalido: reconocimientoTexto no puede estar vacío.");
  }
}
