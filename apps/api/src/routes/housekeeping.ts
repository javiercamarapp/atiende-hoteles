// H6b · /hoteles/:hotelId/housekeeping — tablero de habitaciones (estado de limpieza +
// tarea abierta) y ciclo de vida de `housekeeping_task` (REQ-HK-001/002/003/020). Crear
// una tarea reutiliza la MISMA tool de dominio de agent-core (`crear_tarea_housekeeping`)
// que usaria el agente conversacional -- una sola implementacion de la regla de negocio
// para ambos caminos (UI de staff y agente), invocada aqui con un `ToolContext` construido
// a partir de la sesion HTTP real en vez de un turno de modelo.
import { Hono } from "hono";
import { z } from "zod";
import { buildToolContext, createHousekeepingTaskTool, createRunBudget } from "@atiende-hoteles/agent-core";
import { sharedWhatsappAdapter, whatsappAdapterSimulated } from "../lib/messaging.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

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

export function housekeepingRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
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

    const tool = createHousekeepingTaskTool({ db, messaging: sharedWhatsappAdapter, simulated: whatsappAdapterSimulated });
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
       set inspected_by = $1, inspected_at = now(), notes = coalesce($2, notes), updated_at = now()
       where id = $3 and hotel_id = $4
       returning id, room_id;`,
      [c.get("userId"), body.nota ?? null, c.req.param("taskId"), hotelId],
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

  return app;
}
