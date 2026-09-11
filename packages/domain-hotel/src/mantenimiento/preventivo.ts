// REQ-HK-015 (docs/ACEPTACION.md): "Calendario de mantenimiento preventivo por activo
// crítico ajustado a ocupación y temporada; historial y costo por activo permite
// calcular recomendación reparar vs. reemplazar (verificado con 2 activos de costo
// distinto)." Puro, determinístico, sin I/O -- mismo principio que
// `tickets/slaPolicy.ts` y `housekeeping/turnos-lft.ts`: el reloj SIEMPRE se recibe
// como parámetro (nunca `Date.now()`/`new Date()` interno), y la ocupación/costo de
// cada activo se pasan como datos, nunca se consultan aquí. `packages/db/migrations/
// 0130_critical_asset_mantenimiento_preventivo.sql` persiste `critical_asset`,
// `hotel_maintenance_season_window` y `critical_asset_maintenance_event`; este módulo
// es la única lógica de negocio sobre esos datos.
//
// Límite honesto de la ocupación disponible hoy: el esquema (packages/db/migrations/
// 0006_reservation.sql) liga una reserva a un `room_type_id`, NO a una habitación física
// concreta -- no existe todavía una asignación de habitación por fecha futura, solo
// `room.status` ('ocupada'/'disponible'/...) HOY. `adjustDueDateForRoomOccupancy` por
// eso recibe un oráculo `isRoomOccupied(date)` en vez de leer una tabla: quien lo llama
// desde la API hoy solo puede responder con precisión para la fecha de HOY (repite el
// mismo valor para cualquier fecha futura que se le pregunte), y ese límite queda
// documentado en el llamador (`apps/api/src/routes/mantenimiento.ts`) -- el día que
// exista asignación de habitación por fecha, esta función no cambia, solo mejora el
// oráculo que recibe.

/** Ventana de temporada (pre-huracanes, post-sargazo, ...) configurable POR HOTEL
 *  (`hotel_maintenance_season_window`) -- nunca un calendario fijo hardcodeado, porque
 *  la temporada de huracanes del Pacífico mexicano y la del Caribe no coinciden, y el
 *  sargazo solo afecta la costa caribeña. */
export interface SeasonWindow {
  /** Etiqueta libre para mostrar en UI/registro, ej. "pre-huracanes". */
  label: string;
  /** MM-DD de inicio (inclusive). */
  startMonthDay: string;
  /** MM-DD de fin (inclusive). Si es numéricamente < startMonthDay se interpreta que la
   *  ventana cruza fin de año (ej. 12-15..01-15). */
  endMonthDay: string;
  /** Frecuencia (días) a aplicar cuando el vencimiento cae dentro de esta ventana. Si es
   *  MAYOR que la frecuencia base del activo se ignora -- una ventana de temporada solo
   *  puede APRETAR el calendario, nunca aflojarlo (H11-019: la temporada es un factor de
   *  riesgo, no una excusa para espaciar el MP). */
  frequencyDays: number;
}

const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function parseMonthDay(value: string, field: string): number {
  const match = MONTH_DAY_RE.exec(value);
  if (!match) throw new RangeError(`${field} inválido: "${value}" (formato esperado MM-DD)`);
  return Number(match[1]) * 100 + Number(match[2]); // ej. "03-15" -> 315, comparable numéricamente
}

/** `true` si el mes-día (UTC) de `date` cae dentro de la ventana [startMonthDay,
 *  endMonthDay] -- soporta ventanas que cruzan fin de año (ej. "12-15".."01-15"). */
