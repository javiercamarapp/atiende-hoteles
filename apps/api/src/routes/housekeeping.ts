// H6b · /hoteles/:hotelId/housekeeping — tablero de habitaciones (estado de limpieza +
// tarea abierta) y ciclo de vida de `housekeeping_task` (REQ-HK-001/002/003/020). Crear
// una tarea reutiliza la MISMA tool de dominio de agent-core (`crear_tarea_housekeeping`)
// que usaria el agente conversacional -- una sola implementacion de la regla de negocio
// para ambos caminos (UI de staff y agente), invocada aqui con un `ToolContext` construido
// a partir de la sesion HTTP real en vez de un turno de modelo.
import { Hono } from "hono";
import { z } from "zod";
import { buildToolContext, createHousekeepingTaskTool, createRunBudget } from "@atiende-hoteles/agent-core";
import { HousekeepingReportError, assertValidTargetReadyTime } from "@atiende-hoteles/domain-hotel";
import { sharedWhatsappAdapter, whatsappAdapterSimulated } from "../lib/messaging.ts";
import { generateHousekeepingDailyReport, persistHousekeepingDailyReport } from "../lib/housekeepingDailyReport.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { HonoEnvBindings, ResolvedAppDeps } from "../types.ts";

const SUPERVISOR_ROLES = ["owner", "gm", "frontdesk"] as const;

const crearTareaSchema = z.object({
  roomCode: z.string().trim().min(1).max(20),
  priority: z.enum(["alta", "media", "baja"]).default("media"),
  checklist: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  notes: z.string().trim().max(500).optional(),
});

const asignarSchema = z.object({ assignedTo: z.string().uuid().nullable() });
const inspeccionarSchema = z.object({
  resultado: z.enum(["aprobada", "rechazada"]),
  nota: z.string().trim().max(500).optional(),
});
const fueraDeServicioSchema = z.object({ fueraDeServicio: z.boolean() });
const configSchema = z.object({ targetReadyTime: z.string().trim().min(1).max(8) });
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const generarReporteSchema = z.object({ fecha: z.string().regex(FECHA_RE) });

interface TableroRow {
  room_id: string;
  room_code: string;
  housekeeping_status: string;
  task_id: string | null;
  task_status: string | null;
  task_priority: string | null;
  assigned_to: string | null;
  assigned_email: string | null;
  sla_due_at: string | null;
}

