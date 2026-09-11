/**
 * REQ-AB-012 (P1/NF), mitad "reporte de tasa de captura" (H10-020): "El sistema debe
 * lograr una captura de cargos posteados/cheques cerrados a habitación superior a un
 * umbral objetivo (p.ej. ≥99.5%), minimizando fuga manual." La otra mitad del mismo
 * REQ (doble verificación de identidad, H10-022) ya está cerrada en `folioEngine.ts`
 * (`assertRoomChargeIdentityVerified`) -- este módulo NO la toca ni la reimplementa.
 *
 * POR QUÉ EXISTE UN "INTENTO" SEPARADO DEL `charge` REAL: si la tasa de captura se
 * midiera solo contando filas de `charge`, el resultado sería SIEMPRE 100% -- un cargo
 * que nunca se posteó, por definición, nunca aparece en `charge`. La fuga que este
 * requisito exige medir ("cheque cerrado a habitación" que el mesero/recepción
 * OLVIDÓ capturar en el sistema) vive fuera de `charge` por naturaleza: ocurre en el
 * mundo operativo (una comanda de restaurante, un vale de spa) ANTES de que alguien lo
 * postee. Por eso `apps/api/src/routes/capturaCargos.ts` registra un "intento" en
 * cuanto el staff CIERRA el consumo a una habitación (columna `occurredAt`), y solo
 * después lo vincula al `charge` real cuando se postea -- un intento que nunca se
 * vincula es, precisamente, la fuga manual que el reporte debe exponer.
 *
 * Este módulo es dominio puro (sin I/O, mismo principio que `folioEngine.ts`): calcula
 * la tasa a partir de los intentos YA cargados por quien llama
 * (`apps/api/src/domain/capturaCargos.ts` hace la consulta SQL real), y valida la forma
 * de un intento nuevo antes de intentar persistirlo (mismo patrón que
 * `fnbOfflineQueueGuard.ts`/`validateFnbOfflineQueueItem`).
 */

export const ROOM_CHARGE_CAPTURE_SOURCES = ["frontdesk_manual", "fnb", "spa", "minibar", "otro"] as const;
export type RoomChargeCaptureSource = (typeof ROOM_CHARGE_CAPTURE_SOURCES)[number];

export type RoomChargeCaptureStatus = "pendiente" | "capturado" | "fuga";

export interface RoomChargeCaptureAttemptInput {
  readonly folioId: string;
  readonly source: RoomChargeCaptureSource;
  readonly description: string;
  readonly amount: number;
  /** ISO 8601 -- momento en que el consumo se CERRÓ a la habitación (no cuándo se
   *  captura el intento en el sistema, que puede ser un poco después). */
  readonly occurredAt: string;
  readonly capturedBy: string;
}

export interface RoomChargeCaptureValidation {
  readonly valid: boolean;
  /** Vacío si `valid` es true. Se acumulan todas las razones, no solo la primera. */
  readonly reasons: readonly string[];
}

// Mismo margen que `fnbOfflineQueueGuard.ts` (CLOCK_SKEW_TOLERANCE_MS): un intento
// registrado "en el futuro" casi siempre es un reloj de dispositivo desincronizado,
// nunca una fuga real -- pero tampoco se acepta un margen indefinido.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Valida la FORMA/coherencia interna de un intento antes de persistirlo -- no
 *  verifica que el folio exista ni resuelve el `hotel_id`/`tenant_id` (eso lo hace la
 *  ruta, que sí tiene I/O). Fail-closed: un intento mal formado se rechaza con la razón
 *  exacta, nunca se completa con un valor por defecto (este registro es la base de un
 *  reporte financiero -- un dato inventado aquí falsearía la tasa de captura real). */
