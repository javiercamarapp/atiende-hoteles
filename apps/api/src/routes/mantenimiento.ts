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
import { ADMIN_ROLES, MANAGE_ROOM_STATUS_ROLES } from "../domain/roles.ts";
import type { HonoEnvBindings, ResolvedAppDeps } from "../types.ts";

// auditoria-2/frontend [ALTO]: `estimatedCost` YA NO tiene `.default(0)` -- el
// formulario de "Reportar" no pedía ningún costo, así que todo ticket quedaba en $0.00
// (se veía como una medición real, no como "nadie lo estimó"). Sin valor, se persiste
// `null` ("sin estimar") en vez de inventar un cero -- ver migración 0080.
const crearTicketSchema = z.object({
  roomCode: z.string().trim().min(1).max(20).optional(),
  title: z.string().trim().min(1).max(150),
  description: z.string().trim().min(1).max(1000),
  origin: z.enum(["huesped", "staff", "agente", "sensor"]).default("staff"),
  severity: z.enum(["alta", "media", "baja"]).default("media"),
  estimatedCost: z.number().nonnegative().max(1_000_000).optional(),
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
  title: string;
  description: string;
  origin: string;
  severity: string;
  status: string;
  assigned_to: string | null;
  estimated_cost: string | null;
  actual_cost: string | null;
  approval_id: string | null;
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
      `select mt.id, r.code as room_code, mt.title, mt.description, mt.origin::text as origin,
              mt.severity::text as severity, mt.status::text as status, mt.assigned_to,
              mt.estimated_cost::text as estimated_cost, mt.actual_cost::text as actual_cost,
              mt.approval_id, mt.created_at::text as created_at
       from public.maintenance_ticket mt
       left join public.room r on r.id = mt.room_id
       where mt.hotel_id = $1
       order by mt.created_at desc;`,
      [c.req.param("hotelId")],
    );
    return c.json(
      rows.map((t) => ({
        id: t.id,
        roomCode: t.room_code,
        titulo: t.title,
        descripcion: t.description,
        origen: t.origin,
        severidad: t.severity,
        estado: t.status,
        asignadoA: t.assigned_to,
        costoEstimado: t.estimated_cost != null ? Number(t.estimated_cost) : null,
        costoReal: t.actual_cost != null ? Number(t.actual_cost) : null,
        aprobacionId: t.approval_id,
        creadoEn: t.created_at,
      })),
    );
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
