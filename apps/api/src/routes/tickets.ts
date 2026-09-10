// REQ-HUE-014 · /hoteles/:hotelId/tickets — "cada mensaje/petición del huésped se
// convierte en un ticket con departamento/habitación/prioridad/SLA". Crear un ticket
// reutiliza la MISMA tool de dominio de agent-core (`crear_ticket_huesped`) que usaría
// el agente conversacional el día que exista el canal real de WhatsApp/voz (mismo
// criterio que routes/mantenimiento.ts con `crear_ticket_mantenimiento`): una sola
// implementación de la regla de negocio para ambos caminos de entrada.
//
// Cuando quien llama NO indica `department`/`priority` explícitos (p. ej. un
// formulario/QR de habitación con solo un cuadro de texto libre, sin selector de
// categoría), esta ruta los resuelve con
// `@atiende-hoteles/domain-hotel::classifyGuestMessage` ANTES de invocar la tool --
// agent-core sigue sin depender de domain-hotel (H6a), así que esta clasificación por
// defecto vive aquí, en la capa que sí puede importar ambos paquetes.
import { Hono } from "hono";
import { z } from "zod";
import { classifyGuestMessage, classifyUnaccompaniedMinorEscalation } from "@atiende-hoteles/domain-hotel";
import { buildToolContext, createGuestTicketTool, createRunBudget } from "@atiende-hoteles/agent-core";
import { escalateGuestTicketNow } from "../jobs/ticketEscalation.ts";
import { sharedWhatsappAdapter, whatsappAdapterSimulated } from "../lib/messaging.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { HOTEL_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const departmentEnum = z.enum(HOTEL_ROLES);
const priorityEnum = z.enum(["alta", "media", "baja"]);
const channelEnum = z.enum(["qr", "staff", "whatsapp", "voz"]);

const crearTicketSchema = z.object({
  guestMessage: z.string().trim().min(1).max(1000),
  roomCode: z.string().trim().min(1).max(20).optional(),
  department: departmentEnum.optional(),
  priority: priorityEnum.optional(),
  channel: channelEnum.default("staff"),
});

const cerrarTicketSchema = z.object({ resolutionNote: z.string().trim().max(1000).optional() });
const reasignarTicketSchema = z.object({ department: departmentEnum });

interface TicketRow {
  id: string;
  room_code: string | null;
  department: string;
  priority: string;
  status: string;
  channel: string;
  guest_message: string;
  sla_minutes: number;
  sla_due_at: string;
  assigned_to: string | null;
  escalated_at: string | null;
  escalated_to_roles: unknown;
  // REQ-HUE-014 (ampliación "notificación activa", migración 0127): no-nulo desde que
  // se disparó el aviso temprano al 75% del SLA (`notifyApproachingSlaGuestTickets`,
  // jobs/ticketEscalation.ts) -- distinto de `escalated_at` (100%, sube de nivel).
  sla_warning_notified_at: string | null;
  resolution_note: string | null;
  closed_at: string | null;
  created_at: string;
}

function serializeTicket(t: TicketRow) {
  return {
    id: t.id,
    roomCode: t.room_code,
    departamento: t.department,
    prioridad: t.priority,
    estado: t.status,
    canal: t.channel,
    mensaje: t.guest_message,
    slaMinutos: t.sla_minutes,
    slaVenceEn: t.sla_due_at,
    asignadoA: t.assigned_to,
    escaladoEn: t.escalated_at,
    escaladoARoles: t.escalated_to_roles,
    avisoSla75En: t.sla_warning_notified_at,
    notaResolucion: t.resolution_note,
    cerradoEn: t.closed_at,
    creadoEn: t.created_at,
  };
}

