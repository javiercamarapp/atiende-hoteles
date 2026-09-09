// REQ-HK-008 (P1/GOB): la plantilla de turnos de housekeeping/lavandería propuesta debe
// validarse contra la Ley Federal del Trabajo ANTES de publicarse -- descansos, límite de
// horas y la transición legislativa hacia la jornada de 40 horas. Cruce puro (sin I/O),
// mismo criterio que `attendance.ts` (REQ-BO-024): la plantilla que entra aquí es la
// PROPUESTA (aún no publicada, aún no trabajada); este módulo es la única puerta de
// publicación -- no decide qué se trabajó de verdad (eso es `attendance.ts` sobre
// `attendance_log`), solo si lo PROGRAMADO es legal antes de dejarlo salir por WhatsApp.
//
// Artículos de la LFT cubiertos:
//  - Art. 60: define jornada diurna/nocturna/mixta -- usado aquí para clasificar cada
//    turno y elegir el límite diario correcto.
//  - Art. 61: jornada máxima por tipo (diurna 8h, nocturna 7h, mixta 7.5h) y semana
//    ordinaria máxima de 48h.
//  - Art. 66: tope de 3 horas extra por día y de 3 veces por semana (=9h extra/semana).
//  - Art. 68: la prolongación de jornada que exceda esos topes es ilegal (no solo "cara"):
//    obliga pago al 200% "independientemente de las sanciones establecidas en la Ley" --
//    se cita junto al 66 en el tope semanal.
//  - Art. 69: un día de descanso con goce de sueldo por cada seis días de trabajo.
//
// Fuera de alcance a propósito: el Art. 71 (descanso preferentemente en domingo) es una
// preferencia, no un límite duro -- no se rechaza una plantilla por programar el descanso
// en otro día; tampoco existe en la LFT un número de horas de descanso ENTRE turnos
// consecutivos (a diferencia de otras legislaciones), así que no se inventa esa cifra.
//
// Transición a jornada de 40h: al cierre de esta sesión la reforma que reduce la jornada
// semanal ordinaria de 48h a 40h sigue en proceso legislativo (reforma al Art. 123
// constitucional, aún sin calendario de entrada en vigor publicado en el DOF que este
// módulo pueda citar con certeza). En vez de fijar una fecha que podría ser incorrecta,
// el límite semanal ordinario es un PARÁMETRO (`weeklyHourLimitSchedule`) resuelto por
// fecha -- hoy resuelve siempre a 48h (`DEFAULT_WEEKLY_HOUR_LIMIT_SCHEDULE`), y el día que
// se publique el calendario oficial de transición basta con pasar un schedule con los
// hitos reales (ver `WeeklyHourLimitMilestone`) sin tocar la lógica de validación.

export type ShiftType = "diurna" | "nocturna" | "mixta";

/** Un turno propuesto en la plantilla, en horario de reloj LOCAL del hotel (evita
 *  ambigüedad de huso horario para clasificar diurna/nocturna/mixta -- ver Art. 60,
 *  que habla de horas del día, no de instantes UTC). */
export interface ProposedShift {
  staffId: string;
  /** Fecha calendario del turno (día en que INICIA), YYYY-MM-DD. */
  workDate: string;
  /** Hora de inicio en reloj local, "HH:mm" (00:00-23:59). */
  startTime: string;
  /** Hora de fin en reloj local, "HH:mm". Si es numéricamente <= `startTime` se
   *  interpreta que el turno cruza medianoche y termina el día siguiente. */
  endTime: string;
}

export interface WeeklyHourLimitMilestone {
  /** YYYY-MM-DD a partir de la cual aplica este límite (inclusive). */
  effectiveFrom: string;
  /** Jornada semanal ordinaria máxima aplicable desde `effectiveFrom` (Art. 61, o el
   *  límite reducido que fije la reforma de transición a 40h una vez publicada). */
  maxOrdinaryWeeklyHours: number;
}