export function housekeepingRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/housekeeping/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // Tablero por habitación (RLS ya filtra: housekeeping solo ve las filas cuya tarea le
  // pertenece; owner/gm/frontdesk ven todas — ver 0040/0041). No hay columna "piso" en el
  // esquema de habitaciones (0004): se ordena por código, documentado, no se fabrica un
  // dato de piso que el modelo de datos no tiene.
  app.get("/hoteles/:hotelId/housekeeping/tablero", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<TableroRow>(
      `select r.id as room_id, r.code as room_code, r.housekeeping_status::text as housekeeping_status,
              t.id as task_id, t.status::text as task_status, t.priority::text as task_priority,
              t.assigned_to, su.email as assigned_email, t.sla_due_at::text as sla_due_at
       from public.room r
       left join lateral (
         select * from public.housekeeping_task ht
         where ht.room_id = r.id and ht.status not in ('completada', 'cancelada')
         order by ht.created_at desc
         limit 1
       ) t on true
       left join public.staff_user su on su.id = t.assigned_to
       where r.hotel_id = $1
       order by r.code asc;`,
      [hotelId],
    );

    return c.json(
      rows.map((r) => ({
        roomId: r.room_id,
        roomCode: r.room_code,
        housekeepingStatus: r.housekeeping_status,
        tarea: r.task_id
          ? {
              id: r.task_id,
              estado: r.task_status,
              prioridad: r.task_priority,
              asignadoA: r.assigned_to,
              asignadoEmail: r.assigned_email,
              slaVence: r.sla_due_at,
            }
          : null,
      })),
    );
  });

  app.post("/hoteles/:hotelId/housekeeping/tareas", async (c) => {
    assertRole(c, [...SUPERVISOR_ROLES]);
    const db = c.get("db");
    const body = parseBody(crearTareaSchema, await c.req.json().catch(() => ({})));

    const ctx = buildToolContext(
      {
        orgId: c.get("orgId"),
        hotelId: c.req.param("hotelId"),
        actor: { type: "staff", id: c.get("userId") },
        requestId: c.get("requestId"),
      },
      createRunBudget({}),
    );

    const tool = createHousekeepingTaskTool({
      db,
      messaging: sharedWhatsappAdapter,
      simulated: whatsappAdapterSimulated,
      outboundSync: deps.outboundTaskSyncGateway,
    });
    const result = await tool.run(ctx, body);
    if (!result.ok) throw Errors.validation(result.summary);

    return c.json({ summary: result.summary, ...(result.data as object) }, 201);
  });

  app.patch("/hoteles/:hotelId/housekeeping/tareas/:taskId/asignar", async (c) => {
    assertRole(c, [...SUPERVISOR_ROLES]);
    const db = c.get("db");
    const body = parseBody(asignarSchema, await c.req.json().catch(() => ({})));
    const { rows } = await db.query<{ id: string }>(
      `update public.housekeeping_task set assigned_to = $1, updated_at = now()
       where id = $2 and hotel_id = $3
       returning id;`,
      [body.assignedTo, c.req.param("taskId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Tarea de housekeeping no encontrada.");
    return c.json({ id: rows[0]!.id, asignadoA: body.assignedTo });
  });

  app.post("/hoteles/:hotelId/housekeeping/tareas/:taskId/iniciar", async (c) => {
    assertRole(c, [...SUPERVISOR_ROLES, "housekeeping"]);
    const db = c.get("db");
    const { rows } = await db.query<{ id: string; status: string }>(
      `update public.housekeeping_task
       set status = 'en_progreso', started_at = coalesce(started_at, now()), updated_at = now()
       where id = $1 and hotel_id = $2 and status = 'pendiente'
       returning id, status;`,
      [c.req.param("taskId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Tarea no encontrada o ya no está pendiente.");
    return c.json({ id: rows[0]!.id, estado: rows[0]!.status });
  });

  app.post("/hoteles/:hotelId/housekeeping/tareas/:taskId/terminar", async (c) => {
    assertRole(c, [...SUPERVISOR_ROLES, "housekeeping"]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<{ id: string; room_id: string; status: string }>(
      `update public.housekeeping_task
       set status = 'completada', finished_at = now(), updated_at = now()
       where id = $1 and hotel_id = $2 and status = 'en_progreso'
       returning id, room_id, status;`,
      [c.req.param("taskId"), hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Tarea no encontrada o no estaba en progreso.");

    await db.query(
      "update public.room set housekeeping_status = 'limpia', updated_at = now() where id = $1;",
      [rows[0]!.room_id],
    );

    return c.json({ id: rows[0]!.id, estado: rows[0]!.status });
  });

  // Inspeccion: reservada a supervision (owner/gm/frontdesk) -- REQ-HK-003 exige muestreo
  // de supervision fisica con decision final humana, nunca un cierre automatico.
  app.post("/hoteles/:hotelId/housekeeping/tareas/:taskId/inspeccionar", async (c) => {
    assertRole(c, [...SUPERVISOR_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(inspeccionarSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<{ id: string; room_id: string }>(
      `update public.housekeeping_task
       set inspected_by = $1, inspected_at = now(), notes = coalesce($2, notes),
           inspection_result = $3, updated_at = now()
       where id = $4 and hotel_id = $5
       returning id, room_id;`,
      [c.get("userId"), body.nota ?? null, body.resultado, c.req.param("taskId"), hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Tarea de housekeeping no encontrada.");

    const nuevoEstado = body.resultado === "aprobada" ? "inspeccionada" : "sucia";
    await db.query("update public.room set housekeeping_status = $1, updated_at = now() where id = $2;", [
      nuevoEstado,
      rows[0]!.room_id,
    ]);

    return c.json({ id: rows[0]!.id, housekeepingStatus: nuevoEstado });
  });

  app.post("/hoteles/:hotelId/housekeeping/habitaciones/:roomId/fuera-de-servicio", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const body = parseBody(fueraDeServicioSchema, await c.req.json().catch(() => ({})));
    const nuevoEstado = body.fueraDeServicio ? "fuera_de_servicio" : "sucia";

    const { rows } = await db.query<{ id: string }>(
      `update public.room set housekeeping_status = $1, updated_at = now()
       where id = $2 and hotel_id = $3
       returning id;`,
      [nuevoEstado, c.req.param("roomId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Habitación no encontrada.");
    return c.json({ id: rows[0]!.id, housekeepingStatus: nuevoEstado });
  });

  // Config del reporte diario (REQ-HK-010): la "hora objetivo" de habitación lista es
  // por hotel, la decide el gerente -- solo owner/gm la leen/cambian (mismo criterio de
  // alcance que `hotel_pms_outbound_config`).
  app.get("/hoteles/:hotelId/housekeeping/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const { rows } = await db.query<{ target_ready_time: string }>(
      `select target_ready_time::text as target_ready_time
       from public.hotel_housekeeping_config where hotel_id = $1;`,
      [c.req.param("hotelId")],
    );
    return c.json({ targetReadyTime: rows[0]?.target_ready_time ?? "15:00:00" });
  });

  app.patch("/hoteles/:hotelId/housekeeping/config", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(configSchema, await c.req.json().catch(() => ({})));

    let targetReadyTime: string;
    try {
      targetReadyTime = assertValidTargetReadyTime(body.targetReadyTime);
    } catch (err) {
      if (err instanceof HousekeepingReportError) throw Errors.validation(err.message);
      throw err;
    }

    await db.query(
      `insert into public.hotel_housekeeping_config (hotel_id, tenant_id, target_ready_time)
       values ($1, $2, $3)
       on conflict (hotel_id) do update set target_ready_time = excluded.target_ready_time, updated_at = now();`,
      [hotelId, orgId, targetReadyTime],
    );
    return c.json({ targetReadyTime });
  });

  // Reporte diario al gerente (REQ-HK-010). GET consulta el snapshot ya persistido (no
  // genera nada); POST lo genera/regenera para la fecha pedida -- idempotente en el
  // sentido de que recalcula SIEMPRE contra el estado actual de la BD y sobrescribe el
  // snapshot anterior de ese mismo día (a diferencia de la muestra semanal de
  // conversaciones, aquí SÍ tiene sentido recalcular: una tarea que se cerró tarde debe
  // poder corregir el reporte del día antes de que el gerente lo lea en la mañana
  // siguiente). El mismo cálculo lo dispara, sin servidor HTTP de por medio,
  // `scripts/housekeeping/reporte-diario.ts` (cron real).
  app.get("/hoteles/:hotelId/housekeeping/reporte-diario", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const fecha = c.req.query("fecha");
    if (!fecha || !FECHA_RE.test(fecha)) throw Errors.validation("Parámetro 'fecha' requerido, formato YYYY-MM-DD.");

    const { rows } = await db.query(
      `select report_date::text as "reportDate", target_ready_time::text as "targetReadyTime",
              camaristas, rooms_cleaned as "roomsCleaned", rooms_ready_by_target as "roomsReadyByTarget",
              re_cleans as "reCleans", incidents, tickets_generated as "ticketsGenerated",
              generated_at::text as "generatedAt"
       from public.housekeeping_daily_report where hotel_id = $1 and report_date = $2;`,
      [hotelId, fecha],
    );
    if (rows.length === 0) throw Errors.notFound(`Reporte diario de housekeeping no generado para ${fecha}.`);
    return c.json(rows[0]);
  });

  app.post("/hoteles/:hotelId/housekeeping/reporte-diario", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(generarReporteSchema, await c.req.json().catch(() => ({})));

    let report: Awaited<ReturnType<typeof generateHousekeepingDailyReport>>;
    try {
      report = await generateHousekeepingDailyReport(db, hotelId, body.fecha);
    } catch (err) {
      if (err instanceof HousekeepingReportError) throw Errors.validation(err.message);
      throw err;
    }
    await persistHousekeepingDailyReport(db, orgId, report, c.get("userId"));

    return c.json(
      {
        reportDate: report.reportDate,
        targetReadyTime: report.targetReadyTime,
        camaristas: report.camaristas,
        roomsCleaned: report.roomsCleaned,
        roomsReadyByTarget: report.roomsReadyByTarget,
        reCleans: report.reCleans,
        incidents: report.incidents,
        ticketsGenerated: report.ticketsGenerated,
      },
      201,
    );
  });

  return app;
}
