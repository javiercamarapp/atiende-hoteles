// REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): cruce puro (sin I/O) de lo REALMENTE
// trabajado (eventos `entrada`/`salida` del checador, `attendance_log` en
// packages/db/migrations/0118_attendance_log.sql) contra el horario programado
// (`staff_schedule`, migracion 0090), para marcar horas extra NO autorizadas. Espejo de
// la regla de negocio para que apps/api y el frontend puedan explicar/probar el cálculo
// sin depender de Postgres, siguiendo el mismo criterio que `overbooking.ts`/`taxes.ts`.
//
// El registro (attendance_log) es la fuente de verdad inalterable; este módulo NUNCA
// decide qué es "verdad" sobre la base de datos -- solo aritmética determinista sobre
// los eventos y el horario que se le entregan.

export type AttendanceEventType = "entrada" | "salida";

export interface AttendanceEvent {
  eventType: AttendanceEventType;
  /** ISO-8601 (cualquier huso soportado por `Date.parse`, típicamente UTC de `timestamptz`). */
  recordedAt: string;
}

export interface AttendanceSchedule {
  /** ISO-8601. */
  scheduledStart: string;
  /** ISO-8601. */
  scheduledEnd: string;
  /** Horas extra pre-autorizadas para este turno (ej. por el GM al programarlo),
   *  en minutos. Nunca negativo -- ver constraint de la migración 0090. */
  authorizedOvertimeMinutes: number;
}

export interface AttendanceShift {
  startedAt: string;
  /** `null` = turno todavía abierto (sin `salida` registrada). */
  endedAt: string | null;
  /** `null` cuando `endedAt` es `null` (no se puede medir un turno que sigue en curso). */
  workedMinutes: number | null;
}

export type AttendanceAnomaly =
  // Una `salida` sin una `entrada` abierta previa -- dato del checador que no se puede
  // emparejar (ej. doble tecleo, evento perdido). Se reporta, nunca se descarta en
  // silencio ni se inventa una entrada.
  | { type: "salida_sin_entrada_abierta"; at: string }
  // Dos `entrada` seguidas sin una `salida` entre medio -- la segunda se ignora para el
  // cálculo (el turno sigue siendo el abierto por la primera), pero se reporta.
  | { type: "entrada_duplicada"; at: string };

export type AttendanceCrossCheckStatus = "sin_horario" | "en_curso" | "completo";

export interface AttendanceCrossCheckResult {
  status: AttendanceCrossCheckStatus;
  shifts: AttendanceShift[];
  anomalies: AttendanceAnomaly[];
  /** `null` cuando no hay horario programado (`status: "sin_horario"`). */
  scheduledStart: string | null;
  /** `null` cuando no hay horario programado (`status: "sin_horario"`). */
  scheduledEnd: string | null;
  /** `null` cuando no hay horario programado (`status: "sin_horario"`). */
  scheduledMinutes: number | null;
  /** Suma de `workedMinutes` de los turnos ya cerrados (un turno abierto no cuenta). */
  workedMinutes: number;
  /** `max(0, workedMinutes - scheduledMinutes)`; 0 mientras el turno sigue abierto o no
   *  hay horario contra el cual medir excedente. */
  overtimeMinutes: number;
  authorizedOvertimeMinutes: number;
  /** `max(0, overtimeMinutes - authorizedOvertimeMinutes)`. Sin horario programado,
   *  TODO lo trabajado es -- por definición -- horas no autorizadas (nadie autorizó un
   *  turno que no existía). */
  unauthorizedOvertimeMinutes: number;
  /** `true` cuando `unauthorizedOvertimeMinutes > 0` -- la señal que
   *  `apps/api/src/routes/asistencia.ts` expone para alertar. */
  alert: boolean;
}

function minutesBetween(startIso: string, endIso: string): number {
  return Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
}

/** Empareja una lista (en cualquier orden) de eventos `entrada`/`salida` en turnos,
 *  ordenando por `recordedAt` primero. Robusto a datos de checador imperfectos: nunca
 *  lanza, reporta cualquier evento que no pudo emparejar como `anomalies`. */
export function pairAttendanceEvents(events: AttendanceEvent[]): {
  shifts: AttendanceShift[];
  anomalies: AttendanceAnomaly[];
} {
  const sorted = [...events].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const shifts: AttendanceShift[] = [];
  const anomalies: AttendanceAnomaly[] = [];
  let openStart: string | null = null;

  for (const ev of sorted) {
    if (ev.eventType === "entrada") {
      if (openStart !== null) {
        anomalies.push({ type: "entrada_duplicada", at: ev.recordedAt });
        continue;
      }
      openStart = ev.recordedAt;
    } else {
      if (openStart === null) {
        anomalies.push({ type: "salida_sin_entrada_abierta", at: ev.recordedAt });
        continue;
      }
      shifts.push({ startedAt: openStart, endedAt: ev.recordedAt, workedMinutes: minutesBetween(openStart, ev.recordedAt) });
      openStart = null;
    }
  }

  if (openStart !== null) {
    shifts.push({ startedAt: openStart, endedAt: null, workedMinutes: null });
  }

  return { shifts, anomalies };
}

export interface CrossCheckAttendanceInput {
  /** `null` cuando el empleado no tiene horario programado para la fecha en cuestión. */
  schedule: AttendanceSchedule | null;
  events: AttendanceEvent[];
}

