// REQ-HK-010: "El sistema debe generar un reporte diario al gerente con minutos reales
// vs. estándar por camarista, habitaciones listas a una hora objetivo, re-limpiezas,
// incidencias y tickets generados." (docs/REQUISITOS.md, H11-008). Criterio literal de
// docs/ACEPTACION.md: las 5 métricas + "generado automáticamente cada día (verificado
// con dataset de un día completo)".
//
// Puro, sin I/O (mismo criterio que `attendance.ts`/`qa/conversationAudit.ts`): recibe
// las filas YA consultadas de `housekeeping_task` (con el minuto estándar de su
// `room_type` y el resultado de inspección, si lo hubo) más el conteo de tickets de
// mantenimiento del día, y devuelve el reporte agregado. La capa de aplicación
// (apps/api/src/routes/housekeeping.ts + scripts/housekeeping/reporte-diario.ts) es la
// única responsable de decidir QUÉ día se reporta y de persistir el resultado -- este
// módulo nunca lee un reloj ni una base de datos.
//
// Definiciones de negocio explícitas (documentadas aquí para no fabricar precisión que
// el criterio de aceptación no especifica):
//   - "minutos reales" = finished_at - started_at de cada tarea COMPLETADA ese día
//     (una tarea sin cerrar no aporta minutos reales, igual que un turno abierto no
//     cuenta en `attendance.ts`).
//   - "minutos estándar" = el estándar de LA HABITACIÓN limpiada (`room_type.
//     standard_clean_minutes`, migración 0130) -- una camarista que limpia solo suites
//     debe compararse contra el estándar de suites, no contra un promedio genérico del
//     hotel.
//   - "habitaciones listas a hora objetivo" = habitaciones con al menos una tarea
//     completada ese día cuyo `finished_at` (hora del día, no la fecha -- ya se filtró
//     por fecha antes de llegar aquí) fue <= `targetReadyTime` configurado del hotel
//     (`hotel_housekeeping_config.target_ready_time`, migración 0130).
//   - "re-limpiezas" = habitaciones que tuvieron MÁS de una tarea completada el mismo
//     día (la señal disponible hoy de que una habitación tuvo que limpiarse de nuevo --
//     ya sea por inspección rechazada o por una segunda solicitud manual). Se cuenta el
//     EXCEDENTE por habitación (2 tareas = 1 re-limpieza, 3 tareas = 2), mismo patrón
//     `max(0, real - esperado)` que `overtimeMinutes` en `attendance.ts`.
//   - "incidencias" = inspecciones de supervisión marcadas "rechazada" ese día (un
//     hallazgo de calidad real, distinto de un ticket de mantenimiento).
//   - "tickets generados" = `maintenance_ticket` creados ese día para el hotel (el
//     conteo se pasa ya resuelto por la capa de aplicación -- no son filas de
//     `housekeeping_task`, viven en una tabla distinta, 0043).

export class HousekeepingReportError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HousekeepingReportError";
    this.code = code;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

/** Normaliza "HH:MM" o "HH:MM:SS" a "HH:MM:SS"; lanza si el formato es inválido. Nunca
 *  asume un valor por defecto silencioso -- una hora objetivo mal escrita debe fallar
 *  ruidosamente, no reportar "todo listo a tiempo" por un typo. */
export function assertValidTargetReadyTime(value: string): string {
  const m = TIME_RE.exec(value);
  if (!m) {
    throw new HousekeepingReportError(
      "hora_objetivo_invalida",
      `hora objetivo inválida: "${value}" (se espera HH:MM o HH:MM:SS)`,
    );
  }
  return m[4] ? value : `${value}:00`;
}

export function assertValidReportDate(value: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new HousekeepingReportError("fecha_invalida", `reportDate inválido: "${value}" (se espera YYYY-MM-DD)`);
  }
  return value;
}

/** Ventana [inicio, fin) de 24h UTC que cubre el día de negocio `reportDate` -- mismo
 *  patrón que `resolveAuditWindow` en `qa/conversationAudit.ts`, usado por la capa de
 *  aplicación para acotar la consulta SQL de tareas/tickets del día. */
