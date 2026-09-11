// H6b · /hoteles/:hotelId/housekeeping — tablero de habitaciones (estado de limpieza +
// tarea abierta) y ciclo de vida de `housekeeping_task` (REQ-HK-001/002/003/020). Crear
// una tarea reutiliza la MISMA tool de dominio de agent-core (`crear_tarea_housekeeping`)
// que usaria el agente conversacional -- una sola implementacion de la regla de negocio
// para ambos caminos (UI de staff y agente), invocada aqui con un `ToolContext` construido
// a partir de la sesion HTTP real en vez de un turno de modelo.
import { Hono } from "hono";
import { z } from "zod";
import { buildToolContext, createHousekeepingTaskTool, createRunBudget } from "@atiende-hoteles/agent-core";
import {
  InspeccionVisionError,
  PhysicalSupervisionNoteRequiredError,
  assertHumanClosureAllowed,
  evaluateVisionInspection,
  requiresPhysicalSupervision,
  type InspectionPhotoSubmission,
} from "@atiende-hoteles/domain-hotel";
import { sharedWhatsappAdapter, whatsappAdapterSimulated } from "../lib/messaging.ts";
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

// REQ-HK-003: el set estándar de 6 fotos (BP-075/H11-004) más los ítems del checklist
// propio de la tarea que quien sube evidencia declara haber atendido. `tipo` no se
// restringe aquí a `STANDARD_INSPECTION_PHOTO_TYPES` con un enum de zod a propósito --
// un tipo desconocido es en sí mismo una corrección específica que
// `evaluateVisionInspection` reporta (no un 400 genérico que oculte cuál vino mal).
const fotoInspeccionSchema = z.object({
  tipo: z.string().trim().min(1).max(60),
  url: z.string().trim().url().max(2000),
  tomadaEn: z.string().datetime({ offset: true }).or(z.string().datetime()),
});
const fotosInspeccionSchema = z.object({
  fotos: z.array(fotoInspeccionSchema).min(1).max(20),
  checklistCubierto: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});

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

  // REQ-HK-003: envío del set estándar de 6 fotos tras terminar la limpieza. Produce
  // una SUGERENCIA (aprobada/corrección específica) vía el módulo puro de dominio en
  // <30 s medido -- NUNCA cierra la tarea ni toca `housekeeping_status`/`inspected_*`;
  // el cierre real sigue siendo exclusivo de `POST .../inspeccionar` más abajo (decisión
  // final siempre humana, BP-101). Abierto a housekeeping (quien limpió, sobre SU propia
  // tarea -- RLS de 0041 ya lo garantiza) y a supervisión.
  app.post("/hoteles/:hotelId/housekeeping/tareas/:taskId/fotos-inspeccion", async (c) => {
    assertRole(c, [...SUPERVISOR_ROLES, "housekeeping"]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const taskId = c.req.param("taskId");
    const body = parseBody(fotosInspeccionSchema, await c.req.json().catch(() => ({})));

    const medicionInicio = Date.now();

    const { rows: tareas } = await db.query<{
      id: string;
      status: string;
      started_at: string | null;
      created_at: string;
      checklist: string[];
      vision_verdict: string | null;
      vision_items: unknown;
      vision_evaluated_at: string | null;
      vision_elapsed_ms: number | null;
      requires_physical_supervision: boolean;
    }>(
      `select id, status::text as status, started_at::text as started_at, created_at::text as created_at,
              coalesce(checklist, '[]'::jsonb) as checklist, vision_verdict::text as vision_verdict,
              vision_items, vision_evaluated_at::text as vision_evaluated_at, vision_elapsed_ms,
              requires_physical_supervision
       from public.housekeeping_task
       where id = $1 and hotel_id = $2;`,
      [taskId, hotelId],
    );
    if (tareas.length === 0) throw Errors.notFound("Tarea de housekeeping no encontrada.");
    const tarea = tareas[0]!;

    if (tarea.status !== "completada") {
      throw Errors.validation(
        `La tarea debe estar "completada" (terminar la limpieza) antes de enviar el set de fotos de inspección (estado actual: "${tarea.status}").`,
      );
    }

    // Idempotente (mismo criterio que `auditoriaConversaciones.ts`): la evidencia de
    // una inspección ya evaluada no se vuelve a juzgar ni se reemplaza -- se devuelve
    // el veredicto ya fijado.
    if (tarea.vision_verdict) {
      return c.json({
        id: tarea.id,
        veredicto: tarea.vision_verdict,
        items: tarea.vision_items,
        evaluadoEn: tarea.vision_evaluated_at,
        elapsedMs: tarea.vision_elapsed_ms,
        requierePhysicalSupervision: tarea.requires_physical_supervision,
        yaEvaluada: true,
      });
    }

    const fotos: InspectionPhotoSubmission[] = body.fotos.map((f) => ({ tipo: f.tipo, url: f.url, tomadaEn: f.tomadaEn }));
    const limpiezaIniciadaEn = tarea.started_at ?? tarea.created_at;
    const ahoraIso = new Date().toISOString();

    let resultado: ReturnType<typeof evaluateVisionInspection>;
    try {
      resultado = evaluateVisionInspection({
        fotos,
        checklist: tarea.checklist,
        checklistCubierto: body.checklistCubierto,
        limpiezaIniciadaEn,
        ahora: ahoraIso,
      });
    } catch (err) {
      if (err instanceof InspeccionVisionError) throw Errors.validation(err.message);
      throw err;
    }

    const requierePhysicalSupervision = requiresPhysicalSupervision(tarea.id);
    const elapsedMs = Date.now() - medicionInicio;

    const { rows: actualizadas } = await db.query<{ id: string; vision_evaluated_at: string }>(
      `update public.housekeeping_task
       set evidence = $1::jsonb, vision_verdict = $2, vision_items = $3::jsonb,
           vision_evaluated_at = now(), vision_elapsed_ms = $4, requires_physical_supervision = $5,
           updated_at = now()
       where id = $6 and hotel_id = $7
       returning id, vision_evaluated_at::text as vision_evaluated_at;`,
      [
        JSON.stringify(fotos),
        resultado.veredicto,
        JSON.stringify(resultado.items),
        elapsedMs,
        requierePhysicalSupervision,
        taskId,
        hotelId,
      ],
    );
    if (actualizadas.length === 0) throw Errors.notFound("Tarea de housekeeping no encontrada.");

    return c.json(
      {
        id: actualizadas[0]!.id,
        veredicto: resultado.veredicto,
        items: resultado.items,
        checklistPendiente: resultado.checklistPendiente,
        evaluadoEn: actualizadas[0]!.vision_evaluated_at,
        elapsedMs,
        requierePhysicalSupervision,
        yaEvaluada: false,
      },
      201,
    );
  });

  // Inspeccion: reservada a supervision (owner/gm/frontdesk) -- REQ-HK-003 exige muestreo
  // de supervision fisica con decision final humana, nunca un cierre automatico. Cuando
  // la tarea entró al muestreo de supervisión física (25% determinístico, ver
  // `requiresPhysicalSupervision`), el cierre EXIGE una nota real que documente la
  // revisión física -- un clic vacío que solo repite la sugerencia de la evidencia
  // fotográfica no cuenta como "decisión final humana" para el 20-30% muestreado.
  app.post("/hoteles/:hotelId/housekeeping/tareas/:taskId/inspeccionar", async (c) => {
    assertRole(c, [...SUPERVISOR_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const taskId = c.req.param("taskId");
    const body = parseBody(inspeccionarSchema, await c.req.json().catch(() => ({})));

    const { rows: tareas } = await db.query<{ requires_physical_supervision: boolean }>(
      `select requires_physical_supervision from public.housekeeping_task where id = $1 and hotel_id = $2;`,
      [taskId, hotelId],
    );
    if (tareas.length === 0) throw Errors.notFound("Tarea de housekeeping no encontrada.");

    try {
      assertHumanClosureAllowed({ requiresPhysicalSupervision: tareas[0]!.requires_physical_supervision, nota: body.nota });
    } catch (err) {
      if (err instanceof PhysicalSupervisionNoteRequiredError) throw Errors.validation(err.message);
      throw err;
    }

    const { rows } = await db.query<{ id: string; room_id: string }>(
      `update public.housekeeping_task
       set inspected_by = $1, inspected_at = now(), notes = coalesce($2, notes), updated_at = now()
       where id = $3 and hotel_id = $4
       returning id, room_id;`,
      [c.get("userId"), body.nota ?? null, taskId, hotelId],
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
