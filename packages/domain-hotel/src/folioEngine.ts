// H5 · Motor determinista de folio (REQ-REC-004/012, REQ-BO-001): cálculo de cargos por
// concepto (hospedaje/A&B/extras/ajuste/propina/descuento), redondeo centralizado y
// reglas de autorización de descuentos y cierre de folio. NINGÚN LLM invoca estas
// funciones con un monto propio -- siempre reciben montos ya calculados desde
// tarifas/POS reales (mismo principio que packages/domain-hotel/src/taxes.ts).
import { roundCurrency } from "./money.ts";
import { applyTaxes, type TaxConfig } from "./taxes.ts";

export const CHARGE_CONCEPTS = [
  "hospedaje",
  "ab",
  "extras",
  "ajuste",
  "propina",
  "descuento",
  "reverso",
  "otro",
] as const;
export type ChargeConcept = (typeof CHARGE_CONCEPTS)[number];

/** Conceptos que NUNCA llevan IVA/ISH (la propina es del huésped al personal, no
 *  contraprestación del hotel; REQ-BO-001 exige "propina excluida del CFDI"). */
const UNTAXED_CONCEPTS: ReadonlySet<ChargeConcept> = new Set(["propina", "descuento", "reverso"]);

/** H16-010: el ISH de Quintana Roo grava SOLO la contraprestación por hospedaje --
 *  "excluye alimentos y otros servicios si se desglosan" (docs/referencia/03, PDF H16
 *  p.16). A&B/extras/ajuste/otro sí llevan IVA (son contraprestación gravada), pero
 *  NUNCA ISH -- un concepto fuera de este set usa una tasa de ISH efectiva de 0%,
 *  sin importar lo que diga `taxConfig.ishRate` del hotel. */
const ISH_APPLICABLE_CONCEPTS: ReadonlySet<ChargeConcept> = new Set(["hospedaje"]);

export interface ChargeCalcInput {
  concept: ChargeConcept;
  /** Monto neto (antes de impuestos) del concepto. */
  netAmount: number;
  taxConfig: TaxConfig;
}

export interface ChargeCalcResult {
  netAmount: number;
  taxAmount: number;
  totalAmount: number;
}

/** Único punto donde un concepto de cargo decide si le aplica IVA+ISH -- determinista,
 *  sin excepciones ad hoc fuera de `UNTAXED_CONCEPTS`. */
export function computeChargeAmounts(input: ChargeCalcInput): ChargeCalcResult {
  if (input.netAmount < 0) {
    throw new RangeError("netAmount de un cargo real no puede ser negativo (usa descuento/reverso para montos negativos).");
  }
  if (UNTAXED_CONCEPTS.has(input.concept)) {
    const net = roundCurrency(input.netAmount);
    return { netAmount: net, taxAmount: 0, totalAmount: net };
  }
  const effectiveTaxConfig = ISH_APPLICABLE_CONCEPTS.has(input.concept)
    ? input.taxConfig
    : { ivaRate: input.taxConfig.ivaRate, ishRate: 0 };
  const breakdown = applyTaxes(input.netAmount, effectiveTaxConfig);
  return {
    netAmount: breakdown.netAmount,
    taxAmount: roundCurrency(breakdown.ivaAmount + breakdown.ishAmount),
    totalAmount: breakdown.totalAmount,
  };
}

// ---------------------------------------------------------------------------
// Descuentos: requieren autorización de un rol administrativo cuando superan el
// umbral configurado por hotel (`hotel_tax_config.discount_threshold`) -- nunca un
// número fijo en código (REQ-BO/REQ-REC-012 estilo "límites + alerta").
// ---------------------------------------------------------------------------
export interface DiscountAuthorizationInput {
  amount: number;
  thresholdAmount: number;
  actorHasAdminRole: boolean;
  authorizedByAdminUserId?: string | null;
}

export interface DiscountAuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/** El propio actor con rol administrativo (owner/gm) puede aplicar cualquier
 *  descuento; un rol sin ese privilegio (p.ej. frontdesk) solo puede aplicar un
 *  descuento por encima del umbral si trae la autorización de alguien que SÍ lo
 *  tiene (`authorizedByAdminUserId`, verificado por el llamador contra `hotel_staff`
 *  ANTES de invocar esta función -- este motor nunca decide identidad, solo aplica
 *  la regla de negocio con la autorización ya verificada). */
export function evaluateDiscountAuthorization(input: DiscountAuthorizationInput): DiscountAuthorizationResult {
  if (input.amount < 0) throw new RangeError("El monto de un descuento se expresa siempre como valor positivo.");
  if (input.amount <= input.thresholdAmount) return { allowed: true };
  if (input.actorHasAdminRole) return { allowed: true };
  if (input.authorizedByAdminUserId) return { allowed: true };
  return {
    allowed: false,
    reason: `El descuento (${input.amount}) supera el umbral (${input.thresholdAmount}) y no tiene autorización de un rol administrativo (owner/gm).`,
  };
}

// ---------------------------------------------------------------------------
// Cierre de folio: saldo cero (tolerancia de redondeo) o cuenta por cobrar
// autorizada por un rol administrativo.
// ---------------------------------------------------------------------------
export type FolioCloseReason = "saldo_cero" | "cuenta_por_cobrar";

export interface FolioCloseInput {
  balance: number;
  reason: FolioCloseReason;
  actorHasAdminRole: boolean;
}

export interface FolioCloseResult {
  allowed: boolean;
  reason?: string;
}

/** Tolerancia de redondeo: dos centavos por el acumulado de impuestos con
 *  redondeo por línea (mismo principio documentado en money.ts). */
const ZERO_BALANCE_TOLERANCE = 0.01;

export function evaluateFolioClose(input: FolioCloseInput): FolioCloseResult {
  const isZero = Math.abs(input.balance) <= ZERO_BALANCE_TOLERANCE;

  if (input.reason === "saldo_cero") {
    if (!isZero) {
      return { allowed: false, reason: `El folio tiene saldo ${input.balance}, no puede cerrarse como "saldo_cero".` };
    }
    return { allowed: true };
  }

  // cuenta_por_cobrar: un saldo distinto de cero SOLO puede cerrarse así con
  // autorización de un rol administrativo (owner/gm) -- nunca de forma implícita.
  if (isZero) {
    return { allowed: false, reason: "El folio ya tiene saldo cero: ciérralo como saldo_cero, no como cuenta_por_cobrar." };
  }
  if (!input.actorHasAdminRole) {
    return { allowed: false, reason: "Cerrar con saldo pendiente como cuenta por cobrar requiere un rol administrativo (owner/gm)." };
  }
  return { allowed: true };
}
