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
  assertLinenOptOutMessageDoesNotBlameGuest,
  describeLinenOptOutConfirmationMessage,
  evaluateLinenCountDeviation,
  DEFAULT_LINEN_DEVIATION_THRESHOLD_PCT,
  LinenOptOutMessageBlamesGuestError,
} from "@atiende-hoteles/domain-hotel";
import { sharedWhatsappAdapter, whatsappAdapterSimulated } from "../lib/messaging.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { HonoEnvBindings, ResolvedAppDeps } from "../types.ts";

const SUPERVISOR_ROLES = ["owner", "gm", "frontdesk"] as const;
// Mismos 4 roles operativos de piso que la RLS de housekeeping_linen_opt_out/
// housekeeping_linen_count autoriza (migración 0130) -- owner/gm/frontdesk pueden
// atender la solicitud del huésped en recepción; housekeeping la registra directo en la
// habitación. Ningún rol nuevo, ningún caso donde la app permita algo que la RLS ya
// negaría en silencio.
const LINEN_OPT_OUT_ROLES = [...SUPERVISOR_ROLES, "housekeeping"] as const;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
function hoyIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** REQ-HK-005: umbral (%) de desviación de consumo de blancos/amenidades a partir del
 *  cual el conteo se marca como alerta -- configurable por variable de entorno (mismo
 *  patrón que `maintenanceApprovalThresholdMxn`,
 *  packages/agent-core/src/tools/housekeepingTools.ts) para no fijar un número de
 *  negocio en código; `DEFAULT_LINEN_DEVIATION_THRESHOLD_PCT` (dominio puro) es el
 *  valor de respaldo cuando el hotel no lo configuró. */
export function linenDeviationAlertThresholdPct(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HOUSEKEEPING_LINEN_DEVIATION_THRESHOLD_PCT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LINEN_DEVIATION_THRESHOLD_PCT;
}

const optOutSchema = z.object({
  fecha: z.string().regex(FECHA_RE, "fecha debe tener formato YYYY-MM-DD").optional(),
  incentivo: z.string().trim().min(1).max(300),
  mensaje: z.string().trim().min(1).max(1000).optional(),
});