export function isMonthDayInSeasonWindow(date: Date, window: Pick<SeasonWindow, "startMonthDay" | "endMonthDay">): boolean {
  const monthDay = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const start = parseMonthDay(window.startMonthDay, "startMonthDay");
  const end = parseMonthDay(window.endMonthDay, "endMonthDay");
  if (start <= end) return monthDay >= start && monthDay <= end;
  // Cruza fin de año: dentro si es >= inicio (tramo de este año) O <= fin (tramo del año siguiente).
  return monthDay >= start || monthDay <= end;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CriticalAssetScheduleInput {
  /** Frecuencia base (días) fuera de cualquier ventana de temporada. */
  baseFrequencyDays: number;
  /** Última ejecución de MP registrada (`critical_asset_maintenance_event.completed_at`
   *  más reciente), o `null` si el activo nunca tuvo una MP registrada -- en ese caso el
   *  ancla es `installDate` (un activo recién instalado no debe esperar un ciclo
   *  completo de frecuencia desde HOY, sino desde que se instaló). */
  lastCompletedAt: Date | null;
  installDate: Date;
  /** Ventanas de temporada del hotel (`hotel_maintenance_season_window`); vacío/omitido
   *  = sin ajuste de temporada (nunca se inventa una ventana por default). */
  seasonWindows?: SeasonWindow[];
}

export interface CriticalAssetScheduleResult {
  /** Próxima fecha de vencimiento del MP, YA ajustada por temporada (antes de
   *  ocupación -- ver `adjustDueDateForRoomOccupancy`). */
  dueDate: Date;
  /** Frecuencia efectivamente aplicada (puede ser < baseFrequencyDays si el vencimiento
   *  cae en una ventana de temporada). */
  effectiveFrequencyDays: number;
  /** Ventana de temporada que apretó la frecuencia, si alguna aplicó. */
  appliedSeasonWindow: SeasonWindow | null;
}

/** Corazón de "calendario ajustado a temporada" (REQ-HK-015): calcula el próximo
 *  vencimiento desde la última ejecución (o instalación), y si esa fecha cae dentro de
 *  una ventana de temporada configurada, recalcula con la frecuencia de esa ventana --
 *  la más apretada (`Math.min`) cuando varias ventanas aplican al mismo tiempo. Nunca
 *  afloja: una ventana con `frequencyDays` >= la base se ignora. */
export function computeNextPreventiveDueDate(input: CriticalAssetScheduleInput): CriticalAssetScheduleResult {
  if (input.baseFrequencyDays <= 0) {
    throw new RangeError(`baseFrequencyDays debe ser > 0 (recibido ${input.baseFrequencyDays})`);
  }
  const anchor = input.lastCompletedAt ?? input.installDate;
  const windows = input.seasonWindows ?? [];

  const baseDue = new Date(anchor.getTime() + input.baseFrequencyDays * DAY_MS);

  // Ventanas cuyo `frequencyDays` es MÁS APRETADO que la base y que cubren la fecha
  // base de vencimiento -- se evalúa contra `baseDue` (no contra `anchor`): lo que
  // importa es si el MOMENTO en que tocaría el MP cae en temporada de riesgo, no cuándo
  // se hizo el MP anterior.
  const tighteningWindows = windows.filter((w) => w.frequencyDays < input.baseFrequencyDays && isMonthDayInSeasonWindow(baseDue, w));

  if (tighteningWindows.length === 0) {
    return { dueDate: baseDue, effectiveFrequencyDays: input.baseFrequencyDays, appliedSeasonWindow: null };
  }

  const tightest = tighteningWindows.reduce((min, w) => (w.frequencyDays < min.frequencyDays ? w : min));
  return {
    dueDate: new Date(anchor.getTime() + tightest.frequencyDays * DAY_MS),
    effectiveFrequencyDays: tightest.frequencyDays,
    appliedSeasonWindow: tightest,
  };
}

export interface OccupancyAdjustmentResult {
  /** Fecha final a mostrar/agendar. */
  adjustedDate: Date;
  /** Días que se pospuso respecto al `dueDate` original (0 si no se pospuso). */
  postponedDays: number;
  /** `true` si se agotó `maxLookaheadDays` sin encontrar un día libre: la MP se deja en
   *  su fecha original (nunca se pospone indefinidamente un activo crítico solo por
   *  ocupación -- seguridad primero) y queda marcada para que el staff decida a mano. */
  forcedDespiteOccupancy: boolean;
}

const DEFAULT_MAX_LOOKAHEAD_DAYS = 14;

/** REQ-HK-015 "ajustado a ocupación (MP en habitaciones vacías)": si el activo está
 *  ligado a una habitación (`roomId` no nulo en `critical_asset`), busca desde
 *  `dueDate` hacia adelante el primer día en que `isRoomOccupied` responda `false`
 *  (hasta `maxLookaheadDays`, default 14) y pospone la MP a ese día. Un activo sin
 *  habitación (generador, bomba de alberca, PTAR) nunca se pospone por esto -- pásese
 *  `null` como `isRoomOccupied` en ese caso, o simplemente no llamar a esta función. */
export function adjustDueDateForRoomOccupancy(
  dueDate: Date,
  isRoomOccupied: (date: Date) => boolean,
  maxLookaheadDays: number = DEFAULT_MAX_LOOKAHEAD_DAYS,
): OccupancyAdjustmentResult {
  if (maxLookaheadDays < 0) throw new RangeError(`maxLookaheadDays debe ser >= 0 (recibido ${maxLookaheadDays})`);
  if (!isRoomOccupied(dueDate)) {
    return { adjustedDate: dueDate, postponedDays: 0, forcedDespiteOccupancy: false };
  }
  for (let offset = 1; offset <= maxLookaheadDays; offset++) {
    const candidate = new Date(dueDate.getTime() + offset * DAY_MS);
    if (!isRoomOccupied(candidate)) {
      return { adjustedDate: candidate, postponedDays: offset, forcedDespiteOccupancy: false };
    }
  }
  return { adjustedDate: dueDate, postponedDays: 0, forcedDespiteOccupancy: true };
}

export type RepairOrReplaceRecommendation = "reparar" | "reemplazar";

export interface RepairOrReplaceInput {
  /** Costo de reemplazo del activo (`critical_asset.replacement_cost`). */
  replacementCost: number;
  /** Costos de reparación/MP acumulados en la ventana de análisis (típicamente 12
   *  meses) -- suma de `critical_asset_maintenance_event.cost` +
   *  `maintenance_ticket.actual_cost` del mismo activo en ese periodo. Cada elemento es
   *  UN evento de costo (se usa también para contar reincidencias). */
  trailingRepairCosts: number[];
}

export interface RepairOrReplaceResult {
  recommendation: RepairOrReplaceRecommendation;
  /** Suma de `trailingRepairCosts` / `replacementCost`. */
  costRatio: number;
  /** Número de eventos de costo considerados. */
  repairCount: number;
  reason: string;
}

/** H11-020 "recomendación reparar vs. reemplazar": regla del 50% -- estándar de
 *  facilities/CMMS (ej. guías de mantenimiento de activos de Fracttal/UpKeep, mismas
 *  categorías de CMMS citadas en H11-026): si el costo acumulado de reparaciones en la
 *  ventana de análisis alcanza o supera el 50% del costo de reemplazo, reemplazar sale
 *  más barato a mediano plazo que seguir reparando. Regla secundaria: 3 o más eventos de
 *  costo en la ventana (reincidencia) ya con un costo acumulado no trivial (>= 20% del
 *  reemplazo) también recomienda reemplazar -- un activo que falla seguido, aunque cada
 *  reparación sea barata, cuesta en tiempo fuera de servicio y disrupción lo que este
 *  módulo no puede cuantificar en pesos, así que se trata como señal de reemplazo antes
 *  de llegar al 50%. Sin reparaciones registradas, siempre "reparar" (no hay evidencia
 *  de que reemplazar convenga). */
export const REPLACEMENT_COST_RATIO_THRESHOLD = 0.5;
export const RECURRING_FAILURE_MIN_COUNT = 3;
export const RECURRING_FAILURE_COST_RATIO_THRESHOLD = 0.2;

export function recommendRepairOrReplace(input: RepairOrReplaceInput): RepairOrReplaceResult {
  if (input.replacementCost <= 0) {
    throw new RangeError(`replacementCost debe ser > 0 (recibido ${input.replacementCost})`);
  }
  const repairCount = input.trailingRepairCosts.length;
  const totalRepairCost = input.trailingRepairCosts.reduce((sum, c) => sum + c, 0);
  const costRatio = totalRepairCost / input.replacementCost;

  if (repairCount === 0) {
    return { recommendation: "reparar", costRatio: 0, repairCount: 0, reason: "Sin historial de costo registrado para este activo: no hay evidencia de que reemplazar convenga." };
  }
  if (costRatio >= REPLACEMENT_COST_RATIO_THRESHOLD) {
    return {
      recommendation: "reemplazar",
      costRatio,
      repairCount,
      reason:
        `El costo acumulado de reparaciones ($${totalRepairCost.toFixed(2)}) alcanza el ${(costRatio * 100).toFixed(0)}% ` +
        `del costo de reemplazo ($${input.replacementCost.toFixed(2)}), por encima del umbral del ` +
        `${(REPLACEMENT_COST_RATIO_THRESHOLD * 100).toFixed(0)}% (regla del 50%, estándar de gestión de activos CMMS).`,
    };
  }
  if (repairCount >= RECURRING_FAILURE_MIN_COUNT && costRatio >= RECURRING_FAILURE_COST_RATIO_THRESHOLD) {
    return {
      recommendation: "reemplazar",
      costRatio,
      repairCount,
      reason:
        `${repairCount} reparaciones registradas en la ventana de análisis (reincidencia), con un costo acumulado ` +
        `ya en el ${(costRatio * 100).toFixed(0)}% del reemplazo -- la disrupción de fallas repetidas justifica ` +
        `reemplazar antes de llegar al umbral del ${(REPLACEMENT_COST_RATIO_THRESHOLD * 100).toFixed(0)}%.`,
    };
  }
  return {
    recommendation: "reparar",
    costRatio,
    repairCount,
    reason:
      `El costo acumulado de reparaciones ($${totalRepairCost.toFixed(2)}, ${(costRatio * 100).toFixed(0)}% del reemplazo) ` +
      `sigue por debajo del umbral del ${(REPLACEMENT_COST_RATIO_THRESHOLD * 100).toFixed(0)}%: seguir reparando es la ` +
      `opción más barata por ahora.`,
  };
}
