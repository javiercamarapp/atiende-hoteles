// REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): checador/registro de asistencia
// inalterable, cruzado contra el horario programado, exportable a la STPS.
//
//  - POST .../asistencia/checar: fichaje de autoservicio (cualquier rol de staff del
//    hotel puede registrar SU PROPIA entrada/salida; `record_attendance_event()`,
//    migracion 0091, ignora cualquier identidad que no sea la de la sesion real).
//  - GET  .../asistencia: historial (propio para cualquier rol; owner/gm ven el de
//    cualquiera del hotel).
//  - POST .../asistencia/horarios: programa el turno de un empleado (owner/gm).
//  - GET  .../asistencia/cruce: cruza lo trabajado contra lo programado
//    (`@atiende-hoteles/domain-hotel::crossCheckAttendance`) y expone la alerta de
//    horas extra NO autorizadas.
//  - GET  .../asistencia/exportar-stps: el mismo cruce, en CSV listo para una
//    inspeccion de la Secretaria del Trabajo y Prevision Social (owner/gm).
import { Hono } from "hono";
import { z } from "zod";
import {
  buildStpsAttendanceCsv,
  crossCheckAttendance,
  type AttendanceEvent,
  type AttendanceCrossCheckResult,
} from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";
import type { DbClient } from "@atiende-hoteles/db";

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

const checarSchema = z.object({
  eventType: z.enum(["entrada", "salida"]),
  source: z.string().trim().min(1).max(50).optional(),
  note: z.string().trim().max(500).optional(),
});

const historialQuerySchema = z.object({
  staffUserId: z.string().uuid().optional(),
  desde: z.string().regex(FECHA_RE).optional(),
  hasta: z.string().regex(FECHA_RE).optional(),
});

const horarioSchema = z.object({
  staffUserId: z.string().uuid(),
  workDate: z.string().regex(FECHA_RE),
  scheduledStart: z.string().datetime({ offset: true }).or(z.string().datetime()),
  scheduledEnd: z.string().datetime({ offset: true }).or(z.string().datetime()),
  authorizedOvertimeMinutes: z.number().int().nonnegative().max(24 * 60).default(0),
});

const cruceQuerySchema = z.object({
  staffUserId: z.string().uuid().optional(),
  desde: z.string().regex(FECHA_RE),
  hasta: z.string().regex(FECHA_RE),
});

interface AttendanceRow {
  id: string;
  staff_user_id: string;
  event_type: "entrada" | "salida";
  recorded_at: string;
  source: string;
  note: string | null;
}

interface ScheduleRow {
  staff_user_id: string;
  work_date: string;
  scheduled_start: string;
  scheduled_end: string;
  authorized_overtime_minutes: number;
}

interface StaffIdentityRow {
  id: string;
  full_name: string;
  email: string;
}

/** Un turno puede empezar tarde o terminar tarde; la ventana se abre 6h antes del
 *  inicio programado y se cierra 12h despues del fin programado para poder capturar
 *  llegadas tempranas y horas extra reales, sin arrastrar el turno de otro dia. */
const VENTANA_ANTES_HORAS = 6;
const VENTANA_DESPUES_HORAS = 12;

async function fetchSchedules(
  db: DbClient,
  hotelId: string,
  desde: string,
  hasta: string,
  staffUserId?: string,
): Promise<ScheduleRow[]> {
  const params: unknown[] = [hotelId, desde, hasta];
  let filtro = "";
  if (staffUserId) {
    params.push(staffUserId);
    filtro = "and staff_user_id = $4";
  }
  const { rows } = await db.query<ScheduleRow>(
    `select staff_user_id, work_date::text as work_date,
            scheduled_start::text as scheduled_start, scheduled_end::text as scheduled_end,
            authorized_overtime_minutes
     from public.staff_schedule
     where hotel_id = $1 and work_date between $2 and $3 ${filtro}
     order by staff_user_id, work_date;`,
    params,
  );
  return rows;
}