const linenItemTypeEnum = z.enum(["blancos", "amenidades"]);
const conteoBlancosSchema = z.object({
  tipo: linenItemTypeEnum,
  contado: z.number().int().nonnegative().max(100_000),
  teorico: z.number().int().nonnegative().max(100_000),
  fotoUrl: z.string().trim().min(1).max(2000).url(),
  taskId: z.string().uuid().optional(),
});

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

  // REQ-HK-005: registra que el huésped de una habitación pidió NO recibir limpieza/
  // reposición de blancos un día de su estancia, a cambio de un incentivo. El mensaje
  // de confirmación (el que se le mostraría/enviaría al huésped) se valida ANTES de
  // persistir con `assertLinenOptOutMessageDoesNotBlameGuest` -- fail-closed, un mensaje
  // que culpa al huésped nunca llega a la base de datos (400, no se registra nada).
  // Idempotente por (habitación, día): un segundo registro para el mismo día devuelve
  // el existente marcado `duplicate: true` en vez de fallar por la unique constraint o
  // silenciosamente sobreescribir una decisión ya tomada.
  app.post("/hoteles/:hotelId/housekeeping/habitaciones/:roomId/opt-out-limpieza", async (c) => {
    assertRole(c, [...LINEN_OPT_OUT_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const roomId = c.req.param("roomId");
    const body = parseBody(optOutSchema, await c.req.json().catch(() => ({})));
    const fecha = body.fecha ?? hoyIso();

    const { rows: roomRows } = await db.query<{ id: string }>(
      "select id from public.room where id = $1 and hotel_id = $2;",
      [roomId, hotelId],
    );
    if (roomRows.length === 0) throw Errors.notFound("Habitación no encontrada.");

    const { rows: existentes } = await db.query<{ id: string; incentive_description: string; message_text: string; created_at: string }>(
      `select id, incentive_description, message_text, created_at::text as created_at
       from public.housekeeping_linen_opt_out
       where hotel_id = $1 and room_id = $2 and stay_date = $3;`,
      [hotelId, roomId, fecha],
    );
    if (existentes.length > 0) {
      const existente = existentes[0]!;
      return c.json(
        {
          id: existente.id,
          roomId,
          fecha,
          incentivo: existente.incentive_description,
          mensaje: existente.message_text,
          creadoEn: existente.created_at,
          duplicate: true,
        },
        200,
      );
    }

    const mensaje = body.mensaje ?? describeLinenOptOutConfirmationMessage(body.incentivo);
    try {
      assertLinenOptOutMessageDoesNotBlameGuest(mensaje);
    } catch (err) {
      if (err instanceof LinenOptOutMessageBlamesGuestError) throw Errors.validation(err.message);
      throw err;
    }

    const { rows } = await db.query<{ id: string; created_at: string }>(
      `insert into public.housekeeping_linen_opt_out
         (tenant_id, hotel_id, room_id, stay_date, incentive_description, message_text, registered_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, created_at::text as created_at;`,
      [c.get("orgId"), hotelId, roomId, fecha, body.incentivo, mensaje, c.get("userId")],
    );

    return c.json(
      {
        id: rows[0]!.id,
        roomId,
        fecha,
        incentivo: body.incentivo,
        mensaje,
        creadoEn: rows[0]!.created_at,
        duplicate: false,
      },
      201,
    );
  });

  // Lista de opt-outs de limpieza del hotel (reporte operativo), opcionalmente filtrada
  // por habitación y/o fecha.
  app.get("/hoteles/:hotelId/housekeeping/opt-out-limpieza", async (c) => {
    assertRole(c, [...LINEN_OPT_OUT_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const roomIdFiltro = c.req.query("roomId");
    const fechaFiltro = c.req.query("fecha");
    if (fechaFiltro && !FECHA_RE.test(fechaFiltro)) throw Errors.validation("fecha debe tener formato YYYY-MM-DD.");

    const { rows } = await db.query<{
      id: string;
      room_id: string;
      room_code: string;
      stay_date: string;
      incentive_description: string;
      message_text: string;
      created_at: string;
    }>(
      `select o.id, o.room_id, r.code as room_code, o.stay_date::text as stay_date,
              o.incentive_description, o.message_text, o.created_at::text as created_at
       from public.housekeeping_linen_opt_out o
       join public.room r on r.id = o.room_id
       where o.hotel_id = $1
         and ($2::uuid is null or o.room_id = $2::uuid)
         and ($3::date is null or o.stay_date = $3::date)
       order by o.created_at desc;`,
      [hotelId, roomIdFiltro ?? null, fechaFiltro ?? null],
    );

    return c.json(
      rows.map((r) => ({
        id: r.id,
        roomId: r.room_id,
        roomCode: r.room_code,
        fecha: r.stay_date,
        incentivo: r.incentive_description,
        mensaje: r.message_text,
        creadoEn: r.created_at,
      })),
    );
  });

  // REQ-HK-005: registra un conteo de blancos/amenidades VERIFICADO POR FOTO
  // (`fotoUrl` obligatoria, ver `conteoBlancosSchema`) contra el consumo teórico
  // esperado, y calcula si la desviación cruza el umbral configurado
  // (`linenDeviationAlertThresholdPct`) -- `evaluateLinenCountDeviation` (dominio puro)
  // es la única lógica que decide "alerta sí/no", nunca un cálculo ad-hoc en la ruta.
  app.post("/hoteles/:hotelId/housekeeping/habitaciones/:roomId/conteo-blancos", async (c) => {
    assertRole(c, [...LINEN_OPT_OUT_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const roomId = c.req.param("roomId");
    const body = parseBody(conteoBlancosSchema, await c.req.json().catch(() => ({})));

    const { rows: roomRows } = await db.query<{ id: string }>(
      "select id from public.room where id = $1 and hotel_id = $2;",
      [roomId, hotelId],
    );
    if (roomRows.length === 0) throw Errors.notFound("Habitación no encontrada.");

    if (body.taskId) {
      const { rows: taskRows } = await db.query<{ id: string }>(
        "select id from public.housekeeping_task where id = $1 and hotel_id = $2;",
        [body.taskId, hotelId],
      );
      if (taskRows.length === 0) throw Errors.notFound("Tarea de housekeeping no encontrada en este hotel.");
    }

    const thresholdPct = linenDeviationAlertThresholdPct();
    const deviation = evaluateLinenCountDeviation({
      countedQuantity: body.contado,
      theoreticalQuantity: body.teorico,
      thresholdPct,
    });

    const { rows } = await db.query<{ id: string; created_at: string }>(
      `insert into public.housekeeping_linen_count
         (tenant_id, hotel_id, room_id, task_id, item_type, counted_quantity, theoretical_quantity,
          deviation_units, deviation_pct, threshold_pct, alert_triggered, photo_evidence_url, counted_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning id, created_at::text as created_at;`,
      [
        c.get("orgId"),
        hotelId,
        roomId,
        body.taskId ?? null,
        body.tipo,
        body.contado,
        body.teorico,
        deviation.deviationUnits,
        deviation.deviationPct,
        thresholdPct,
        deviation.alertTriggered,
        body.fotoUrl,
        c.get("userId"),
      ],
    );

    return c.json(
      {
        id: rows[0]!.id,
        roomId,
        tipo: body.tipo,
        contado: body.contado,
        teorico: body.teorico,
        desviacionUnidades: deviation.deviationUnits,
        desviacionPct: deviation.deviationPct,
        umbralPct: thresholdPct,
        alerta: deviation.alertTriggered,
        fotoUrl: body.fotoUrl,
        creadoEn: rows[0]!.created_at,
      },
      201,
    );
  });

  // Reporte de conteos de blancos/amenidades del hotel, opcionalmente filtrado a solo
  // los que dispararon alerta de desviación -- lo que un gerente revisaría cada día.
  app.get("/hoteles/:hotelId/housekeeping/conteo-blancos", async (c) => {
    assertRole(c, [...LINEN_OPT_OUT_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const soloAlertas = c.req.query("soloAlertas") === "true" ? true : null;

    const { rows } = await db.query<{
      id: string;
      room_id: string;
      room_code: string;
      item_type: string;
      counted_quantity: number;
      theoretical_quantity: number;
      deviation_units: number;
      deviation_pct: string;
      threshold_pct: string;
      alert_triggered: boolean;
      photo_evidence_url: string;
      created_at: string;
    }>(
      `select lc.id, lc.room_id, r.code as room_code, lc.item_type::text as item_type,
              lc.counted_quantity, lc.theoretical_quantity, lc.deviation_units,
              lc.deviation_pct::text as deviation_pct, lc.threshold_pct::text as threshold_pct,
              lc.alert_triggered, lc.photo_evidence_url, lc.created_at::text as created_at
       from public.housekeeping_linen_count lc
       join public.room r on r.id = lc.room_id
       where lc.hotel_id = $1
         and ($2::boolean is null or lc.alert_triggered = $2::boolean)
       order by lc.created_at desc;`,
      [hotelId, soloAlertas],
    );

    return c.json(
      rows.map((r) => ({
        id: r.id,
        roomId: r.room_id,
        roomCode: r.room_code,
        tipo: r.item_type,
        contado: r.counted_quantity,
        teorico: r.theoretical_quantity,
        desviacionUnidades: r.deviation_units,
        desviacionPct: Number(r.deviation_pct),
        umbralPct: Number(r.threshold_pct),
        alerta: r.alert_triggered,
        fotoUrl: r.photo_evidence_url,
        creadoEn: r.created_at,
      })),
    );
  });

  return app;
}