export function validateRoomChargeCaptureAttempt(
  input: RoomChargeCaptureAttemptInput,
  now: Date = new Date(),
): RoomChargeCaptureValidation {
  const reasons: string[] = [];

  if (!input.folioId.trim()) reasons.push("folioId vacío.");
  if (!input.description.trim()) reasons.push("description vacía.");
  if (!input.capturedBy.trim()) reasons.push("capturedBy vacío.");
  if (!(input.amount > 0)) reasons.push("amount debe ser mayor a 0.");
  if (!ROOM_CHARGE_CAPTURE_SOURCES.includes(input.source)) {
    reasons.push(`source inválida: debe ser una de ${ROOM_CHARGE_CAPTURE_SOURCES.join(", ")}.`);
  }

  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    reasons.push("occurredAt no es una fecha/hora ISO válida.");
  } else if (occurredAt.getTime() > now.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
    reasons.push("occurredAt está en el futuro respecto al momento de registrar el intento (más allá del margen de sesgo de reloj).");
  }

  return { valid: reasons.length === 0, reasons };
}

export interface RoomChargeCaptureAttemptRecord {
  readonly id: string;
  readonly status: RoomChargeCaptureStatus;
  readonly amount: number;
  readonly description: string;
  readonly source: RoomChargeCaptureSource;
  readonly occurredAt: string;
}

export interface ChargeCaptureReportOptions {
  /** Umbral objetivo de tasa de captura (0..1]. Default 0.995 (99.5%, H10-020) --
   *  SIEMPRE parametrizable por hotel (`hotel_tax_config.charge_capture_rate_target`,
   *  migración 0152), nunca fijo en este módulo: un hotel puede exigirse un objetivo
   *  distinto sin tocar código, mismo principio que `discount_threshold`. */
  readonly targetRate?: number;
}

export interface ChargeCaptureReportResult {
  readonly totalAttempts: number;
  readonly captured: number;
  readonly leaked: number;
  readonly pending: number;
  /** captured / totalAttempts, en [0, 1]. Con 0 intentos en el periodo, la tasa es 1
   *  (vacuamente cumplida) -- un periodo sin actividad de room-charge no es una fuga. */
  readonly captureRate: number;
  readonly targetRate: number;
  readonly meetsTarget: boolean;
  /** Intentos que TODAVÍA no cuentan como capturados (fuga + pendiente), ordenados del
   *  más antiguo al más reciente -- son la lista de seguimiento real para operación
   *  ("minimizando fuga manual" exige poder ACTUAR sobre la fuga, no solo verla como
   *  un porcentaje). */
  readonly uncapturedAttempts: readonly RoomChargeCaptureAttemptRecord[];
}

const DEFAULT_TARGET_RATE = 0.995;

/** Núcleo del reporte de REQ-AB-012/H10-020. Un intento 'pendiente' cuenta EXACTAMENTE
 *  igual que uno 'fuga' para la tasa (ninguno es todavía un cargo posteado real) -- la
 *  distinción pendiente/fuga existe solo para que el staff sepa si vale la pena seguir
 *  buscándolo (pendiente, aún dentro de la operación del día) o si ya se dio por
 *  perdido (fuga, con motivo y quién lo reconcilió) -- ninguna de las dos infla la tasa
 *  de captura reportada. Esto es intencional: un reporte que excluyera 'pendiente' del
 *  denominador podría maquillar la fuga real con solo dejar intentos sin resolver. */
export function buildChargeCaptureReport(
  attempts: readonly RoomChargeCaptureAttemptRecord[],
  options: ChargeCaptureReportOptions = {},
): ChargeCaptureReportResult {
  const targetRate = options.targetRate ?? DEFAULT_TARGET_RATE;
  if (!(targetRate > 0) || targetRate > 1) {
    throw new RangeError("targetRate debe estar en el rango (0, 1].");
  }

  const totalAttempts = attempts.length;
  const captured = attempts.filter((a) => a.status === "capturado").length;
  const leaked = attempts.filter((a) => a.status === "fuga").length;
  const pending = attempts.filter((a) => a.status === "pendiente").length;
  const captureRate = totalAttempts === 0 ? 1 : captured / totalAttempts;

  const uncapturedAttempts = attempts
    .filter((a) => a.status !== "capturado")
    .slice()
    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

  return {
    totalAttempts,
    captured,
    leaked,
    pending,
    captureRate,
    targetRate,
    meetsTarget: captureRate >= targetRate,
    uncapturedAttempts,
  };
}