async function fetchEventsInWindow(
  db: DbClient,
  hotelId: string,
  staffUserId: string,
  windowStart: string,
  windowEnd: string,
): Promise<AttendanceEvent[]> {
  const { rows } = await db.query<{ event_type: "entrada" | "salida"; recorded_at: string }>(
    `select event_type, recorded_at::text as recorded_at
     from public.attendance_log
     where hotel_id = $1 and staff_user_id = $2
       and recorded_at >= $3::timestamptz - make_interval(hours => ${VENTANA_ANTES_HORAS})
       and recorded_at <= $4::timestamptz + make_interval(hours => ${VENTANA_DESPUES_HORAS})
     order by recorded_at asc;`,
    [hotelId, staffUserId, windowStart, windowEnd],
  );
  return rows.map((r) => ({ eventType: r.event_type, recordedAt: r.recorded_at }));
}

/** Dias con asistencia registrada pero SIN ningun horario programado en el rango --
 *  REQ-BO-024 exige marcar esto tambien: trabajar sin horario programado es, por
 *  definicion, tiempo no autorizado (ver crossCheckAttendance con schedule=null). */
async function fetchWorkedDaysWithoutSchedule(
  db: DbClient,
  hotelId: string,
  desde: string,
  hasta: string,
  staffUserId?: string,
): Promise<{ staffUserId: string; workDate: string }[]> {
  const params: unknown[] = [hotelId, desde, hasta];
  let filtro = "";
  if (staffUserId) {
    params.push(staffUserId);
    filtro = "and al.staff_user_id = $4";
  }
  const { rows } = await db.query<{ staff_user_id: string; work_date: string }>(
    `select distinct al.staff_user_id, (al.recorded_at::date)::text as work_date
     from public.attendance_log al
     where al.hotel_id = $1
       and al.recorded_at::date between $2::date and $3::date
       ${filtro}
       and not exists (
         select 1 from public.staff_schedule ss
         where ss.hotel_id = al.hotel_id and ss.staff_user_id = al.staff_user_id
           and ss.work_date = al.recorded_at::date
       );`,
    params,
  );
  return rows.map((r) => ({ staffUserId: r.staff_user_id, workDate: r.work_date }));
}

async function fetchEventsForDate(
  db: DbClient,
  hotelId: string,
  staffUserId: string,
  workDate: string,
): Promise<AttendanceEvent[]> {
  const { rows } = await db.query<{ event_type: "entrada" | "salida"; recorded_at: string }>(
    `select event_type, recorded_at::text as recorded_at
     from public.attendance_log
     where hotel_id = $1 and staff_user_id = $2 and recorded_at::date = $3::date
     order by recorded_at asc;`,
    [hotelId, staffUserId, workDate],
  );
  return rows.map((r) => ({ eventType: r.event_type, recordedAt: r.recorded_at }));
}

interface CrossCheckReportEntry {
  staffUserId: string;
  workDate: string;
  result: AttendanceCrossCheckResult;
}

/** Corazon compartido de /cruce y /exportar-stps: un renglon por (empleado, fecha) que
 *  tuvo horario programado O asistencia registrada dentro del rango. */
async function computeCrossCheckReport(
  db: DbClient,
  hotelId: string,
  desde: string,
  hasta: string,
  staffUserId?: string,
): Promise<CrossCheckReportEntry[]> {
  const schedules = await fetchSchedules(db, hotelId, desde, hasta, staffUserId);
  const entries: CrossCheckReportEntry[] = [];

  for (const schedule of schedules) {
    const events = await fetchEventsInWindow(
      db,
      hotelId,
      schedule.staff_user_id,
      schedule.scheduled_start,
      schedule.scheduled_end,
    );
    const result = crossCheckAttendance({
      schedule: {
        scheduledStart: schedule.scheduled_start,
        scheduledEnd: schedule.scheduled_end,
        authorizedOvertimeMinutes: schedule.authorized_overtime_minutes,
      },
      events,
    });
    entries.push({ staffUserId: schedule.staff_user_id, workDate: schedule.work_date, result });
  }

  const sinHorario = await fetchWorkedDaysWithoutSchedule(db, hotelId, desde, hasta, staffUserId);
  for (const dia of sinHorario) {
    const events = await fetchEventsForDate(db, hotelId, dia.staffUserId, dia.workDate);
    const result = crossCheckAttendance({ schedule: null, events });
    entries.push({ staffUserId: dia.staffUserId, workDate: dia.workDate, result });
  }

  entries.sort((a, b) => (a.workDate === b.workDate ? a.staffUserId.localeCompare(b.staffUserId) : a.workDate.localeCompare(b.workDate)));
  return entries;
}

