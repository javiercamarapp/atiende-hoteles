/**
 * REQ-AB-003 (P1/F): "Todo cargo de F&B posteado al folio debe soportar
 * reverso/anulación como transacción negativa auditable, con cola offline y
 * reconciliación al recuperar conectividad en zonas sin señal (playa/alberca)."
 *
 * El reverso/anulación EN LÍNEA ya existe de forma genérica para cualquier concepto de
 * cargo (`mark_charge_reversed`, `packages/db/migrations/0030_folio_engine.sql`,
 * expuesto en `POST /hoteles/:hotelId/folios/:folioId/cargos/:chargeId/reverso`) --
 * cubre F&B (`concept='ab'`) igual que cualquier otro concepto. La pieza que faltaba,
 * y que exige este requisito explícitamente, es la cola offline: un dispositivo en
 * playa/alberca sin señal captura el cargo o el reverso LOCALMENTE y lo sincroniza
 * después. `apps/api/src/routes/fnbOfflineQueue.ts` es quien persiste
 * (`fnb_offline_charge_queue`, tabla append-only) y aplica el resultado; este módulo
 * es la validación de dominio PURA (sin I/O) de la forma de un ítem de la cola antes
 * de intentar aplicarlo -- mismo principio que `fnbAllergyGuard.ts`/
 * `roomChargeIdentityGuard.ts`.
 *
 * Fail-closed: un ítem mal formado se RECHAZA (nunca se aplica "a medias" ni se
 * completa un campo faltante con un valor por defecto) -- la cola offline maneja
 * dinero real, así que un ítem dudoso se marca `rechazado` con la razón exacta, nunca
 * se descarta en silencio (el dispositivo/el staff deben poder ver por qué no se
 * aplicó y corregir/reintentar).
 */

export type FnbOfflineOperationType = "cargo" | "reverso";

export interface FnbOfflineQueueItemInput {
  readonly clientOperationId: string;
  readonly operationType: FnbOfflineOperationType;
  readonly folioId: string;
  /** Requerido SOLO para 'reverso' (el cargo original que se está reversando). */
  readonly originalChargeId?: string | null;
  readonly description: string;
  readonly amount: number;
  readonly capturedBy: string;
  readonly capturedOfflineAt: string;
  readonly deviceId: string;
}

export interface FnbOfflineQueueValidation {
  readonly valid: boolean;
  /** Vacío si `valid` es true. Cada razón es independiente -- se acumulan todas, no
   *  solo la primera, para que un dispositivo que reintenta corrija todo de una vez. */
  readonly reasons: readonly string[];
}

// Tolerancia de sesgo de reloj de dispositivo (el mismo principio que
// `charge_folio_stay_date_hospedaje_idx`: un margen chico y documentado, nunca cero
// artificial que reviente por drift real de un teléfono/tablet, ni indefinido).
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Validación de forma/consistencia interna de un ítem de la cola offline -- NO
 *  verifica todavía que el folio/cargo exista en base de datos (eso lo hace la ruta,
 *  que sí tiene I/O) ni la identidad del huésped (`roomChargeIdentityGuard.ts`,
 *  invocado aparte para operaciones 'cargo'). Esta función solo garantiza que el ítem
 *  esté completo y sea internamente coherente antes de intentar aplicarlo. */
export function validateFnbOfflineQueueItem(
  item: FnbOfflineQueueItemInput,
  now: Date = new Date(),
): FnbOfflineQueueValidation {
  const reasons: string[] = [];

  if (!item.clientOperationId.trim()) reasons.push("clientOperationId vacío: requerido para deduplicar reintentos del dispositivo.");
  if (!item.folioId.trim()) reasons.push("folioId vacío.");
  if (!item.description.trim()) reasons.push("description vacía.");
  if (!item.capturedBy.trim()) reasons.push("capturedBy vacío.");
  if (!item.deviceId.trim()) reasons.push("deviceId vacío: requerido para auditar de qué dispositivo offline vino el ítem.");
  if (!(item.amount > 0)) reasons.push("amount debe ser mayor a 0 (el signo negativo del reverso lo aplica la ruta, no el dispositivo).");

  if (item.operationType === "reverso" && !item.originalChargeId?.trim()) {
    reasons.push("originalChargeId es requerido para operationType='reverso'.");
  }
  if (item.operationType === "cargo" && item.originalChargeId) {
    reasons.push("originalChargeId no debe enviarse para operationType='cargo'.");
  }

  const capturedAt = new Date(item.capturedOfflineAt);
  if (Number.isNaN(capturedAt.getTime())) {
    reasons.push("capturedOfflineAt no es una fecha/hora ISO válida.");
  } else if (capturedAt.getTime() > now.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
    reasons.push("capturedOfflineAt está en el futuro respecto al momento de reconciliar (más allá del margen de sesgo de reloj).");
  }

  return { valid: reasons.length === 0, reasons };
}