export function ticketsRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/tickets/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/tickets",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // La RLS de `guest_ticket` (0098) ya filtra por rol -- owner/gm/frontdesk ven todos
  // los del hotel, cada departamento ve los suyos. Esta ruta no reduce esa lista, solo
  // la sirve tal cual RLS la devolvió (mismo criterio documentado en apps/api/src/
  // domain/roles.ts: "la autoridad final sigue siendo la RLS").
  app.get("/hoteles/:hotelId/tickets", async (c) => {
    const db = c.get("db");
    const status = c.req.query("status");
    const { rows } = await db.query<TicketRow>(
      `select gt.id, r.code as room_code, gt.department::text as department,
              gt.priority::text as priority, gt.status::text as status,
              gt.channel::text as channel, gt.guest_message, gt.sla_minutes,
              gt.sla_due_at::text as sla_due_at, gt.assigned_to,
              gt.escalated_at::text as escalated_at, gt.escalated_to_roles,
              gt.sla_warning_notified_at::text as sla_warning_notified_at,
              gt.resolution_note, gt.closed_at::text as closed_at,
              gt.created_at::text as created_at
       from public.guest_ticket gt
       left join public.room r on r.id = gt.room_id
       where gt.hotel_id = $1 and ($2::text is null or gt.status::text = $2)
       order by gt.created_at desc;`,
      [c.req.param("hotelId"), status ?? null],
    );
    return c.json(rows.map(serializeTicket));
  });

  app.post("/hoteles/:hotelId/tickets", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(crearTicketSchema, await c.req.json().catch(() => ({})));
    const classification = body.department && body.priority ? null : classifyGuestMessage(body.guestMessage);

    // REQ-HUE-023: "menor no acompañado debe escalar a humano" -- se evalúa ANTES de
    // decidir department/priority por defecto y SIEMPRE los sobreescribe (frontdesk/
    // alta), sin importar qué haya mandado quien llama (formulario QR, staff, o el día
    // que exista el agente conversacional real) -- esta es la ÚNICA implementación de
    // la regla para cualquier camino de entrada que cree un `guest_ticket` (mismo
    // criterio "una sola tool, todos los caminos" que el resto de este archivo).
    const menorNoAcompanado = classifyUnaccompaniedMinorEscalation(body.guestMessage);

    const ctx = buildToolContext(
      {
        orgId: c.get("orgId"),
        hotelId,
        actor: { type: "staff", id: c.get("userId") },
        requestId: c.get("requestId"),
      },
      createRunBudget({}),
    );

    const tool = createGuestTicketTool({ db, messaging: sharedWhatsappAdapter, simulated: whatsappAdapterSimulated });
    const result = await tool.run(ctx, {
      guestMessage: body.guestMessage,
      roomCode: body.roomCode,
      department: (menorNoAcompanado ? "frontdesk" : (body.department ?? classification!.department)) as (typeof HOTEL_ROLES)[number],
      priority: menorNoAcompanado ? "alta" : (body.priority ?? classification!.priority),
      channel: body.channel,
    });
    if (!result.ok) throw Errors.validation(result.summary);

    const data = result.data as { ticketId: string };
    if (menorNoAcompanado) {
      await escalateGuestTicketNow(db, {
        ticketId: data.ticketId,
        hotelId,
        tenantId: c.get("orgId"),
        reason: "menor_no_acompanado",
      });
    }

    return c.json(
      {
        summary: result.summary,
        ...(result.data as object),
        escaladoMenorNoAcompanado: menorNoAcompanado !== null,
      },
      201,
    );
  });

  app.patch("/hoteles/:hotelId/tickets/:ticketId/cerrar", async (c) => {
    const db = c.get("db");
    const body = parseBody(cerrarTicketSchema, await c.req.json().catch(() => ({})));
    const { rows } = await db.query<{ id: string; status: string }>(
      `update public.guest_ticket
       set status = 'cerrado', closed_at = now(), resolution_note = coalesce($1, resolution_note), updated_at = now()
       where id = $2 and hotel_id = $3 and status not in ('cerrado', 'cancelado')
       returning id, status::text as status;`,
      [body.resolutionNote ?? null, c.req.param("ticketId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) {
      throw Errors.notFound("Ticket no encontrado, ya cerrado, o sin permiso para cerrarlo.");
    }
    return c.json({ id: rows[0]!.id, estado: rows[0]!.status });
  });

  app.patch("/hoteles/:hotelId/tickets/:ticketId/reasignar", async (c) => {
    const db = c.get("db");
    const body = parseBody(reasignarTicketSchema, await c.req.json().catch(() => ({})));
    // El SLA queda CONGELADO al reasignar departamento a propósito (misma nota en la
    // migración 0098): la espera del huésped no se reinicia porque el staff corrija a
    // qué departamento le corresponde atenderlo internamente.
    const { rows } = await db.query<{ id: string; department: string }>(
      `update public.guest_ticket set department = $1, updated_at = now()
       where id = $2 and hotel_id = $3 and status not in ('cerrado', 'cancelado')
       returning id, department::text as department;`,
      [body.department, c.req.param("ticketId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) {
      throw Errors.notFound("Ticket no encontrado, ya cerrado, o sin permiso para reasignarlo.");
    }
    return c.json({ id: rows[0]!.id, departamento: rows[0]!.department });
  });

  return app;
}
