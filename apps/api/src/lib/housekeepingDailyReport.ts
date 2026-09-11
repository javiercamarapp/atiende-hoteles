// REQ-HK-010 · orquestación de BD (consulta + persistencia) para el reporte diario de
// housekeeping al gerente -- el dominio puro vive en
// `@atiende-hoteles/domain-hotel` (`buildHousekeepingDailyReport`); este módulo es la
// ÚNICA capa que traduce filas reales de `housekeeping_task`/`maintenance_ticket`/
// `hotel_housekeeping_config` a la entrada de esa función, y el resultado de vuelta a
// una fila de `housekeeping_daily_report` (migración 0130). Compartido a propósito
// entre la ruta interactiva (`routes/housekeeping.ts`, el gerente lo pide desde el
// panel) y el script operativo (`scripts/housekeeping/reporte-diario.ts`, cron real) --
// misma lógica exacta para ambos caminos, mismo criterio que `createHousekeepingTaskTool`
// se comparte entre la UI de staff y el agente conversacional.
import type { DbClient } from "@atiende-hoteles/db";
import {
  assertValidTargetReadyTime,
  buildHousekeepingDailyReport,
  resolveBusinessDayWindow,
  type HousekeepingDailyReport,
  type HousekeepingInspectionResult,
  type HousekeepingTaskDailyStatus,
  type HousekeepingTaskRecord,
} from "@atiende-hoteles/domain-hotel";

const DEFAULT_TARGET_READY_TIME = "15:00:00";

interface TaskRow {
  task_id: string;
  room_id: string;
  assigned_to: string | null;
  assigned_full_name: string | null;
  standard_clean_minutes: number;
  status: HousekeepingTaskDailyStatus;
  started_at: string | null;
  finished_at: string | null;
  inspection_result: HousekeepingInspectionResult;
}

/**
 * Arma el reporte del (hotel, día) consultando `housekeeping_task` (join a `room`/
 * `room_type` por el estándar de minutos, `staff_user` por el nombre de la camarista) y
 * `maintenance_ticket` (solo el conteo del día). Nunca decide qué día reportar --
 * `reportDate` viene siempre de quien llama (la ruta o el script), este helper solo
 * ejecuta las consultas y delega el cálculo al dominio puro.
 */
export async function generateHousekeepingDailyReport(
  db: DbClient,
  hotelId: string,
  reportDate: string,
): Promise<HousekeepingDailyReport> {
  const { start, end } = resolveBusinessDayWindow(reportDate);

  const { rows: configRows } = await db.query<{ target_ready_time: string }>(
    `select target_ready_time::text as target_ready_time
     from public.hotel_housekeeping_config where hotel_id = $1;`,
    [hotelId],
  );
  const targetReadyTime = assertValidTargetReadyTime(configRows[0]?.target_ready_time ?? DEFAULT_TARGET_READY_TIME);

  // Solo tareas cuyo CIERRE cayó en el día reportado -- ver el comentario de cabecera de
  // `reporteDiario.ts` sobre por qué "incidencias" (inspección rechazada) se cuenta
  // también contra esta misma ventana, en vez de la fecha de inspección por separado.
  const { rows: taskRows } = await db.query<TaskRow>(
    `select ht.id as task_id, ht.room_id, ht.assigned_to, su.full_name as assigned_full_name,
            rt.standard_clean_minutes, ht.status::text as status,
            ht.started_at::text as started_at, ht.finished_at::text as finished_at,
            ht.inspection_result::text as inspection_result
     from public.housekeeping_task ht
     join public.room r on r.id = ht.room_id
     join public.room_type rt on rt.id = r.room_type_id
     left join public.staff_user su on su.id = ht.assigned_to
     where ht.hotel_id = $1 and ht.finished_at >= $2 and ht.finished_at < $3;`,
    [hotelId, start.toISOString(), end.toISOString()],
  );

  const tasks: HousekeepingTaskRecord[] = taskRows.map((r) => ({
    taskId: r.task_id,
    roomId: r.room_id,
    assignedTo: r.assigned_to,
    assignedFullName: r.assigned_full_name,
    standardMinutes: r.standard_clean_minutes,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    inspectionResult: r.inspection_result,
  }));

  const { rows: ticketRows } = await db.query<{ total: string }>(
    `select count(*)::text as total from public.maintenance_ticket
     where hotel_id = $1 and created_at >= $2 and created_at < $3;`,
    [hotelId, start.toISOString(), end.toISOString()],
  );
  const maintenanceTicketsCreated = Number(ticketRows[0]?.total ?? "0");

  return buildHousekeepingDailyReport({ hotelId, reportDate, targetReadyTime, tasks, maintenanceTicketsCreated });
}

/** Persiste (upsert idempotente por `(hotel_id, report_date)`) el reporte ya calculado.
 *  `tenantId` se pasa explícito porque `HousekeepingDailyReport` (dominio puro) no
 *  conoce el concepto de tenant -- solo la capa de aplicación lo resuelve. */
export async function persistHousekeepingDailyReport(
  db: DbClient,
  tenantId: string,
  report: HousekeepingDailyReport,
  generatedBy: string | null,
): Promise<void> {
  await db.query(
    `insert into public.housekeeping_daily_report
       (tenant_id, hotel_id, report_date, target_ready_time, camaristas, rooms_cleaned,
        rooms_ready_by_target, re_cleans, incidents, tickets_generated, generated_by, generated_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
     on conflict (hotel_id, report_date) do update set
       target_ready_time = excluded.target_ready_time,
       camaristas = excluded.camaristas,
       rooms_cleaned = excluded.rooms_cleaned,
       rooms_ready_by_target = excluded.rooms_ready_by_target,
       re_cleans = excluded.re_cleans,
       incidents = excluded.incidents,
       tickets_generated = excluded.tickets_generated,
       generated_by = excluded.generated_by,
       generated_at = now(),
       updated_at = now();`,
    [
      tenantId,
      report.hotelId,
      report.reportDate,
      report.targetReadyTime,
      JSON.stringify(report.camaristas),
      report.roomsCleaned,
      report.roomsReadyByTarget,
      report.reCleans,
      report.incidents,
      report.ticketsGenerated,
      generatedBy,
    ],
  );
}
