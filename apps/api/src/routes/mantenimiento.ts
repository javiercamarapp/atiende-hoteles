// H6b · /hoteles/:hotelId/mantenimiento — tickets de mantenimiento correctivo
// (REQ-HK-011/013/014). Crear ticket reutiliza la MISMA tool de dominio de agent-core
// (`crear_ticket_mantenimiento`) que usaria el agente conversacional. Cerrar con costo es
// SIEMPRE dinero con aprobacion humana doble (GOB-026): este endpoint NUNCA cierra
// directo, solo abre (o reusa, idempotente) la solicitud en `agent_approval` --
// routes/aprobaciones.ts es quien ejecuta `autorizar_gasto_mantenimiento` de verdad una
// vez completada la doble confirmacion de dos roles distintos.
//
// REQ-HK-015 (docs/ACEPTACION.md): activos críticos + calendario de MP + recomendación
// reparar/reemplazar -- las rutas /activos, /temporadas y /calendario-preventivo de
// abajo. Toda la lógica de fechas/costo vive en
// `packages/domain-hotel/src/mantenimiento/preventivo.ts` (puro); estas rutas solo leen
// de Postgres, arman el input y devuelven el resultado -- ver esa nota de cabecera para
// el límite honesto de la ocupación disponible hoy (solo HOY, no un forecast futuro por
// habitación física, porque `reservation` liga a `room_type_id`, no a una habitación
// concreta).
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
import {
  adjustDueDateForRoomOccupancy,
  computeNextPreventiveDueDate,
  recommendRepairOrReplace,
  type SeasonWindow,
} from "@atiende-hoteles/domain-hotel";
import { buildToolExecutors } from "../lib/agentTools.ts";
import { sharedWhatsappAdapter, whatsappAdapterSimulated } from "../lib/messaging.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MANAGE_ROOM_STATUS_ROLES } from "../domain/roles.ts";
import type { DbClient } from "@atiende-hoteles/db";
import type { HonoEnvBindings, ResolvedAppDeps } from "../types.ts";

// REQ-HK-015: espejo de la RLS de `critical_asset`/`critical_asset_maintenance_event`
// (0130) -- gestionar el catálogo de activos y las ventanas de temporada es owner/gm;
// registrar que un checklist de MP ya se hizo (con su costo) también lo puede hacer el
// técnico de mantenimiento, igual que puede reportar un ticket correctivo.
const MANAGE_MAINTENANCE_PLAN_ROLES = ADMIN_ROLES;
const LOG_PREVENTIVE_EVENT_ROLES = [...ADMIN_ROLES, "maintenance"] as const;

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

