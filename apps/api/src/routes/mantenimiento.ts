// H6b · /hoteles/:hotelId/mantenimiento — tickets de mantenimiento correctivo
// (REQ-HK-011/013/014). Crear ticket reutiliza la MISMA tool de dominio de agent-core
// (`crear_ticket_mantenimiento`) que usaria el agente conversacional. Cerrar con costo es
// SIEMPRE dinero con aprobacion humana doble (GOB-026): este endpoint NUNCA cierra
// directo, solo abre (o reusa, idempotente) la solicitud en `agent_approval` --
// routes/aprobaciones.ts es quien ejecuta `autorizar_gasto_mantenimiento` de verdad una
// vez completada la doble confirmacion de dos roles distintos.
import { Hono } from "hono";
import { z } from "zod";
import {
  AUTHORIZE_MAINTENANCE_EXPENSE_TOOL_NAME,
  PostgresApprovalQueue,
  buildToolContext,
  createMaintenanceTicketTool,
  createRunBudget,
  type AuthorizeMaintenanceExpenseInput,
  type CreateMaintenanceTicketInput,
} from "@atiende-hoteles/agent-core";
import { buildToolExecutors } from "../lib/agentTools.ts";
import { sharedWhatsappAdapter, whatsappAdapterSimulated } from "../lib/messaging.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MANAGE_MAINTENANCE_ASSETS_ROLES, MANAGE_ROOM_STATUS_ROLES } from "../domain/roles.ts";
import type { HonoEnvBindings, ResolvedAppDeps } from "../types.ts";

// auditoria-2/frontend [ALTO]: `estimatedCost` YA NO tiene `.default(0)` -- el
// formulario de "Reportar" no pedía ningún costo, así que todo ticket quedaba en $0.00
// (se veía como una medición real, no como "nadie lo estimó"). Sin valor, se persiste
// `null` ("sin estimar") en vez de inventar un cero -- ver migración 0080.
const crearTicketSchema = z.object({
  roomCode: z.string().trim().min(1).max(20).optional(),
  // REQ-HK-012: código del activo/equipo (opcional, ver comentario de `assetCode` en
  // `createMaintenanceTicketInput`, packages/agent-core/src/tools/housekeepingTools.ts).
  assetCode: z.string().trim().min(1).max(20).optional(),
  title: z.string().trim().min(1).max(150),
  description: z.string().trim().min(1).max(1000),
  origin: z.enum(["huesped", "staff", "agente", "sensor"]).default("staff"),
  severity: z.enum(["alta", "media", "baja"]).default("media"),
  estimatedCost: z.number().nonnegative().max(1_000_000).optional(),
});

// REQ-HK-012: catálogo mínimo de activos/equipos (packages/db/migrations/0130) -- ver
// comentario de cabecera de esa migración sobre por qué es deliberadamente ligero.
const crearActivoSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(150),
  category: z.string().trim().min(1).max(80).optional(),
  roomCode: z.string().trim().min(1).max(20).optional(),
});

const asignarSchema = z.object({ assignedTo: z.string().uuid().nullable() });
const cambiarEstadoSchema = z.object({ status: z.enum(["abierto", "asignado", "en_progreso", "cancelado"]) });
const cerrarConCostoSchema = z.object({
  actualCost: z.number().positive().max(1_000_000),
  partUsed: z.string().trim().max(200).optional(),
  resolutionNote: z.string().trim().max(1000).optional(),
});

interface TicketRow {
  id: string;
  room_code: string | null;
  asset_id: string | null;
  asset_code: string | null;
  title: string;
  description: string;
  origin: string;
  severity: string;
  status: string;
  assigned_to: string | null;
  estimated_cost: string | null;
  actual_cost: string | null;
  approval_id: string | null;
  escalated_at: string | null;
  escalated_to_roles: string[];
  created_at: string;
}

interface AssetRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
  room_code: string | null;
  created_at: string;
}

