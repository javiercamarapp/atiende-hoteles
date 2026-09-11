// REQ-BO-020 (P1/F): "el sistema debe generar horarios de turnos a partir de un pronóstico
// de ocupación/demanda del PMS por día y puesto, respetando LFT (jornada, descanso, prima
// dominical, reforma de 40h), y reducir horas extra vs. baseline manual."
//
// `housekeeping/turnos-lft.ts` (REQ-HK-008) ya resuelve la MITAD validadora: dada una
// plantilla YA propuesta, dice si es publicable bajo la LFT. Lo que faltaba -- y lo que
// cubre este módulo -- es la mitad GENERADORA: a partir de una demanda de personal por
// día y puesto (ya derivada del pronóstico de ocupación/demanda numérico de
// `../forecast/timeSeriesForecast.ts` -- este módulo NO pronostica, solo asigna personal a
// una demanda ya resuelta, mismo reparto de responsabilidad que exige REQ-AGT-012 para
// mantener el pronóstico fuera de un LLM y fuera de este cruce determinista) y un catálogo
// de personal disponible, produce una plantilla de turnos que:
//
//  1. NUNCA viola la LFT -- cada asignación candidata se valida de forma incremental con
//     `validateTurnosLft` ANTES de comprometerse; si comprometerla violaría la ley (p. ej.
//     el séptimo día consecutivo sin descanso, art. 69, o exceder el tope semanal de horas
//     extra, art. 66/68), esa asignación se descarta y la demanda de ese día/puesto queda
//     reportada como no cubierta (`unmetDemand`) en vez de publicarse ilegal. Este es
//     exactamente el caso "verificado con caso que violaría LFT → rechazado" del criterio
//     de aceptación: rechazado no significa "el generador lanza una excepción", significa
//     "el generador nunca produce ese turno" -- coherente con que `assertTurnosLftPublishable`
//     sobre el resultado de este módulo siempre debe pasar limpio.
//  2. Reparte la demanda entre el personal MENOS cargado hasta ahora (desempate por
//     `staffId` para determinismo) antes de recurrir a nadie que ya esté cerca de su
//     límite -- así es como este módulo reduce horas extra frente a un baseline manual
//     típico, que suele concentrar la cobertura extra en la misma persona de confianza en
//     vez de repartirla. `compareOvertimeVsBaseline` mide esa reducción con la MISMA
//     agregación diaria que usa `turnos-lft.ts` (`summarizeDailyHours`), para que "menos
//     horas extra" signifique lo mismo aquí que en la puerta de publicación.
//  3. Declara la prima dominical (art. 71 LFT: 25% adicional sobre el salario ordinario de
//     ese día) en cada turno que cae en domingo -- `turnos-lft.ts` documenta a propósito
//     que el art. 71 es una preferencia de DESCANSO, no un límite duro que rechace una
//     plantilla; pero sigue siendo una obligación de PAGO que este generador no puede
//     omitir sin que nómina pierda el dato. Por eso viaja como campo explícito
//     (`sundayPremiumApplies`) en cada turno generado, nunca como motivo de rechazo.
//
// Deliberadamente NO decide contrataciones, despidos ni compensación (eso es REQ-BO-025,
// reservado a aprobación humana) -- este módulo solo arma el horario a partir de personal
// YA disponible; si el personal disponible no alcanza para cubrir la demanda sin violar la
// LFT, la respuesta correcta es reportar el faltante (`unmetDemand`), nunca inventar horas.

import {
  type ProposedShift,
  type ShiftLftViolation,
  type WeeklyHourLimitMilestone,
  DEFAULT_WEEKLY_HOUR_LIMIT_SCHEDULE,
  validateTurnosLft,
  shiftDurationMinutes,
  summarizeDailyHours,
} from "../housekeeping/turnos-lft.ts";

/** Demanda de personal para un puesto en un día concreto, ya derivada del pronóstico de
 *  ocupación/demanda (rooms ocupados, cubiertos de F&B esperados, etc.) -- ese cómputo vive
 *  en `../forecast/*`, no aquí. */