/** Cruza lo trabajado contra lo programado y marca el excedente NO autorizado --
 *  el corazón de REQ-BO-024. */
export function crossCheckAttendance(input: CrossCheckAttendanceInput): AttendanceCrossCheckResult {
  const { shifts, anomalies } = pairAttendanceEvents(input.events);
  const hasOpenShift = shifts.some((s) => s.endedAt === null);
  const workedMinutes = shifts.reduce((sum, s) => sum + (s.workedMinutes ?? 0), 0);

  if (!input.schedule) {
    // Trabajar sin ningún horario programado para ese día es, en sí mismo, el caso más
    // grave de excedente no autorizado -- no hay contra qué medir un margen, así que
    // nada de lo trabajado pudo haber sido autorizado de antemano.
    return {
      status: "sin_horario",
      shifts,
      anomalies,
      scheduledStart: null,
      scheduledEnd: null,
      scheduledMinutes: null,
      workedMinutes,
      overtimeMinutes: workedMinutes,
      authorizedOvertimeMinutes: 0,
      unauthorizedOvertimeMinutes: workedMinutes,
      alert: workedMinutes > 0,
    };
  }

  const scheduledMinutes = minutesBetween(input.schedule.scheduledStart, input.schedule.scheduledEnd);

  if (hasOpenShift) {
    // Turno en curso: no se sabe todavía cuánto se va a trabajar en total, así que no
    // se marca una alerta prematura -- el cruce definitivo ocurre cuando cierra
    // (`salida` registrada).
    return {
      status: "en_curso",
      shifts,
      anomalies,
      scheduledStart: input.schedule.scheduledStart,
      scheduledEnd: input.schedule.scheduledEnd,
      scheduledMinutes,
      workedMinutes,
      overtimeMinutes: 0,
      authorizedOvertimeMinutes: input.schedule.authorizedOvertimeMinutes,
      unauthorizedOvertimeMinutes: 0,
      alert: false,
    };
  }

  const overtimeMinutes = Math.max(0, workedMinutes - scheduledMinutes);
  const unauthorizedOvertimeMinutes = Math.max(0, overtimeMinutes - input.schedule.authorizedOvertimeMinutes);

  return {
    status: "completo",
    shifts,
    anomalies,
    scheduledStart: input.schedule.scheduledStart,
    scheduledEnd: input.schedule.scheduledEnd,
    scheduledMinutes,
    workedMinutes,
    overtimeMinutes,
    authorizedOvertimeMinutes: input.schedule.authorizedOvertimeMinutes,
    unauthorizedOvertimeMinutes,
    alert: unauthorizedOvertimeMinutes > 0,
  };
}

// ---- Exportación STPS (LFT art. 132 fr. XXXIV) -----------------------------------
//
// La LFT no impone un formato de archivo específico para el registro de asistencia (a
// diferencia de, por ejemplo, un CFDI): exige que el registro EXISTA y esté disponible
// para la inspección de la autoridad laboral. Un CSV tabular con identificación del
// patrón/trabajador, horario programado vs. real y horas extra autorizadas/no
// autorizadas es el formato que cualquier inspector de la STPS puede abrir e
// interpretar sin herramientas adicionales (Excel/hojas de cálculo, el mismo criterio
// que ya usa este repo para reportes financieros exportables).

export interface StpsExportRow {
  staffUserId: string;
  fullName: string;
  email: string;
  /** Fecha de negocio del turno, YYYY-MM-DD. */
  workDate: string;
  result: AttendanceCrossCheckResult;
}

const STPS_CSV_HEADERS = [
  "rfc_patronal",
  "empleado",
  "correo",
  "fecha",
  "entrada_programada",
  "salida_programada",
  "entrada_real",
  "salida_real",
  "horas_programadas",
  "horas_trabajadas",
  "horas_extra_autorizadas",
  "horas_extra_no_autorizadas",
  "estado",
] as const;

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function minutesToHours(minutes: number | null): string {
  return minutes === null ? "" : (minutes / 60).toFixed(2);
}

/** Genera el CSV (CRLF, RFC 4180) listo para entregar a una inspección de la STPS.
 *  Una fila por (empleado, turno) -- un empleado con más de un turno el mismo día
 *  aparece en más de una fila, nunca se colapsan silenciosamente en una sola. */
export function buildStpsAttendanceCsv(rows: StpsExportRow[], employerRfc: string): string {
  const lines = [STPS_CSV_HEADERS.join(",")];

  for (const row of rows) {
    const shiftsToReport: (AttendanceShift | { startedAt: string; endedAt: null; workedMinutes: null })[] =
      row.result.shifts.length > 0 ? row.result.shifts : [{ startedAt: "", endedAt: null, workedMinutes: null }];
    for (const shift of shiftsToReport) {
      lines.push(
        [
          csvEscape(employerRfc),
          csvEscape(row.fullName),
          csvEscape(row.email),
          row.workDate,
          csvEscape(row.result.scheduledStart ?? ""),
          csvEscape(row.result.scheduledEnd ?? ""),
          csvEscape(shift.startedAt),
          csvEscape(shift.endedAt ?? ""),
          minutesToHours(row.result.scheduledMinutes),
          minutesToHours(row.result.workedMinutes),
          minutesToHours(row.result.authorizedOvertimeMinutes),
          minutesToHours(row.result.unauthorizedOvertimeMinutes),
          row.result.status,
        ].join(","),
      );
    }
  }

  return lines.join("\r\n") + "\r\n";
}
