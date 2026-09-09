// H16-014 · REQ-REC-014 (P1/SEG): reglas deterministas de detección de fraude interno
// cruzando PMS (folio/charge/payment/audit_log, todos reales en este esquema) + POS
// (F&B -- sin integración real todavía, ADR-007/apps/api/src/jobs/nightAudit.ts ya
// declara "sin_pos_configurado"; aquí la reconciliación acepta el dato de venta POS
// como INSUMO EXPLÍCITO de quien invoca el escaneo, nunca inventa una integración que
// no existe). Cuatro patrones, uno por función, cada uno PURO (sin I/O) -- el llamador
// real (apps/api/src/pms/fraudScan.ts) trae las filas ya leídas de Postgres y llama
// estas funciones para decidir, mismo principio que folioEngine.ts/taxes.ts.
import { roundCurrency } from "../money.ts";
import type { HotelRoleLike } from "../reservationStateMachine.ts";

export const FRAUD_PATTERNS = [
  "descuento_fuera_de_politica",
  "folio_reabierto_post_auditoria",
  "cargo_fnb_no_posteado",
  "reembolso_tarjeta_distinta",
] as const;
export type FraudPattern = (typeof FRAUD_PATTERNS)[number];

/** Tolerancia de un centavo -- mismo criterio que folioEngine.ts/money.ts para no
 *  marcar como fraude un residuo de redondeo real. */
const AMOUNT_TOLERANCE = 0.01;

export interface FraudFinding {
  pattern: FraudPattern;
  folioId: string;
  chargeId: string | null;
  paymentId: string | null;
  reason: string;
  evidence: Record<string, unknown>;
  /** Clave determinista de idempotencia de escaneo: re-escanear los mismos datos
   *  NUNCA debe producir una segunda alerta para el mismo hallazgo (ver
   *  packages/db/migrations/0095_fraude_alerta.sql, índice único
   *  `fraud_alert_dedupe_idx (hotel_id, dedupe_key)`). */
  dedupeKey: string;
}

/** Roles a los que corresponde avisar cada patrón (REQ-REC-014: "alerta al
 *  destinatario correspondiente"). owner/gm están siempre porque son quienes
 *  responden por fraude interno frente al dueño del hotel; accountant/fnb se agregan
 *  cuando el patrón cae directamente dentro de su función operativa -- mismo criterio
 *  que night-audit.ts usa para sumar `accountant` a `ADMIN_ROLES`. */