export interface StaffingDemandEntry {
  /** Fecha calendario del día a cubrir, YYYY-MM-DD. */
  workDate: string;
  /** Puesto a cubrir (p. ej. "housekeeping", "frontdesk", "fnb", "mantenimiento"). */
  position: string;
  /** Cuántas personas de ese puesto se necesitan cubriendo simultáneamente ese día. Entero
   *  no negativo -- 0 es válido (día sin necesidad de cobertura para ese puesto). */
  requiredHeadcount: number;
}

/** Turno estándar que un colaborador cubre cuando se le asigna un día completo, en horario
 *  local "HH:mm"-"HH:mm" (mismo formato que `ProposedShift`). Fijo por colaborador para que
 *  la asignación sea determinista: mismo colaborador, mismo bloque de horario siempre que
 *  se le asigne. */
export interface StandardShiftBlock {
  startTime: string;
  endTime: string;
}

/** Un colaborador disponible para cubrir demanda de un puesto. */
export interface AvailableStaffMember {
  staffId: string;
  position: string;
  standardShift: StandardShiftBlock;
  /** Fechas (YYYY-MM-DD) en que este colaborador NO puede trabajar (vacaciones, incapacidad,
   *  descanso ya fijado). */
  unavailableDates?: readonly string[];
}

/** Turno de una plantilla manual de referencia -- típicamente lo que el gerente hubiera
 *  armado a mano para el mismo pronóstico. Se usa solo para MEDIR la reducción de horas
 *  extra, nunca se mezcla con la plantilla generada. */
export interface ManualBaselineShift {
  staffId: string;
  workDate: string;
  startTime: string;
  endTime: string;
}

export interface GenerateTurnosFromForecastInput {
  /** Demanda de personal por día y puesto, ya resuelta a partir del pronóstico de
   *  ocupación/demanda. */
  demand: readonly StaffingDemandEntry[];
  /** Catálogo de personal disponible para cubrir esa demanda. */
  staffPool: readonly AvailableStaffMember[];
  /** Régimen de jornada semanal ordinaria aplicable por fecha -- ver
   *  `WeeklyHourLimitMilestone` en `turnos-lft.ts` (transición a 40h). */
  weeklyHourLimitSchedule?: WeeklyHourLimitMilestone[];
  /** Plantilla manual de referencia contra la que medir la reducción de horas extra.
   *  Opcional: sin ella se genera igual, solo no se produce `overtimeComparison`. */
  manualBaseline?: readonly ManualBaselineShift[];
}

/** Un turno generado, con la prima dominical (art. 71) ya declarada. */
export interface GeneratedShift extends ProposedShift {
  /** true si `workDate` cae en domingo -- corresponde prima dominical (25% adicional,
   *  art. 71 LFT) sobre el salario ordinario de ese día. Informativo para nómina; nunca
   *  motivo de rechazo (ver nota de cabecera). */
  sundayPremiumApplies: boolean;
}

export interface UnmetStaffingDemand {
  workDate: string;
  position: string;
  requiredHeadcount: number;
  coveredHeadcount: number;
  shortfall: number;
  /** Por qué no se cubrió: sin personal del puesto en el pool, personal ya asignado ese
   *  día a otro puesto, o cubrirlo habría violado la LFT (con el detalle exacto). */
  reason: string;
}

export interface OvertimeComparison {
  generatedOvertimeMinutes: number;
  baselineOvertimeMinutes: number;
  /** Positivo = el horario generado tiene MENOS horas extra que el baseline manual. */
  reductionMinutes: number;
  /** 0-100. 0 cuando el baseline no tenía horas extra que reducir (evita división por 0
   *  disfrazada de "0% de mejora" -- se reporta aparte en `baselineHadNoOvertime`). */
  reductionPct: number;
  baselineHadNoOvertime: boolean;
}

export interface GenerateTurnosFromForecastResult {
  shifts: GeneratedShift[];
  unmetDemand: UnmetStaffingDemand[];
  /** `null` cuando no se pasó `manualBaseline` -- no hay nada que comparar. */
  overtimeComparison: OvertimeComparison | null;
}

function assertValidDemandEntry(entry: StaffingDemandEntry): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.workDate)) {
    throw new RangeError(`workDate inválido en demanda: "${entry.workDate}" (formato esperado YYYY-MM-DD)`);
  }
  if (!Number.isInteger(entry.requiredHeadcount) || entry.requiredHeadcount < 0) {
    throw new RangeError(
      `requiredHeadcount inválido para ${entry.position}/${entry.workDate}: debe ser un entero no negativo, recibido ${entry.requiredHeadcount}`,
    );
  }
  if (!entry.position || entry.position.trim().length === 0) {
    throw new RangeError(`position vacío en demanda de ${entry.workDate}`);
  }
}