export function mantenimientoRoutes(deps: ResolvedAppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/mantenimiento/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/mantenimiento", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<TicketRow>(
      `select mt.id, r.code as room_code, mt.asset_id, ma.code as asset_code, mt.title, mt.description,
              mt.origin::text as origin, mt.severity::text as severity, mt.status::text as status,
              mt.assigned_to, mt.estimated_cost::text as estimated_cost, mt.actual_cost::text as actual_cost,
              mt.approval_id, mt.escalated_at::text as escalated_at, mt.escalated_to_roles, mt.created_at::text as created_at
       from public.maintenance_ticket mt
       left join public.room r on r.id = mt.room_id
       left join public.maintenance_asset ma on ma.id = mt.asset_id
       where mt.hotel_id = $1
       order by mt.created_at desc;`,
      [c.req.param("hotelId")],
    );
    return c.json(
      rows.map((t) => ({
        id: t.id,
        roomCode: t.room_code,
        assetId: t.asset_id,
        assetCode: t.asset_code,
        titulo: t.title,
        descripcion: t.description,
        origen: t.origin,
        severidad: t.severity,
        estado: t.status,
        asignadoA: t.assigned_to,
        costoEstimado: t.estimated_cost != null ? Number(t.estimated_cost) : null,
        costoReal: t.actual_cost != null ? Number(t.actual_cost) : null,
        aprobacionId: t.approval_id,
        escaladoEn: t.escalated_at,
        escaladoARoles: t.escalated_to_roles,
        creadoEn: t.created_at,
      })),
    );
  });

  // REQ-HK-012: catálogo de activos/equipos del hotel (packages/db/migrations/0130).
  app.get("/hoteles/:hotelId/mantenimiento/activos", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<AssetRow>(
      `select ma.id, ma.code, ma.name, ma.category, r.code as room_code, ma.created_at::text as created_at
       from public.maintenance_asset ma
       left join public.room r on r.id = ma.room_id
       where ma.hotel_id = $1
       order by ma.code;`,
      [c.req.param("hotelId")],
    );
    return c.json(
      rows.map((a) => ({
        id: a.id,
        code: a.code,
        nombre: a.name,
        categoria: a.category,
        roomCode: a.room_code,
        creadoEn: a.created_at,
      })),
    );
  });

  app.post("/hoteles/:hotelId/mantenimiento/activos", async (c) => {
    assertRole(c, MANAGE_MAINTENANCE_ASSETS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(crearActivoSchema, await c.req.json().catch(() => ({})));

    let roomId: string | null = null;
    if (body.roomCode) {
      const { rows: roomRows } = await db.query<{ id: string }>(
        "select id from public.room where hotel_id = $1 and code = $2;",
        [hotelId, body.roomCode],
      );
      if (!roomRows[0]) throw Errors.validation(`No existe la habitación "${body.roomCode}" en este hotel.`);
      roomId = roomRows[0].id;
    }

    const { rows } = await db.query<{ id: string }>(
      `insert into public.maintenance_asset (tenant_id, hotel_id, room_id, code, name, category)
       values ($1, $2, $3, $4, $5, $6)
       returning id;`,
      [c.get("orgId"), hotelId, roomId, body.code, body.name, body.category ?? null],
    );
    return c.json({ id: rows[0]!.id, code: body.code, nombre: body.name }, 201);
  });

  // REQ-HK-012 "enriquecer cada ticket con el historial del activo asociado": historial
  // completo de tickets de un activo, más recientes primero, más la política de
  // escalación efectiva (configurada del hotel o el default) para que el panel pueda
  // mostrar cuánto falta para la próxima escalación automática.
  app.get("/hoteles/:hotelId/mantenimiento/activos/:assetId/historial", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const assetId = c.req.param("assetId");

    const { rows: assetRows } = await db.query<{ code: string; name: string }>(
      "select code, name from public.maintenance_asset where id = $1 and hotel_id = $2;",
      [assetId, hotelId],
    );
    if (!assetRows[0]) throw Errors.notFound("Activo no encontrado.");

    const { rows: historyRows } = await db.query<{
      id: string;
      title: string;
      severity: string;
      status: string;
      escalated_at: string | null;
      created_at: string;
    }>(
      `select id, title, severity::text as severity, status::text as status,
              escalated_at::text as escalated_at, created_at::text as created_at
       from public.maintenance_ticket
       where hotel_id = $1 and asset_id = $2
       order by created_at desc;`,
      [hotelId, assetId],
    );

    const { rows: policyRows } = await db.query<{ threshold_count: number; window_days: number }>(
      "select threshold_count, window_days from public.maintenance_escalation_policy where hotel_id = $1;",
      [hotelId],
    );
    const policy = policyRows[0] ?? { threshold_count: 3, window_days: 14 };

    return c.json({
      activo: { id: assetId, code: assetRows[0].code, nombre: assetRows[0].name },
      politicaEscalacion: { umbral: policy.threshold_count, ventanaDias: policy.window_days },
      historial: historyRows.map((h) => ({
        ticketId: h.id,
        titulo: h.title,
        severidad: h.severity,
        estado: h.status,
        escaladoEn: h.escalated_at,
        creadoEn: h.created_at,
      })),
    });
  });

  app.post("/hoteles/:hotelId/mantenimiento", async (c) => {
    assertRole(c, [...MANAGE_ROOM_STATUS_ROLES]);
    const db = c.get("db");
    const body = parseBody(crearTicketSchema, await c.req.json().catch(() => ({})));

    const ctx = buildToolContext(
      {
        orgId: c.get("orgId"),
        hotelId: c.req.param("hotelId"),
        actor: { type: "staff", id: c.get("userId") },
        requestId: c.get("requestId"),
      },
      createRunBudget({}),
    );

    const tool = createMaintenanceTicketTool({
      db,
      messaging: sharedWhatsappAdapter,
      simulated: whatsappAdapterSimulated,
      outboundSync: deps.outboundTaskSyncGateway,
    });
    // auditoria-2/frontend [ALTO]: `CreateMaintenanceTicketInput.estimatedCost`
    // (packages/agent-core, fuera de este lote) sigue tipado `number` no-nulo con
    // `.default(0)` en su propio esquema Zod -- pero esa tool nunca re-valida `input`
    // en tiempo de ejecución (`defineTool()` solo copia el spec, ver tool.ts), así que
    // pasar `null` explícito aquí SÍ persiste "sin estimar" de verdad (migración 0080
    // volvió la columna nullable). El cast documenta la brecha de tipos hasta que
    // agent-core actualice su propio esquema a `.optional()`/nullable.
    const toolInput = { ...body, estimatedCost: body.estimatedCost ?? null } as unknown as CreateMaintenanceTicketInput;
    const result = await tool.run(ctx, toolInput);
    if (!result.ok) throw Errors.validation(result.summary);

    return c.json({ summary: result.summary, ...(result.data as object) }, 201);
  });

  app.patch("/hoteles/:hotelId/mantenimiento/:ticketId/asignar", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const body = parseBody(asignarSchema, await c.req.json().catch(() => ({})));
    // Descubierto incidentalmente al probar A6 (delegado de aprobación, que asigna un
    // técnico para que la RLS de maintenance_ticket lo deje cerrar el ticket): $1 usado
    // SOLO dentro de `case when $1 is not null ...` (sin otra ocurrencia que le dé tipo
    // por columna) hace que Postgres no pueda inferir su tipo bajo el protocolo
    // extendido ("could not determine data type of parameter $1") -- este endpoint
    // fallaba con 500 en TODA llamada, sin ningún test que lo hubiera ejercitado antes.
    const { rows } = await db.query<{ id: string }>(
      `update public.maintenance_ticket
       set assigned_to = $1::uuid, status = case when $1::uuid is not null and status = 'abierto' then 'asignado' else status end,
           updated_at = now()
       where id = $2 and hotel_id = $3
       returning id;`,
      [body.assignedTo, c.req.param("ticketId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Ticket de mantenimiento no encontrado.");
    return c.json({ id: rows[0]!.id, asignadoA: body.assignedTo });
  });

  app.patch("/hoteles/:hotelId/mantenimiento/:ticketId/estado", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const body = parseBody(cambiarEstadoSchema, await c.req.json().catch(() => ({})));
    const { rows } = await db.query<{ id: string; status: string }>(
      `update public.maintenance_ticket set status = $1, updated_at = now()
       where id = $2 and hotel_id = $3
       returning id, status;`,
      [body.status, c.req.param("ticketId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Ticket de mantenimiento no encontrado.");
    return c.json({ id: rows[0]!.id, estado: rows[0]!.status });
  });

  // Cerrar con costo: dinero, SIEMPRE requiere aprobacion doble (GOB-026) -- este
  // endpoint solo ABRE (o reusa, idempotente) la solicitud; routes/aprobaciones.ts ejecuta
  // la tool de verdad cuando se completan las 2 confirmaciones de roles distintos.
  app.post("/hoteles/:hotelId/mantenimiento/:ticketId/cerrar-con-costo", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const ticketId = c.req.param("ticketId");
    const body = parseBody(cerrarConCostoSchema, await c.req.json().catch(() => ({})));

    const { rows: ticketRows } = await db.query<{ id: string; title: string; status: string }>(
      "select id, title, status from public.maintenance_ticket where id = $1 and hotel_id = $2;",
      [ticketId, hotelId],
    );
    if (ticketRows.length === 0) throw Errors.notFound("Ticket de mantenimiento no encontrado.");
    if (ticketRows[0]!.status === "cerrado") throw Errors.conflict("El ticket ya está cerrado.");

    const input: AuthorizeMaintenanceExpenseInput = {
      ticketId,
      actualCost: body.actualCost,
      partUsed: body.partUsed,
      resolutionNote: body.resolutionNote,
    };

    const approvalQueue = new PostgresApprovalQueue(db);
    const inputSummary =
      `Ticket "${ticketRows[0]!.title}": autorizar $${body.actualCost.toFixed(2)} MXN` +
      (body.partUsed ? ` (refacción: ${body.partUsed}).` : ".");
    const approval = await approvalQueue.request({
      toolName: AUTHORIZE_MAINTENANCE_EXPENSE_TOOL_NAME,
      input,
      orgId,
      hotelId,
      requestedBy: `staff:${c.get("userId")}:ticket-${ticketId}`,
      isMoney: true,
      textoMostrado: inputSummary,
      inputSummary,
    });

    await db.query(
      "update public.maintenance_ticket set approval_id = $1, requires_approval = true, updated_at = now() where id = $2;",
      [approval.id, ticketId],
    );

    if (approval.status === "aprobada") {
      // Ya estaba aprobada (reintento idempotente tras completarse la doble confirmacion
      // por otra via) -- ejecuta ahora mismo, no deja al llamador sin cierre.
      const tools = buildToolExecutors({ db, messaging: sharedWhatsappAdapter, simulated: true });
      const tool = tools[AUTHORIZE_MAINTENANCE_EXPENSE_TOOL_NAME]!;
      const ctx = buildToolContext(
        { orgId, hotelId, actor: { type: "staff", id: c.get("userId") }, requestId: c.get("requestId") },
        createRunBudget({}),
      );
      const result = await tool.run(ctx, input);
      return c.json({ estado: "ejecutado", summary: result.summary, aprobacionId: approval.id });
    }
    if (approval.status === "rechazada") {
      return c.json({ estado: "rechazado", aprobacionId: approval.id }, 409);
    }
    return c.json({ estado: "pendiente_aprobacion", aprobacionId: approval.id }, 202);
  });

  return app;
}