export function resolveBusinessDayWindow(reportDate: string): { start: Date; end: Date } {
  assertValidReportDate(reportDate);
  const start = new Date(`${reportDate}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export type HousekeepingTaskDailyStatus = "pendiente" | "en_progreso" | "completada" | "cancelada";
export type HousekeepingInspectionResult = "aprobada" | "rechazada" | null;

export interface HousekeepingTaskRecord {
  taskId: string;
  roomId: string;
  /** `null` cuando la tarea se completó sin asignación explícita -- se agrupa aparte,
   *  nunca se descarta ni se atribuye a una camarista al azar. */
  assignedTo: string | null;
  assignedFullName: string | null;
  /** `room_type.standard_clean_minutes` de la habitación limpiada. */
  standardMinutes: number;
  status: HousekeepingTaskDailyStatus;
  /** ISO-8601. `null` si la tarea no se llegó a iniciar. */
  startedAt: string | null;
  /** ISO-8601. `null` si la tarea no se llegó a terminar. */
  finishedAt: string | null;
  inspectionResult: HousekeepingInspectionResult;
}

export interface HousekeepingDailyReportInput {
  hotelId: string;
  /** YYYY-MM-DD, el día de negocio reportado. */
  reportDate: string;
  /** HH:MM o HH:MM:SS -- hora objetivo de habitación lista (`hotel_housekeeping_config`). */
  targetReadyTime: string;
  /** Tareas de housekeeping de CUALQUIER estado cuya actividad (creación, inicio o
   *  cierre) cayó en `reportDate` -- la función filtra internamente cuáles cuentan
   *  para cada métrica; no se le exige a quien llama que pre-filtre por estado. */
  tasks: HousekeepingTaskRecord[];
  /** Conteo de `maintenance_ticket` creados ese día para el hotel -- resuelto por la
   *  capa de aplicación (tabla distinta a `housekeeping_task`). */
  maintenanceTicketsCreated: number;
}

export interface CamaristaDailyStats {
  /** `"sin_asignar"` agrupa tareas completadas sin `assigned_to` -- nunca se
   *  mezclan con una camarista real. */
  staffUserId: string | "sin_asignar";
  fullName: string | null;
  roomsCleaned: number;
  actualMinutes: number;
  standardMinutes: number;
  /** `actualMinutes - standardMinutes`. Positivo = más lenta que el estándar;
   *  negativo = más rápida. Nunca se recorta a `max(0, ...)` -- a diferencia de las
   *  horas extra de `attendance.ts`, aquí un desempeño MEJOR que el estándar es una
   *  señal útil para el gerente, no un caso a descartar. */
  varianceMinutes: number;
}

export interface HousekeepingDailyReport {
  hotelId: string;
  reportDate: string;
  targetReadyTime: string;
  camaristas: CamaristaDailyStats[];
  roomsCleaned: number;
  roomsReadyByTarget: number;
  reCleans: number;
  incidents: number;
  ticketsGenerated: number;
}

function timeOfDayUtc(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

/**
 * Ensambla el reporte diario de housekeeping al gerente (REQ-HK-010). Determinístico:
 * la misma entrada produce siempre la misma salida -- ni relojes ni aleatoriedad.
 */
export function buildHousekeepingDailyReport(input: HousekeepingDailyReportInput): HousekeepingDailyReport {
  const reportDate = assertValidReportDate(input.reportDate);
  const targetReadyTime = assertValidTargetReadyTime(input.targetReadyTime);
  const { start, end } = resolveBusinessDayWindow(reportDate);

  if (input.maintenanceTicketsCreated < 0) {
    throw new HousekeepingReportError("conteo_invalido", "maintenanceTicketsCreated no puede ser negativo");
  }

  const completed = input.tasks.filter(
    (t): t is HousekeepingTaskRecord & { startedAt: string; finishedAt: string } =>
      t.status === "completada" && t.startedAt !== null && t.finishedAt !== null,
  );

  // Defensa: una tarea "completada" cuyo cierre cae fuera de la ventana del día
  // reportado es un error de quien llama (filtró mal la consulta) -- se reporta en vez
  // de contarla en silencio bajo el día equivocado.
  for (const t of completed) {
    const finishedAtMs = Date.parse(t.finishedAt);
    if (Number.isNaN(finishedAtMs) || finishedAtMs < start.getTime() || finishedAtMs >= end.getTime()) {
      throw new HousekeepingReportError(
        "tarea_fuera_de_fecha",
        `la tarea ${t.taskId} tiene finished_at (${t.finishedAt}) fuera del día reportado (${reportDate})`,
      );
    }
    if (Date.parse(t.startedAt) > finishedAtMs) {
      throw new HousekeepingReportError(
        "tarea_con_tiempos_invertidos",
        `la tarea ${t.taskId} tiene started_at posterior a finished_at`,
      );
    }
  }

  const roomsCompletedCount = new Map<string, number>();
  for (const t of completed) {
    roomsCompletedCount.set(t.roomId, (roomsCompletedCount.get(t.roomId) ?? 0) + 1);
  }
  const roomsCleaned = roomsCompletedCount.size;
  const reCleans = [...roomsCompletedCount.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  const roomsReadyByTarget = new Set(
    completed.filter((t) => timeOfDayUtc(t.finishedAt) <= targetReadyTime).map((t) => t.roomId),
  ).size;

  const incidents = input.tasks.filter((t) => t.inspectionResult === "rechazada").length;

  const camaristaMap = new Map<string, CamaristaDailyStats>();
  for (const t of completed) {
    const key = t.assignedTo ?? "sin_asignar";
    const actualMinutes = Math.round((Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 60_000);
    const existing = camaristaMap.get(key);
    if (existing) {
      existing.roomsCleaned += 1;
      existing.actualMinutes += actualMinutes;
      existing.standardMinutes += t.standardMinutes;
      existing.varianceMinutes = existing.actualMinutes - existing.standardMinutes;
    } else {
      camaristaMap.set(key, {
        staffUserId: key as string | "sin_asignar",
        fullName: t.assignedTo ? t.assignedFullName : null,
        roomsCleaned: 1,
        actualMinutes,
        standardMinutes: t.standardMinutes,
        varianceMinutes: actualMinutes - t.standardMinutes,
      });
    }
  }

  // Orden estable: por minutos reales descendente (quien más trabajó primero), empate
  // por staffUserId -- nunca por el orden de llegada de `input.tasks` (no determinista
  // si la consulta SQL no trae un ORDER BY explícito).
  const camaristas = [...camaristaMap.values()].sort(
    (a, b) => b.actualMinutes - a.actualMinutes || a.staffUserId.localeCompare(b.staffUserId),
  );

  return {
    hotelId: input.hotelId,
    reportDate,
    targetReadyTime,
    camaristas,
    roomsCleaned,
    roomsReadyByTarget,
    reCleans,
    incidents,
    ticketsGenerated: input.maintenanceTicketsCreated,
  };
}