/** Art. 71 LFT: domingo trabajado da derecho a una prima adicional del 25% sobre el
 *  salario de los días ordinarios. Calculado en UTC sobre la fecha calendario del turno
 *  (mismo criterio que `parseDateUTC` de `turnos-lft.ts`: se trata como fecha de calendario,
 *  no como instante con huso horario). */
function fallsOnSunday(workDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(workDate);
  if (!match) throw new RangeError(`workDate inválido: "${workDate}" (formato esperado YYYY-MM-DD)`);
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return dt.getUTCDay() === 0;
}

/**
 * Genera una plantilla de turnos a partir de una demanda de personal por día y puesto
 * (derivada del pronóstico de ocupación/demanda) y un catálogo de personal disponible.
 *
 * Determinista: misma demanda + mismo staffPool + mismo baseline siempre producen el mismo
 * resultado (desempates por `staffId` en orden ascendente). Puro: sin I/O, sin `Date.now()`
 * fuera de la fecha ya provista en cada entrada.
 *
 * Nunca produce un turno que viole la LFT: cada asignación candidata se valida de forma
 * incremental contra el historial YA comprometido de ese colaborador; si violaría la ley,
 * se descarta y la demanda de ese día/puesto queda parcialmente o totalmente en
 * `unmetDemand` en vez de publicarse ilegal.
 */
export function generateTurnosFromForecast(input: GenerateTurnosFromForecastInput): GenerateTurnosFromForecastResult {
  const schedule = input.weeklyHourLimitSchedule ?? DEFAULT_WEEKLY_HOUR_LIMIT_SCHEDULE;
  for (const entry of input.demand) assertValidDemandEntry(entry);

  // Orden cronológico: la legalidad de un turno (descanso semanal, horas extra semanales)
  // depende de lo que ya se comprometió en días anteriores, así que el orden de asignación
  // importa para el resultado y debe ser estable.
  const orderedDemand = [...input.demand].sort((a, b) => (a.workDate === b.workDate ? a.position.localeCompare(b.position) : a.workDate < b.workDate ? -1 : 1));

  const committedShifts: ProposedShift[] = [];
  // staffId -> total de minutos ya comprometidos (para repartir la carga, no concentrarla).
  const assignedMinutes = new Map<string, number>();
  // staffId -> conjunto de workDate ya asignados a ESTE colaborador (un solo turno/día).
  const assignedDatesByStaff = new Map<string, Set<string>>();
  const unmetDemand: UnmetStaffingDemand[] = [];
  const sundayShiftKeys = new Set<string>(); // `${staffId}|${workDate}` con prima dominical

  for (const entry of orderedDemand) {
    if (entry.requiredHeadcount === 0) continue;

    const eligible = input.staffPool
      .filter((s) => s.position === entry.position)
      .filter((s) => !(s.unavailableDates ?? []).includes(entry.workDate))
      .filter((s) => !(assignedDatesByStaff.get(s.staffId)?.has(entry.workDate) ?? false))
      // Menos cargado primero (reduce horas extra vs. concentrar en la misma persona);
      // empate resuelto por staffId para determinismo.
      .sort((a, b) => {
        const ma = assignedMinutes.get(a.staffId) ?? 0;
        const mb = assignedMinutes.get(b.staffId) ?? 0;
        if (ma !== mb) return ma - mb;
        return a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0;
      });

    let covered = 0;
    const rejectedForLft: string[] = [];

    for (const candidate of eligible) {
      if (covered >= entry.requiredHeadcount) break;

      const tentativeShift: ProposedShift = {
        staffId: candidate.staffId,
        workDate: entry.workDate,
        startTime: candidate.standardShift.startTime,
        endTime: candidate.standardShift.endTime,
      };
      const tentativeSet = [...committedShifts, tentativeShift];
      const check = validateTurnosLft({ shifts: tentativeSet, weeklyHourLimitSchedule: schedule });
      const ownViolations = check.violations.filter((v: ShiftLftViolation) => v.staffId === candidate.staffId);

      if (ownViolations.length > 0) {
        rejectedForLft.push(`${candidate.staffId} (${ownViolations.map((v) => v.article).join("; ")})`);
        continue;
      }

      committedShifts.push(tentativeShift);
      assignedMinutes.set(
        candidate.staffId,
        (assignedMinutes.get(candidate.staffId) ?? 0) + shiftDurationMinutes(tentativeShift.startTime, tentativeShift.endTime),
      );
      let dates = assignedDatesByStaff.get(candidate.staffId);
      if (!dates) {
        dates = new Set<string>();
        assignedDatesByStaff.set(candidate.staffId, dates);
      }
      dates.add(entry.workDate);
      if (fallsOnSunday(entry.workDate)) sundayShiftKeys.add(`${candidate.staffId}|${entry.workDate}`);
      covered += 1;
    }

    if (covered < entry.requiredHeadcount) {
      const shortfall = entry.requiredHeadcount - covered;
      const reason =
        eligible.length === 0
          ? `sin personal disponible del puesto "${entry.position}" para ${entry.workDate}`
          : rejectedForLft.length > 0
            ? `cubrir la demanda completa habría violado la LFT para: ${rejectedForLft.join(", ")}`
            : `personal del puesto "${entry.position}" insuficiente para ${entry.workDate}`;
      unmetDemand.push({
        workDate: entry.workDate,
        position: entry.position,
        requiredHeadcount: entry.requiredHeadcount,
        coveredHeadcount: covered,
        shortfall,
        reason,
      });
    }
  }

  // Defensa en profundidad: el algoritmo de arriba nunca debería comprometer un turno
  // ilegal (cada candidato se valida antes de comprometerse), pero la plantilla completa
  // se re-valida aquí para que un error futuro en la asignación NUNCA se traduzca en un
  // resultado silenciosamente ilegal -- si esto llega a fallar, es un bug de este módulo,
  // no una condición esperada de negocio.
  const finalCheck = validateTurnosLft({ shifts: committedShifts, weeklyHourLimitSchedule: schedule });
  if (!finalCheck.valid) {
    throw new Error(
      `generateTurnosFromForecast produjo una plantilla que viola la LFT (bug interno, no debería ocurrir): ` +
        finalCheck.violations.map((v) => `[${v.article}] ${v.message}`).join(" | "),
    );
  }

  const shifts: GeneratedShift[] = committedShifts.map((shift) => ({
    ...shift,
    sundayPremiumApplies: sundayShiftKeys.has(`${shift.staffId}|${shift.workDate}`),
  }));

  const overtimeComparison = input.manualBaseline ? compareOvertimeVsBaseline(shifts, input.manualBaseline) : null;

  return { shifts, unmetDemand, overtimeComparison };
}