export function recipientRolesForPattern(pattern: FraudPattern): HotelRoleLike[] {
  switch (pattern) {
    case "descuento_fuera_de_politica":
      return ["owner", "gm"];
    case "folio_reabierto_post_auditoria":
      return ["owner", "gm", "accountant"];
    case "cargo_fnb_no_posteado":
      return ["owner", "gm", "fnb"];
    case "reembolso_tarjeta_distinta":
      return ["owner", "gm", "accountant"];
    default: {
      const exhaustive: never = pattern;
      throw new Error(`patrón de fraude desconocido: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1) Descuentos/cortesías fuera de política.
//
// `evaluateDiscountAuthorization` (folioEngine.ts) ya bloquea esto en el camino feliz
// de routes/folios.ts -- esta función es la reconciliación INDEPENDIENTE (mismo
// principio que el night audit reconcilia contra el POS en vez de solo confiar en lo
// que el PMS ya registró): detecta el caso en que un cargo `concept='descuento'`
// llegó a la tabla SIN pasar por esa validación (bypass del endpoint, corrección
// manual en base de datos, migración de otro PMS) -- exactamente el tipo de fraude
// interno que una sola capa de validación en el camino feliz no puede detectar por
// definición, porque el atacante nunca pasó por esa capa.
// ---------------------------------------------------------------------------
export interface DiscountPolicyInput {
  chargeId: string;
  folioId: string;
  /** Monto del descuento tal como vive en `charge.amount` -- la columna real lo
   *  permite negativo para `concept='descuento'` (migrations/0030); se evalúa por
   *  magnitud, nunca por signo. */
  discountAmount: number;
  /** `hotel_tax_config.discount_threshold` del hotel (nunca un número fijo aquí). */
  thresholdAmount: number;
  /** `charge.discount_authorized_by` -- un tercero administrativo verificado. */
  discountAuthorizedByStaffId: string | null;
  /** Si quien aplicó el cargo (resuelto vía audit_log `charge.discount_applied` +
   *  hotel_staff, ver fraudScan.ts) YA tenía rol administrativo (owner/gm) -- ese
   *  caso NO requiere `discountAuthorizedByStaffId` (mismo criterio exacto que
   *  `evaluateDiscountAuthorization`: el propio actor administrativo se autoriza a
   *  sí mismo). Sin esta señal, un descuento aplicado directamente por el dueño
   *  generaría un falso positivo. */
  appliedByHasAdminRole: boolean;
}

export function detectDiscountOutsidePolicy(input: DiscountPolicyInput): FraudFinding | null {
  const magnitude = roundCurrency(Math.abs(input.discountAmount));
  if (magnitude <= input.thresholdAmount + AMOUNT_TOLERANCE) return null;
  if (input.appliedByHasAdminRole) return null;
  if (input.discountAuthorizedByStaffId) return null;

  return {
    pattern: "descuento_fuera_de_politica",
    folioId: input.folioId,
    chargeId: input.chargeId,
    paymentId: null,
    reason:
      `El descuento ${magnitude} del cargo ${input.chargeId} supera el umbral configurado ` +
      `(${input.thresholdAmount}) y no tiene autorización de un rol administrativo: ni quien lo aplicó ` +
      `tenía rol owner/gm, ni trae un discount_authorized_by verificado.`,
    evidence: { discountAmount: magnitude, thresholdAmount: input.thresholdAmount },
    dedupeKey: `descuento_fuera_de_politica:${input.chargeId}`,
  };
}

// ---------------------------------------------------------------------------
// 2) Folio reabierto después de auditado.
//
// Este PMS no expone hoy ningún endpoint de "reabrir folio" (grep confirmado sobre
// routes/folios.ts): TODOS los endpoints de escritura de cargo/descuento/pago/reverso/
// transferencia/split verifican `folio.status === 'abierto'` antes de escribir. Por
// eso, la única forma en que un cargo puede tener `created_at` posterior a
// `folio.closed_at` es que el folio se haya reabierto FUERA del flujo normal (bypass
// de la aplicación, acceso directo a la base de datos, o un futuro endpoint de
// reapertura que todavía no valide esto) -- exactamente la señal que este patrón debe
// capturar, sin necesitar que exista un evento explícito "folio.reabierto".
// ---------------------------------------------------------------------------
export interface FolioReopenInput {
  folioId: string;
  /** ISO 8601. Siempre no-nulo cuando este chequeo aplica (el llamador solo trae
   *  folios con `closed_at is not null`, ver fraudScan.ts). */
  folioClosedAt: string;
  chargeId: string;
  chargeCreatedAt: string;
}

export function detectFolioReopenedAfterAudit(input: FolioReopenInput): FraudFinding | null {
  const closedAtMs = new Date(input.folioClosedAt).getTime();
  const chargeCreatedAtMs = new Date(input.chargeCreatedAt).getTime();
  if (!(chargeCreatedAtMs > closedAtMs)) return null;

  return {
    pattern: "folio_reabierto_post_auditoria",
    folioId: input.folioId,
    chargeId: input.chargeId,
    paymentId: null,
    reason:
      `El folio ${input.folioId} se cerró el ${input.folioClosedAt}, pero el cargo ${input.chargeId} ` +
      `se creó después (${input.chargeCreatedAt}). Ningún endpoint de este sistema admite escribir ` +
      `cargos en un folio cerrado: esto solo es posible si el folio fue reabierto fuera del flujo normal.`,
    evidence: { folioClosedAt: input.folioClosedAt, chargeCreatedAt: input.chargeCreatedAt },
    dedupeKey: `folio_reabierto_post_auditoria:${input.chargeId}`,
  };
}

// ---------------------------------------------------------------------------
// 3) Cargos de F&B no posteados (reconciliación PMS vs. POS).
//
// El insumo de venta POS (`FnbPosReconciliationInput`) llega EXPLÍCITO de quien
// invoca el escaneo -- este paquete de dominio nunca asume ni fabrica una integración
// POS real (no existe todavía, ADR-007). Cuando no hay cargo `concept='ab'` posteado
// al folio que coincida en monto con la venta reportada por el POS, el dinero de esa
// venta nunca llegó al PMS -- el patrón exacto de fraude descrito en el criterio.
// ---------------------------------------------------------------------------
export interface FnbPosReconciliationInput {
  folioId: string;
  /** Identificador de la venta en el POS (externo a este sistema). */
  posSaleId: string;
  posSaleAmount: number;
  /** Cargo F&B (`concept='ab'`) que el llamador ya intentó emparejar con esta venta
   *  por folio -- `null` si no encontró ninguno. */
  matchedCharge: { chargeId: string; amount: number } | null;
}

export function detectUnpostedFnbCharge(input: FnbPosReconciliationInput): FraudFinding | null {
  const posAmount = roundCurrency(input.posSaleAmount);
  if (input.matchedCharge && Math.abs(input.matchedCharge.amount - posAmount) <= AMOUNT_TOLERANCE) {
    return null;
  }

  const matchedAmount = input.matchedCharge ? roundCurrency(input.matchedCharge.amount) : null;
  return {
    pattern: "cargo_fnb_no_posteado",
    folioId: input.folioId,
    chargeId: input.matchedCharge?.chargeId ?? null,
    paymentId: null,
    reason: input.matchedCharge
      ? `La venta POS ${input.posSaleId} (${posAmount}) del folio ${input.folioId} no coincide en monto ` +
        `con el cargo F&B ${input.matchedCharge.chargeId} (${matchedAmount}) posteado al folio.`
      : `La venta POS ${input.posSaleId} (${posAmount}) del folio ${input.folioId} no tiene ningún cargo ` +
        `F&B (concept='ab') posteado al folio: el consumo se vendió pero nunca se cobró al huésped.`,
    evidence: { posSaleId: input.posSaleId, posSaleAmount: posAmount, matchedChargeId: input.matchedCharge?.chargeId ?? null, matchedChargeAmount: matchedAmount },
    dedupeKey: `cargo_fnb_no_posteado:${input.posSaleId}`,
  };
}

// ---------------------------------------------------------------------------
// 4) Reembolsos a una tarjeta distinta de la del cargo.
//
// `payment.token_ref` es la referencia opaca del PSP (nunca un PAN, ver constraint
// `payment_token_ref_not_pan`, migrations/0030). Un reembolso legítimo por el mismo
// puerto (`PaymentProviderPort.refund()`, packages/mcp-servers/payments) SIEMPRE
// conserva el `externalPaymentId`/token del cargo original que reembolsa -- por eso,
// cualquier pago `status='reembolsado'` cuyo `token_ref` NO coincide con ningún pago
// `status='capturado'` del MISMO folio es, por construcción, dinero saliendo por un
// canal distinto del cargo que lo originó.
// ---------------------------------------------------------------------------
export interface RefundCardMismatchInput {
  folioId: string;
  refundPaymentId: string;
  refundTokenRef: string;
  /** Si el llamador encontró, en el MISMO folio, algún pago `status='capturado'` con
   *  este mismo `token_ref` (ver fraudScan.ts, `exists (...)`). */
  matchingCapturedTokenFound: boolean;
}

export function detectRefundToDifferentCard(input: RefundCardMismatchInput): FraudFinding | null {
  if (input.matchingCapturedTokenFound) return null;

  return {
    pattern: "reembolso_tarjeta_distinta",
    folioId: input.folioId,
    chargeId: null,
    paymentId: input.refundPaymentId,
    reason:
      `El reembolso ${input.refundPaymentId} del folio ${input.folioId} se emitió con la referencia de ` +
      `tarjeta "${input.refundTokenRef}", que no coincide con ningún pago capturado en el mismo folio: ` +
      `el dinero pudo haberse desviado a una tarjeta distinta de la que hizo el cargo original.`,
    evidence: { refundPaymentId: input.refundPaymentId, refundTokenRef: input.refundTokenRef },
    dedupeKey: `reembolso_tarjeta_distinta:${input.refundPaymentId}`,
  };
}
