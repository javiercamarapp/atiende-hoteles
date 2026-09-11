/**
 * REQ-AB-005 (P2/F): "El sistema debe registrar consumo de minibar/honor bar mediante
 * foto o checklist con evidencia asociada al cargo, manteniendo la tasa de disputas
 * bajo un umbral objetivo (<3%)." Módulo de dominio PURO (mismo principio que
 * `fnbAllergyGuard.ts`): ninguna función de aquí toca I/O -- `apps/api/src/routes/
 * minibar.ts` es quien persiste el estado (tabla `minibar_consumption`, migración
 * 0130) y decide cuándo invocar cada guarda.
 *
 * Dos responsabilidades:
 *   1. Validación fail-closed de la evidencia (foto O checklist, nunca un cargo de
 *      minibar sin nada que el huésped pueda revisar si lo disputa) -- la ÚNICA forma
 *      de que un consumo de minibar se considere respaldado.
 *   2. Cómputo determinista de la tasa de disputas de un periodo contra el umbral
 *      objetivo -- sin fabricar una lectura de cumplimiento cuando no hay datos
 *      todavía (mismo criterio que `roiBaseline.ts`/`GET /hoteles/:hotelId/roi`:
 *      "sinDatos" explícito en vez de un 0% engañoso).
 */

export const MINIBAR_EVIDENCE_TYPES = ["foto", "checklist"] as const;
export type MinibarEvidenceType = (typeof MINIBAR_EVIDENCE_TYPES)[number];

export interface MinibarChecklistItem {
  readonly item: string;
  readonly cantidad: number;
}

export interface MinibarEvidenceInput {
  readonly type: MinibarEvidenceType;
  /** Requerida (no vacía) cuando `type === "foto"`; debe ser una URL real, nunca una
   *  cadena vacía o un valor de relleno -- fail-closed, mismo criterio que
   *  `payment_token_ref_not_pan`: la barrera de aplicación es la primera línea, el
   *  CHECK de la migración 0130 es la barrera estructural real. */
  readonly photoUrl?: string | null;
  /** Requerido (con al menos 1 elemento con cantidad > 0) cuando
   *  `type === "checklist"`. */
  readonly checklistItems?: ReadonlyArray<MinibarChecklistItem> | null;
}

export interface MinibarEvidenceValidation {
  readonly valid: boolean;
  readonly reason: string | null;
}

const URL_RE = /^https?:\/\/\S+$/i;

/** Valida que `input` traiga evidencia REAL y utilizable -- nunca solo un booleano
 *  "traeEvidencia" sin sustancia detrás. Fail-closed: cualquier caso ambiguo (URL sin
 *  esquema, checklist vacío, cantidad <= 0) se trata como evidencia AUSENTE, nunca
 *  como presente por duda razonable -- lo contrario de `resolveAllergyDeclared`
 *  (ahí la duda favorece tratar de más; aquí, tratar de menos, porque el costo de un
 *  falso positivo es un cargo sin respaldo real ante una disputa). */
export function validateMinibarEvidence(input: MinibarEvidenceInput): MinibarEvidenceValidation {
  if (input.type === "foto") {
    const url = input.photoUrl?.trim();
    if (!url) return { valid: false, reason: "Falta la foto de evidencia del consumo de minibar." };
    if (!URL_RE.test(url)) return { valid: false, reason: "La foto de evidencia debe ser una URL http(s) válida." };
    return { valid: true, reason: null };
  }
  if (input.type === "checklist") {
    const items = input.checklistItems ?? [];
    if (items.length === 0) return { valid: false, reason: "El checklist de consumo de minibar no puede estar vacío." };
    const hasInvalidItem = items.some(
      (it) => !it.item || it.item.trim().length === 0 || !Number.isFinite(it.cantidad) || it.cantidad <= 0,
    );
    if (hasInvalidItem) {
      return { valid: false, reason: "Cada elemento del checklist requiere nombre y una cantidad mayor a cero." };
    }
    return { valid: true, reason: null };
  }
  return { valid: false, reason: "Tipo de evidencia de minibar no reconocido." };
}

export class MinibarEvidenceMissingError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MinibarEvidenceMissingError";
  }
}

/** Guarda central: dado el intento de registrar un consumo de minibar, truena si la
 *  evidencia no es válida. La ÚNICA forma de que `apps/api/src/routes/minibar.ts`
 *  postee el cargo es que esta función NO truene -- si no truena, hay foto o
 *  checklist real asociado. */
export function assertMinibarEvidencePresent(input: MinibarEvidenceInput): void {
  const result = validateMinibarEvidence(input);
  if (!result.valid) throw new MinibarEvidenceMissingError(result.reason ?? "Evidencia de consumo de minibar inválida.");
}

/** Umbral objetivo de tasa de disputas del criterio de aceptación de REQ-AB-005
 *  ("<3%"), expresado en puntos porcentuales para que el reporte lo muestre
 *  directamente sin que cada consumidor tenga que multiplicar por 100. */
export const MINIBAR_DISPUTE_RATE_THRESHOLD_PERCENT = 3;

export interface MinibarDisputeRateInput {
  /** Total de consumos de minibar registrados (con evidencia) en el periodo. */
  readonly totalRegistrados: number;
  /** De esos, cuántos el huésped disputó (con o sin resolver todavía). */
  readonly totalDisputados: number;
}

export interface MinibarDisputeRateResult {
  readonly totalRegistrados: number;
  readonly totalDisputados: number;
  /** `null` cuando `sinDatos` -- nunca un 0% fabricado sin haber registrado nada. */
  readonly ratePercent: number | null;
  readonly thresholdPercent: number;
  /** `null` cuando `sinDatos` -- no hay nada que declarar dentro/fuera de umbral. */
  readonly dentroDelUmbral: boolean | null;
  readonly sinDatos: boolean;
}

/** Cómputo determinista de la tasa de disputas de un periodo (reporte periódico del
 *  criterio de aceptación). Nunca reporta cumplimiento sin datos reales: con 0
 *  consumos registrados en el periodo, `sinDatos: true` y `ratePercent`/
 *  `dentroDelUmbral` quedan en `null` -- mismo criterio de honestidad que
 *  `GET /hoteles/:hotelId/roi` (`sinDatos`) y REQ-HK-022 ("no verificado" explícito en
 *  vez de una lectura optimista sin base). */
export function computeMinibarDisputeRate(input: MinibarDisputeRateInput): MinibarDisputeRateResult {
  if (input.totalRegistrados < 0 || input.totalDisputados < 0) {
    throw new RangeError("totalRegistrados/totalDisputados no pueden ser negativos.");
  }
  if (input.totalDisputados > input.totalRegistrados) {
    throw new RangeError("totalDisputados no puede exceder totalRegistrados.");
  }
  if (input.totalRegistrados === 0) {
    return {
      totalRegistrados: 0,
      totalDisputados: 0,
      ratePercent: null,
      thresholdPercent: MINIBAR_DISPUTE_RATE_THRESHOLD_PERCENT,
      dentroDelUmbral: null,
      sinDatos: true,
    };
  }
  const ratePercent = (input.totalDisputados / input.totalRegistrados) * 100;
  return {
    totalRegistrados: input.totalRegistrados,
    totalDisputados: input.totalDisputados,
    ratePercent,
    thresholdPercent: MINIBAR_DISPUTE_RATE_THRESHOLD_PERCENT,
    dentroDelUmbral: ratePercent < MINIBAR_DISPUTE_RATE_THRESHOLD_PERCENT,
    sinDatos: false,
  };
}