/** Suma de minutos de tiempo extra (art. 61, sin capar al tope legal) sobre un conjunto de
 *  turnos, reutilizando el mismo agregado diario que usa la puerta de publicación. */
function totalOvertimeMinutes(shifts: readonly ProposedShift[]): number {
  return summarizeDailyHours(shifts).reduce((sum, day) => sum + day.overtimeMinutes, 0);
}

/**
 * Mide la reducción de horas extra del horario GENERADO frente a una plantilla manual de
 * referencia (REQ-BO-020: "reducir horas extra vs. baseline manual"). Usa la misma
 * agregación diaria (`summarizeDailyHours`) que `validateTurnosLft`, así que "horas extra"
 * significa exactamente lo mismo aquí que en la puerta de publicación -- no dos
 * definiciones distintas de la misma cifra.
 */
export function compareOvertimeVsBaseline(
  generated: readonly ProposedShift[],
  manualBaseline: readonly ManualBaselineShift[],
): OvertimeComparison {
  const generatedOvertimeMinutes = totalOvertimeMinutes(generated);
  const baselineOvertimeMinutes = totalOvertimeMinutes(manualBaseline);
  const reductionMinutes = baselineOvertimeMinutes - generatedOvertimeMinutes;
  const baselineHadNoOvertime = baselineOvertimeMinutes === 0;
  const reductionPct = baselineHadNoOvertime ? 0 : (reductionMinutes / baselineOvertimeMinutes) * 100;
  return { generatedOvertimeMinutes, baselineOvertimeMinutes, reductionMinutes, reductionPct, baselineHadNoOvertime };
}