/** Régimen vigente hoy: 48h/semana (Art. 61), sin fecha de transición aún publicada.
 *  Reemplázalo (o pásalo por `weeklyHourLimitSchedule`) en cuanto exista un calendario
 *  oficial de reducción hacia 40h -- ver nota de cabecera. */
export const DEFAULT_WEEKLY_HOUR_LIMIT_SCHEDULE: WeeklyHourLimitMilestone[] = [
  { effectiveFrom: "1970-01-01", maxOrdinaryWeeklyHours: 48 },
];

const SHIFT_TIME_RE = /^([01]\d|2\d):([0-5]\d)$/;

function parseClockMinutes(value: string, field: string): number {
  const match = SHIFT_TIME_RE.exec(value);
  if (!match) {
    throw new RangeError(`${field} inválido: "${value}" (formato esperado HH:mm, 00:00-23:59)`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23) {
    throw new RangeError(`${field} inválido: "${value}" (la hora debe estar entre 00 y 23)`);
  }
  return hours * 60 + minutes;
}

function overlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Minutos del intervalo [start, start+durationMinutes) que caen en horario nocturno
 *  (20:00-06:00, Art. 60), sin importar cuántas medianoches cruce el intervalo. */
function nightMinutesInInterval(startMinute: number, durationMinutes: number): number {
  const end = startMinute + durationMinutes;
  // Bloques nocturnos en la línea de tiempo "estirada" (día 0 y día 1, suficiente porque
  // ningún turno individual dura 24h o más -- eso ya se rechaza como jornada excedida
  // mucho antes de llegar a un límite de clasificación).
  const nightBlocks: Array<[number, number]> = [
    [0, 360], // 00:00-06:00 del día 0 (cola nocturna de la noche anterior)
    [1200, 1800], // 20:00 día 0 -> 06:00 día 1
    [2640, 3240], // 20:00 día 1 -> 06:00 día 2 (solo relevante si el turno es larguísimo)
  ];
  return nightBlocks.reduce((sum, [bStart, bEnd]) => sum + overlapMinutes(startMinute, end, bStart, bEnd), 0);
}

/** Art. 60: diurna/nocturna/mixta según cuánto del turno cae en horario nocturno. */
export function classifyShiftType(startTime: string, endTime: string): ShiftType {
  const startMinute = parseClockMinutes(startTime, "startTime");
  let endMinute = parseClockMinutes(endTime, "endTime");
  if (endMinute <= startMinute) endMinute += 24 * 60; // cruza medianoche
  const duration = endMinute - startMinute;
  const nightMinutes = nightMinutesInInterval(startMinute, duration);
  if (nightMinutes >= 210) return "nocturna"; // >= 3h30 nocturnas: la jornada ENTERA se reputa nocturna
  if (nightMinutes > 0) return "mixta";
  return "diurna";
}

/** Duración del turno en minutos (soporta turnos que cruzan medianoche). */
export function shiftDurationMinutes(startTime: string, endTime: string): number {
  const startMinute = parseClockMinutes(startTime, "startTime");
  let endMinute = parseClockMinutes(endTime, "endTime");
  if (endMinute <= startMinute) endMinute += 24 * 60;
  return endMinute - startMinute;
}

/** Jornada máxima ordinaria por tipo, Art. 61: diurna 8h, nocturna 7h, mixta 7.5h. */
export function ordinaryDailyLimitMinutes(shiftType: ShiftType): number {
  switch (shiftType) {
    case "diurna":
      return 8 * 60;
    case "nocturna":
      return 7 * 60;
    case "mixta":
      return 7.5 * 60;
  }
}

/** Art. 66: tope de horas extra por día -- 3 horas. */
const MAX_DAILY_OVERTIME_MINUTES = 3 * 60;
/** Art. 66/68: tope de horas extra por semana -- 3 veces × 3h = 9 horas. */
const MAX_WEEKLY_OVERTIME_MINUTES = 9 * 60;
/** Art. 66: no más de 3 días con horas extra en la misma semana. */
const MAX_OVERTIME_DAYS_PER_WEEK = 3;
/** Art. 69: al séptimo día consecutivo de trabajo sin descanso ya se violó la ley
 *  (el descanso debe caer, a más tardar, en el día 7). */
const MAX_CONSECUTIVE_WORK_DAYS = 6;

export type ShiftLftViolationType =
  | "jornada_diaria_excedida"
  | "horas_extra_semanales_excedidas"
  | "descanso_semanal_incumplido"
  | "jornada_semanal_ordinaria_excedida";

export interface ShiftLftViolation {
  type: ShiftLftViolationType;
  staffId: string;
  /** Cita legal exacta que se le muestra a quien intenta publicar la plantilla. */
  article: string;
  /** Explicación en español con las cifras concretas del incumplimiento. */
  message: string;
  scope: {
    workDate?: string;
    isoWeek?: string;
    rangeStart?: string;
    rangeEnd?: string;
  };
}

export interface ValidateTurnosLftInput {
  shifts: ProposedShift[];
  /** Régimen de jornada semanal ordinaria aplicable por fecha -- ver nota de
   *  cabecera sobre la transición a 40h. Por defecto, el vigente hoy (48h). */
  weeklyHourLimitSchedule?: WeeklyHourLimitMilestone[];
}

export interface ValidateTurnosLftResult {
  valid: boolean;
  violations: ShiftLftViolation[];
}

function parseDateUTC(workDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(workDate);
  if (!match) throw new RangeError(`workDate inválido: "${workDate}" (formato esperado YYYY-MM-DD)`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isoWeekMonday(workDate: string): string {
  const dt = parseDateUTC(workDate);
  const day = dt.getUTCDay(); // 0=domingo .. 6=sábado
  const diffToMonday = (day + 6) % 7; // lunes=0, martes=1, ..., domingo=6
  const monday = new Date(dt.getTime() - diffToMonday * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

function resolveMaxOrdinaryWeeklyMinutes(isoWeekMondayDate: string, schedule: WeeklyHourLimitMilestone[]): {
  maxMinutes: number;
  milestone: WeeklyHourLimitMilestone;
} {
  if (schedule.length === 0) {
    throw new RangeError("weeklyHourLimitSchedule no puede estar vacío");
  }
  const weekTime = parseDateUTC(isoWeekMondayDate).getTime();
  // Hito vigente = el más reciente cuyo effectiveFrom ya pasó para esta semana; si la
  // semana consultada es anterior a TODOS los hitos, cae al más antiguo del schedule
  // (piso razonable en vez de "sin régimen aplicable").
  let applicable: WeeklyHourLimitMilestone | null = null;
  for (const m of schedule) {
    if (parseDateUTC(m.effectiveFrom).getTime() > weekTime) continue;
    if (!applicable || parseDateUTC(m.effectiveFrom).getTime() > parseDateUTC(applicable.effectiveFrom).getTime()) {
      applicable = m;
    }
  }
  const milestone =
    applicable ?? schedule.reduce((oldest, m) => (parseDateUTC(m.effectiveFrom).getTime() < parseDateUTC(oldest.effectiveFrom).getTime() ? m : oldest));
  return { maxMinutes: milestone.maxOrdinaryWeeklyHours * 60, milestone };
}

interface DailyAggregate {
  workDate: string;
  totalMinutes: number;
  nightMinutes: number;
}

function aggregateByStaffAndDay(shifts: ProposedShift[]): Map<string, Map<string, DailyAggregate>> {
  const byStaff = new Map<string, Map<string, DailyAggregate>>();
  for (const shift of shifts) {
    const duration = shiftDurationMinutes(shift.startTime, shift.endTime);
    const startMinute = parseClockMinutes(shift.startTime, "startTime");
    const nightMinutes = nightMinutesInInterval(startMinute, duration);

    let byDay = byStaff.get(shift.staffId);
    if (!byDay) {
      byDay = new Map<string, DailyAggregate>();
      byStaff.set(shift.staffId, byDay);
    }
    const existing = byDay.get(shift.workDate);
    if (existing) {
      existing.totalMinutes += duration;
      existing.nightMinutes += nightMinutes;
    } else {
      byDay.set(shift.workDate, { workDate: shift.workDate, totalMinutes: duration, nightMinutes });
    }
  }
  return byStaff;
}

function dailyShiftType(day: DailyAggregate): ShiftType {
  if (day.nightMinutes >= 210) return "nocturna";
  if (day.nightMinutes > 0) return "mixta";
  return "diurna";
}

/** Corazón de REQ-HK-008: valida la plantilla de turnos propuesta contra la LFT antes
 *  de publicarse. Nunca lanza por violaciones legales -- las reporta todas en
 *  `violations` (para que la UI las muestre juntas); solo lanza (`RangeError`) por datos
 *  estructuralmente inválidos (hora mal formada, fecha mal formada). */
export function validateTurnosLft(input: ValidateTurnosLftInput): ValidateTurnosLftResult {
  const schedule = input.weeklyHourLimitSchedule ?? DEFAULT_WEEKLY_HOUR_LIMIT_SCHEDULE;
  const violations: ShiftLftViolation[] = [];
  const byStaff = aggregateByStaffAndDay(input.shifts);

  for (const [staffId, byDay] of byStaff) {
    const days = [...byDay.values()].sort((a, b) => (a.workDate < b.workDate ? -1 : 1));

    // --- Jornada diaria + tope de horas extra por día (Art. 61 + Art. 66) ---
    for (const day of days) {
      const shiftType = dailyShiftType(day);
      const limit = ordinaryDailyLimitMinutes(shiftType);
      const overtimeMinutes = Math.max(0, day.totalMinutes - limit);
      if (overtimeMinutes > MAX_DAILY_OVERTIME_MINUTES) {
        violations.push({
          type: "jornada_diaria_excedida",
          staffId,
          article: "LFT art. 61 y 66",
          message:
            `Turno del ${day.workDate} (jornada ${shiftType}) dura ${(day.totalMinutes / 60).toFixed(2)}h: ` +
            `${(overtimeMinutes / 60).toFixed(2)}h de tiempo extra, más de las 3h/día que permite el art. 66 ` +
            `sobre la jornada máxima de ${(limit / 60).toFixed(2)}h (art. 61).`,
          scope: { workDate: day.workDate },
        });
      }
    }

    // --- Horas extra semanales: máximo 3 días/semana y 9h/semana (Art. 66/68) ---
    const byWeek = new Map<string, DailyAggregate[]>();
    for (const day of days) {
      const week = isoWeekMonday(day.workDate);
      const list = byWeek.get(week) ?? [];
      list.push(day);
      byWeek.set(week, list);
    }
    for (const [week, weekDays] of byWeek) {
      const overtimePerDay = weekDays.map((day) => {
        const limit = ordinaryDailyLimitMinutes(dailyShiftType(day));
        return Math.max(0, day.totalMinutes - limit);
      });
      const overtimeDaysCount = overtimePerDay.filter((m) => m > 0).length;
      const weeklyOvertimeMinutes = overtimePerDay.reduce((a, b) => a + b, 0);
      if (overtimeDaysCount > MAX_OVERTIME_DAYS_PER_WEEK || weeklyOvertimeMinutes > MAX_WEEKLY_OVERTIME_MINUTES) {
        violations.push({
          type: "horas_extra_semanales_excedidas",
          staffId,
          article: "LFT art. 66 y 68",
          message:
            `Semana del ${week}: ${(weeklyOvertimeMinutes / 60).toFixed(2)}h de tiempo extra repartidas en ` +
            `${overtimeDaysCount} día(s). El art. 66 permite tiempo extra en máximo 3 días por semana ` +
            `(hasta 9h/semana en total); exceder ese tope obliga además al pago al 200% (art. 68).`,
          scope: { isoWeek: week },
        });
      }

      // --- Jornada semanal ordinaria (Art. 61, o el límite en transición hacia 40h) ---
      const ordinaryWeeklyMinutes = weekDays.reduce((sum, day) => {
        const limit = ordinaryDailyLimitMinutes(dailyShiftType(day));
        return sum + Math.min(day.totalMinutes, limit);
      }, 0);
      const { maxMinutes, milestone } = resolveMaxOrdinaryWeeklyMinutes(week, schedule);
      if (ordinaryWeeklyMinutes > maxMinutes) {
        const isCurrentRegime = milestone.maxOrdinaryWeeklyHours >= 48;
        violations.push({
          type: "jornada_semanal_ordinaria_excedida",
          staffId,
          article: isCurrentRegime
            ? "LFT art. 61"
            : `LFT art. 61 (régimen de transición desde ${milestone.effectiveFrom}: ` +
              `${milestone.maxOrdinaryWeeklyHours}h/semana)`,
          message:
            `Semana del ${week}: ${(ordinaryWeeklyMinutes / 60).toFixed(2)}h ordinarias, por encima del límite ` +
            `de ${milestone.maxOrdinaryWeeklyHours}h/semana vigente para esa fecha.`,
          scope: { isoWeek: week },
        });
      }
    }

    // --- Descanso: al menos 1 día por cada 6 de trabajo (Art. 69) ---
    let runStart = days.length > 0 ? days[0]!.workDate : null;
    let runLength = days.length > 0 ? 1 : 0;
    for (let i = 1; i < days.length; i++) {
      const prevDate = days[i - 1]!.workDate;
      const currDate = days[i]!.workDate;
      const consecutive = parseDateUTC(currDate).getTime() - parseDateUTC(prevDate).getTime() === DAY_MS;
      if (consecutive) {
        runLength += 1;
      } else {
        if (runLength > MAX_CONSECUTIVE_WORK_DAYS) {
          violations.push({
            type: "descanso_semanal_incumplido",
            staffId,
            article: "LFT art. 69",
            message:
              `${runLength} días consecutivos de trabajo (${runStart} a ${prevDate}) sin un día de ` +
              `descanso; el art. 69 exige al menos un día de descanso por cada seis de trabajo.`,
            scope: { rangeStart: runStart ?? undefined, rangeEnd: prevDate },
          });
        }
        runStart = currDate;
        runLength = 1;
      }
    }
    if (runLength > MAX_CONSECUTIVE_WORK_DAYS) {
      const lastDate = days[days.length - 1]!.workDate;
      violations.push({
        type: "descanso_semanal_incumplido",
        staffId,
        article: "LFT art. 69",
        message:
          `${runLength} días consecutivos de trabajo (${runStart} a ${lastDate}) sin un día de descanso; ` +
          `el art. 69 exige al menos un día de descanso por cada seis de trabajo.`,
        scope: { rangeStart: runStart ?? undefined, rangeEnd: lastDate },
      });
    }
  }

  return { valid: violations.length === 0, violations };
}

export class TurnosLftViolationError extends Error {
  code = "turnos_lft_violacion";
  violations: ShiftLftViolation[];
  constructor(violations: ShiftLftViolation[]) {
    super(
      `La plantilla de turnos viola la LFT en ${violations.length} punto(s): ` +
        violations.map((v) => `[${v.article}] ${v.message}`).join(" | "),
    );
    this.name = "TurnosLftViolationError";
    this.violations = violations;
  }
}

/** Puerta de publicación: úsese donde la plantilla de turnos esté a punto de
 *  publicarse (enviarse por WhatsApp / guardarse como definitiva). Lanza
 *  `TurnosLftViolationError` -- citando artículo y cifras -- si CUALQUIER turno de la
 *  plantilla viola la LFT; nunca publica parcialmente. */
export function assertTurnosLftPublishable(input: ValidateTurnosLftInput): void {
  const result = validateTurnosLft(input);
  if (!result.valid) {
    throw new TurnosLftViolationError(result.violations);
  }
}