export function asistenciaRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/asistencia/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // Fichaje de autoservicio: SIEMPRE a nombre de quien inicio sesion (0091 no acepta
  // ningun otro identificador de empleado), abierto a cualquier rol del hotel.
  app.post("/hoteles/:hotelId/asistencia/checar", async (c) => {
    const db = c.get("db");
    const body = parseBody(checarSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<AttendanceRow>(
      "select * from public.record_attendance_event($1, $2, $3, $4);",
      [c.req.param("hotelId"), body.eventType, body.source ?? "app", body.note ?? null],
    );
    const row = rows[0]!;
    return c.json(
      {
        id: row.id,
        staffUserId: row.staff_user_id,
        eventType: row.event_type,
        recordedAt: row.recorded_at,
        source: row.source,
        note: row.note,
      },
      201,
    );
  });

  app.get("/hoteles/:hotelId/asistencia", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const query = parseBody(historialQuerySchema, {
      staffUserId: c.req.query("staffUserId"),
      desde: c.req.query("desde"),
      hasta: c.req.query("hasta"),
    });

    // Segunda capa (ademas de la RLS "self_or_admin_select" de 0091): un rol sin
    // administracion que pida explicitamente el staffUserId de otro empleado recibe un
    // 403 claro en vez de una lista vacia silenciosa.
    const esAdmin = ADMIN_ROLES.includes(c.get("hotelRole") as (typeof ADMIN_ROLES)[number]);
    const staffUserId = query.staffUserId ?? (esAdmin ? undefined : c.get("userId"));
    if (!esAdmin && staffUserId !== c.get("userId")) {
      throw Errors.forbidden("Solo owner/gm pueden consultar la asistencia de otro empleado.");
    }

    const params: unknown[] = [hotelId];
    const filtros: string[] = [];
    if (staffUserId) {
      params.push(staffUserId);
      filtros.push(`staff_user_id = $${params.length}`);
    }
    if (query.desde) {
      params.push(query.desde);
      filtros.push(`recorded_at::date >= $${params.length}::date`);
    }
    if (query.hasta) {
      params.push(query.hasta);
      filtros.push(`recorded_at::date <= $${params.length}::date`);
    }

    const { rows } = await db.query<AttendanceRow>(
      `select id, staff_user_id, event_type, recorded_at::text as recorded_at, source, note
       from public.attendance_log
       where hotel_id = $1 ${filtros.map((f) => `and ${f}`).join(" ")}
       order by recorded_at desc;`,
      params,
    );

    return c.json(
      rows.map((r) => ({
        id: r.id,
        staffUserId: r.staff_user_id,
        eventType: r.event_type,
        recordedAt: r.recorded_at,
        source: r.source,
        note: r.note,
      })),
    );
  });

  app.post("/hoteles/:hotelId/asistencia/horarios", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const body = parseBody(horarioSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<ScheduleRow & { id: string }>(
      `select id, staff_user_id, work_date::text as work_date,
              scheduled_start::text as scheduled_start, scheduled_end::text as scheduled_end,
              authorized_overtime_minutes
       from public.upsert_staff_schedule($1, $2, $3, $4, $5, $6);`,
      [
        c.req.param("hotelId"),
        body.staffUserId,
        body.workDate,
        body.scheduledStart,
        body.scheduledEnd,
        body.authorizedOvertimeMinutes,
      ],
    );
    const row = rows[0]!;
    return c.json(
      {
        id: row.id,
        staffUserId: row.staff_user_id,
        workDate: row.work_date,
        scheduledStart: row.scheduled_start,
        scheduledEnd: row.scheduled_end,
        authorizedOvertimeMinutes: row.authorized_overtime_minutes,
      },
      201,
    );
  });

  // Cruce de horas trabajadas vs. programadas -- el corazon de REQ-BO-024. Un rol sin
  // administracion siempre queda forzado a su propio staffUserId (mismo criterio que
  // GET /asistencia); owner/gm pueden ver el de cualquiera o el hotel completo.
  app.get("/hoteles/:hotelId/asistencia/cruce", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const query = parseBody(cruceQuerySchema, {
      staffUserId: c.req.query("staffUserId"),
      desde: c.req.query("desde"),
      hasta: c.req.query("hasta"),
    });
    if (query.hasta < query.desde) throw Errors.validation("hasta debe ser posterior o igual a desde.");

    const esAdmin = ADMIN_ROLES.includes(c.get("hotelRole") as (typeof ADMIN_ROLES)[number]);
    const staffUserId = query.staffUserId ?? (esAdmin ? undefined : c.get("userId"));
    if (!esAdmin && staffUserId !== c.get("userId")) {
      throw Errors.forbidden("Solo owner/gm pueden consultar el cruce de asistencia de otro empleado.");
    }

    const entries = await computeCrossCheckReport(db, hotelId, query.desde, query.hasta, staffUserId);

    return c.json(
      entries.map((e) => ({
        staffUserId: e.staffUserId,
        fecha: e.workDate,
        estado: e.result.status,
        horasProgramadas: e.result.scheduledMinutes !== null ? e.result.scheduledMinutes / 60 : null,
        horasTrabajadas: e.result.workedMinutes / 60,
        horasExtraAutorizadas: e.result.authorizedOvertimeMinutes / 60,
        horasExtraNoAutorizadas: e.result.unauthorizedOvertimeMinutes / 60,
        alerta: e.result.alert,
        anomalias: e.result.anomalies,
      })),
    );
  });

  // Exportacion STPS (LFT art. 132 fr. XXXIV): reservada a owner/gm -- es el documento
  // formal que un inspector laboral puede pedir ver.
  app.get("/hoteles/:hotelId/asistencia/exportar-stps", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const query = parseBody(cruceQuerySchema, {
      staffUserId: c.req.query("staffUserId"),
      desde: c.req.query("desde"),
      hasta: c.req.query("hasta"),
    });
    if (query.hasta < query.desde) throw Errors.validation("hasta debe ser posterior o igual a desde.");

    const entries = await computeCrossCheckReport(db, hotelId, query.desde, query.hasta, query.staffUserId);

    const staffIds = [...new Set(entries.map((e) => e.staffUserId))];
    const identidades = new Map<string, StaffIdentityRow>();
    if (staffIds.length > 0) {
      const { rows } = await db.query<StaffIdentityRow>(
        `select id, full_name, email from public.staff_user where id = any($1::uuid[]);`,
        [staffIds],
      );
      for (const r of rows) identidades.set(r.id, r);
    }

    const { rows: taxRows } = await db.query<{ rfc_emisor: string | null }>(
      "select rfc_emisor from public.hotel_tax_config where hotel_id = $1;",
      [hotelId],
    );
    const rfcEmisor = taxRows[0]?.rfc_emisor ?? "sin_rfc_configurado";

    const csv = buildStpsAttendanceCsv(
      entries.map((e) => {
        const identidad = identidades.get(e.staffUserId);
        return {
          staffUserId: e.staffUserId,
          fullName: identidad?.full_name ?? e.staffUserId,
          email: identidad?.email ?? "",
          workDate: e.workDate,
          result: e.result,
        };
      }),
      rfcEmisor,
    );

    return c.text(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="asistencia-stps-${hotelId}-${query.desde}_${query.hasta}.csv"`,
    });
  });

  return app;
}