const CRITICAL_ASSET_CATEGORIES = ["minisplit", "bomba", "calentador", "ptar", "generador", "cerradura", "alberca", "cocina", "otro"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const crearActivoSchema = z.object({
  name: z.string().trim().min(1).max(150),
  category: z.enum(CRITICAL_ASSET_CATEGORIES).default("otro"),
  roomCode: z.string().trim().min(1).max(20).optional(),
  installDate: z.string().regex(DATE_RE, "formato esperado YYYY-MM-DD"),
  replacementCost: z.number().positive().max(10_000_000),
  baseFrequencyDays: z.number().int().positive().max(3650),
});

const registrarPreventivoSchema = z.object({
  cost: z.number().nonnegative().max(1_000_000).default(0),
  note: z.string().trim().max(1000).optional(),
});

const crearTemporadaSchema = z.object({
  label: z.string().trim().min(1).max(100),
  startMonthDay: z.string().regex(MONTH_DAY_RE, "formato esperado MM-DD"),
  endMonthDay: z.string().regex(MONTH_DAY_RE, "formato esperado MM-DD"),
  frequencyDays: z.number().int().positive().max(3650),
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

  // --- REQ-HK-015: activos críticos, temporadas y calendario de MP ---------------

  interface AssetRow {
    id: string;
    room_id: string | null;
    room_code: string | null;
    room_status: string | null;
    name: string;
    category: string;
    install_date: string;
    replacement_cost: string;
    base_frequency_days: number;
    active: boolean;
  }

  app.get("/hoteles/:hotelId/mantenimiento/activos", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<AssetRow>(
      `select ca.id, ca.room_id, r.code as room_code, r.status::text as room_status, ca.name, ca.category::text as category,
              ca.install_date::text as install_date, ca.replacement_cost::text as replacement_cost,
              ca.base_frequency_days, ca.active
       from public.critical_asset ca
       left join public.room r on r.id = ca.room_id
       where ca.hotel_id = $1
       order by ca.name asc;`,
      [c.req.param("hotelId")],
    );
    return c.json(
      rows.map((a) => ({
        id: a.id,
        nombre: a.name,
        categoria: a.category,
        habitacionCodigo: a.room_code,
        fechaInstalacion: a.install_date,
        costoReemplazo: Number(a.replacement_cost),
        frecuenciaBaseDias: a.base_frequency_days,
        activo: a.active,
      })),
    );
  });

  app.post("/hoteles/:hotelId/mantenimiento/activos", async (c) => {
    assertRole(c, MANAGE_MAINTENANCE_PLAN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(crearActivoSchema, await c.req.json().catch(() => ({})));

    let roomId: string | null = null;
    if (body.roomCode) {
      const { rows } = await db.query<{ id: string }>("select id from public.room where hotel_id = $1 and code = $2;", [hotelId, body.roomCode]);
      if (rows.length === 0) throw Errors.validation(`No existe la habitación "${body.roomCode}" en este hotel.`);
      roomId = rows[0]!.id;
    }

    const { rows } = await db.query<{ id: string }>(
      `insert into public.critical_asset
         (tenant_id, hotel_id, room_id, name, category, install_date, replacement_cost, base_frequency_days, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id;`,
      [c.get("orgId"), hotelId, roomId, body.name, body.category, body.installDate, body.replacementCost, body.baseFrequencyDays, c.get("userId")],
    );
    return c.json({ id: rows[0]!.id }, 201);
  });

  app.post("/hoteles/:hotelId/mantenimiento/activos/:assetId/registrar-preventivo", async (c) => {
    assertRole(c, [...LOG_PREVENTIVE_EVENT_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const assetId = c.req.param("assetId");
    const body = parseBody(registrarPreventivoSchema, await c.req.json().catch(() => ({})));

    const { rows: assetRows } = await db.query<{ id: string }>("select id from public.critical_asset where id = $1 and hotel_id = $2;", [assetId, hotelId]);
    if (assetRows.length === 0) throw Errors.notFound("Activo crítico no encontrado.");

    const { rows } = await db.query<{ id: string; completed_at: string }>(
      `insert into public.critical_asset_maintenance_event (tenant_id, hotel_id, asset_id, cost, note, created_by)
       values ($1, $2, $3, $4, $5, $6)
       returning id, completed_at::text as completed_at;`,
      [c.get("orgId"), hotelId, assetId, body.cost, body.note ?? null, c.get("userId")],
    );
    return c.json({ id: rows[0]!.id, completadoEn: rows[0]!.completed_at }, 201);
  });

  interface SeasonWindowRow {
    id: string;
    label: string;
    start_month_day: string;
    end_month_day: string;
    frequency_days: number;
  }

  const fetchSeasonWindows = async (db: DbClient, hotelId: string) => {
    const { rows } = await db.query<SeasonWindowRow>(
      "select id, label, start_month_day, end_month_day, frequency_days from public.hotel_maintenance_season_window where hotel_id = $1 order by label asc;",
      [hotelId],
    );
    return rows;
  };

  app.get("/hoteles/:hotelId/mantenimiento/temporadas", async (c) => {
    const db = c.get("db");
    const rows = await fetchSeasonWindows(db, c.req.param("hotelId"));
    return c.json(
      rows.map((w) => ({ id: w.id, etiqueta: w.label, inicio: w.start_month_day, fin: w.end_month_day, frecuenciaDias: w.frequency_days })),
    );
  });

  app.post("/hoteles/:hotelId/mantenimiento/temporadas", async (c) => {
    assertRole(c, MANAGE_MAINTENANCE_PLAN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(crearTemporadaSchema, await c.req.json().catch(() => ({})));
    const { rows } = await db.query<{ id: string }>(
      `insert into public.hotel_maintenance_season_window (tenant_id, hotel_id, label, start_month_day, end_month_day, frequency_days)
       values ($1, $2, $3, $4, $5, $6)
       returning id;`,
      [c.get("orgId"), hotelId, body.label, body.startMonthDay, body.endMonthDay, body.frequencyDays],
    );
    return c.json({ id: rows[0]!.id }, 201);
  });

  app.delete("/hoteles/:hotelId/mantenimiento/temporadas/:windowId", async (c) => {
    assertRole(c, MANAGE_MAINTENANCE_PLAN_ROLES);
    const db = c.get("db");
    const { rows } = await db.query<{ id: string }>(
      "delete from public.hotel_maintenance_season_window where id = $1 and hotel_id = $2 returning id;",
      [c.req.param("windowId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Ventana de temporada no encontrada.");
    return c.json({ id: rows[0]!.id });
  });

  // Calendario de MP (REQ-HK-015): para cada activo activo, calcula el próximo
  // vencimiento ajustado a temporada (`computeNextPreventiveDueDate`) y, si el activo
  // está ligado a una habitación, lo ajusta a ocupación (`adjustDueDateForRoomOccupancy`)
  // -- LÍMITE HONESTO: `room.status` solo describe la ocupación de HOY (no existe
  // asignación de habitación física por fecha futura en el esquema, ver nota de
  // cabecera del módulo de dominio), así que el oráculo de ocupación que se le pasa
  // sólo puede afirmar con certeza la fecha de HOY -- para cualquier fecha futura
  // asume "no ocupada" (el supuesto menos alarmista dado lo que el sistema sabe de
  // verdad hoy; nunca bloquea la MP indefinidamente por falta de dato). El día que
  // exista una asignación de habitación por fecha, solo este oráculo cambia.
  app.get("/hoteles/:hotelId/mantenimiento/calendario-preventivo", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");

    const seasonWindowRows = await fetchSeasonWindows(db, hotelId);
    const seasonWindows: SeasonWindow[] = seasonWindowRows.map((w) => ({
      label: w.label,
      startMonthDay: w.start_month_day,
      endMonthDay: w.end_month_day,
      frequencyDays: w.frequency_days,
    }));

    const { rows: assets } = await db.query<AssetRow>(
      `select ca.id, ca.room_id, r.code as room_code, r.status::text as room_status, ca.name, ca.category::text as category,
              ca.install_date::text as install_date, ca.replacement_cost::text as replacement_cost,
              ca.base_frequency_days, ca.active
       from public.critical_asset ca
       left join public.room r on r.id = ca.room_id
       where ca.hotel_id = $1 and ca.active = true
       order by ca.name asc;`,
      [hotelId],
    );

    const { rows: lastEvents } = await db.query<{ asset_id: string; last_completed_at: string }>(
      `select asset_id, max(completed_at)::text as last_completed_at
       from public.critical_asset_maintenance_event
       where hotel_id = $1
       group by asset_id;`,
      [hotelId],
    );
    const lastCompletedByAsset = new Map(lastEvents.map((e) => [e.asset_id, e.last_completed_at]));

    const now = new Date();
    const calendar = assets.map((asset) => {
      const lastCompletedAt = lastCompletedByAsset.get(asset.id);
      const schedule = computeNextPreventiveDueDate({
        baseFrequencyDays: asset.base_frequency_days,
        lastCompletedAt: lastCompletedAt ? new Date(lastCompletedAt) : null,
        installDate: new Date(asset.install_date),
        seasonWindows,
      });

      if (!asset.room_id) {
        return {
          activoId: asset.id,
          nombre: asset.name,
          categoria: asset.category,
          habitacionCodigo: null,
          costoReemplazo: Number(asset.replacement_cost),
          frecuenciaEfectivaDias: schedule.effectiveFrequencyDays,
          ventanaTemporadaAplicada: schedule.appliedSeasonWindow?.label ?? null,
          vencimiento: schedule.dueDate.toISOString(),
          pospuestoPorOcupacionDias: 0,
          forzadoPorOcupacion: false,
        };
      }

      const roomOccupiedToday = asset.room_status === "ocupada";
      const occupancy = adjustDueDateForRoomOccupancy(schedule.dueDate, (date) => {
        // Solo se conoce la ocupación de HOY (ver nota de cabecera) -- cualquier otra
        // fecha se asume libre.
        const isToday = date.toDateString() === now.toDateString();
        return isToday && roomOccupiedToday;
      });

      return {
        activoId: asset.id,
        nombre: asset.name,
        categoria: asset.category,
        habitacionCodigo: asset.room_code,
        costoReemplazo: Number(asset.replacement_cost),
        frecuenciaEfectivaDias: schedule.effectiveFrequencyDays,
        ventanaTemporadaAplicada: schedule.appliedSeasonWindow?.label ?? null,
        vencimiento: occupancy.adjustedDate.toISOString(),
        pospuestoPorOcupacionDias: occupancy.postponedDays,
        forzadoPorOcupacion: occupancy.forcedDespiteOccupancy,
      };
    });

    return c.json(calendar);
  });

  // Recomendación reparar vs. reemplazar (REQ-HK-015/H11-020): suma el costo de MP
  // registrada (`critical_asset_maintenance_event.cost`) y de tickets CORRECTIVOS
  // cerrados del mismo activo (`maintenance_ticket.actual_cost`) en los últimos 12
  // meses -- las dos fuentes de "historial y costo por activo" del criterio.
  app.get("/hoteles/:hotelId/mantenimiento/activos/:assetId/recomendacion", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const assetId = c.req.param("assetId");

    const { rows: assetRows } = await db.query<{ replacement_cost: string }>(
      "select replacement_cost::text as replacement_cost from public.critical_asset where id = $1 and hotel_id = $2;",
      [assetId, hotelId],
    );
    if (assetRows.length === 0) throw Errors.notFound("Activo crítico no encontrado.");

    const { rows: eventCosts } = await db.query<{ cost: string }>(
      `select cost::text as cost from public.critical_asset_maintenance_event
       where asset_id = $1 and hotel_id = $2 and completed_at >= now() - interval '12 months';`,
      [assetId, hotelId],
    );
    const { rows: ticketCosts } = await db.query<{ actual_cost: string }>(
      `select actual_cost::text as actual_cost from public.maintenance_ticket
       where asset_id = $1 and hotel_id = $2 and status = 'cerrado' and actual_cost is not null
         and coalesce(closed_at, created_at) >= now() - interval '12 months';`,
      [assetId, hotelId],
    );

    const trailingRepairCosts = [...eventCosts.map((e) => Number(e.cost)), ...ticketCosts.map((t) => Number(t.actual_cost))];
    const result = recommendRepairOrReplace({ replacementCost: Number(assetRows[0]!.replacement_cost), trailingRepairCosts });

    return c.json({
      activoId: assetId,
      recomendacion: result.recommendation,
      ratioCosto: result.costRatio,
      numeroEventosDeCosto: result.repairCount,
      costoReemplazo: Number(assetRows[0]!.replacement_cost),
      costoAcumulado12Meses: trailingRepairCosts.reduce((a, b) => a + b, 0),
      motivo: result.reason,
    });
  });

  return app;
}
