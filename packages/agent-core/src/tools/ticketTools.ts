// REQ-HUE-014: "Cada mensaje/petición del huésped debe convertirse en un ticket con
// departamento, habitación, prioridad y SLA [...]". Mismo patrón Likida que
// housekeepingTools.ts: una sola tool de dominio real (no de ejemplo), inyectada por
// `deps.db`, que tanto el agente conversacional (cuando exista el canal real,
// WhatsApp/voz) como las rutas HTTP de staff (`apps/api/src/routes/tickets.ts`, canal
// "staff"/"qr" ya real hoy) invocan por igual -- una sola implementación de la regla,
// dos caminos de entrada.
//
// Igual que `createMaintenanceTicketTool` (severity/origin son argumentos YA
// decididos, no clasificados por la tool): `department`/`priority` son argumentos de
// entrada, no algo que esta tool adivine. Cuando quien llama es el agente conversacional
// real, el propio modelo ya leyó el mensaje y decide esos dos campos como parte de su
// razonamiento (igual que decide `severity` en el ticket de mantenimiento); cuando quien
// llama es un formulario sin LLM (QR/staff transcribiendo), `apps/api/src/routes/
// tickets.ts` resuelve department/priority por defecto con
// `@atiende-hoteles/domain-hotel::classifyGuestMessage` ANTES de invocar esta tool --
// agent-core sigue sin depender de domain-hotel (H6a, núcleo puro sin dependencias
// externas al paquete, mismo motivo que `StaffRole` en context.ts es una copia local del
// contrato de `public.hotel_role` en vez de importarlo).
//
// El SLA en minutos SÍ lo resuelve esta tool (lee `ticket_sla_policy` del hotel en
// curso, si existe, si no aplica el default por prioridad) -- ambos caminos de entrada
// deben congelar el MISMO SLA para el mismo (hotel, departamento, prioridad), así que
// vive aquí una sola vez en vez de duplicarse en cada ruta que llame a esta tool.
// `DEFAULT_SLA_MINUTES_BY_PRIORITY` de abajo es una copia intencional (mismo criterio de
// "copia del contrato de nombres" que StaffRole) del default real de
// `packages/domain-hotel/src/tickets/slaPolicy.ts::DEFAULT_SLA_MINUTES_BY_PRIORITY` --
// `tests/unit/agent-core/ticket-tools.spec.ts` y
// `tests/unit/domain-hotel/ticket-sla-policy.spec.ts` verifican, cada uno desde su
// propio paquete, que los tres valores coinciden.

import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool.ts";
import type { StaffRole } from "../context.ts";
import type { SqlClient } from "../sql.ts";
import { notifyStaffOfNewTask } from "./staffNotify.ts";
import type { WhatsappSenderLike } from "./messagingTools.ts";

export interface TicketToolDeps {
  readonly db: SqlClient;
  /** Notificación ACTIVA por WhatsApp al departamento responsable al crear el ticket
   *  (ver staffNotify.ts) -- ausente/`undefined`: `createGuestTicketTool` no intenta
   *  notificar nada. */
  readonly messaging?: WhatsappSenderLike;
  readonly simulated?: boolean;
}

const departmentEnum = z.enum([
  "owner",
  "gm",
  "frontdesk",
  "reservations",
  "housekeeping",
  "maintenance",
  "fnb",
  "accountant",
]);
const priorityEnum = z.enum(["alta", "media", "baja"]);
const channelEnum = z.enum(["qr", "staff", "whatsapp", "voz"]);

/** Ver comentario de cabecera: copia intencional del default de
 *  `domain-hotel/src/tickets/slaPolicy.ts`, verificada igual en ambos paquetes. */
export const DEFAULT_SLA_MINUTES_BY_PRIORITY: Record<z.infer<typeof priorityEnum>, number> = {
  alta: 30,
  media: 120,
  baja: 480,
};

const createGuestTicketInput = z.object({
  guestMessage: z.string().trim().min(1).max(1000),
  roomCode: z.string().trim().min(1).max(20).optional(),
  department: departmentEnum,
  priority: priorityEnum.default("media"),
  channel: channelEnum.default("staff"),
});
export type CreateGuestTicketInput = z.infer<typeof createGuestTicketInput>;

export const CREATE_GUEST_TICKET_TOOL_NAME = "crear_ticket_huesped";

/** REQ-HUE-014: convierte un mensaje/petición del huésped en un `guest_ticket` con
 *  departamento/habitación/prioridad/SLA. effect="write" sin aprobación -- registrar una
 *  petición no mueve dinero ni sale del sistema (GOB-026 no aplica), mismo criterio que
 *  `crear_tarea_housekeeping`/`crear_ticket_mantenimiento`. La escalación automática por
 *  SLA vencido vive aparte (`apps/api/src/jobs/ticketEscalation.ts`), disparada por el
 *  planificador del proceso o por CLI, nunca por esta tool. */
export function createGuestTicketTool(deps: TicketToolDeps): ToolDefinition<CreateGuestTicketInput> {
  return defineTool({
    name: CREATE_GUEST_TICKET_TOOL_NAME,
    description:
      "Registra un ticket a partir de un mensaje/petición del huésped, con departamento/habitación/prioridad/SLA.",
    inputSchema: createGuestTicketInput,
    effect: "write",
    needsApproval: false,
    run: async (ctx, input) => {
      let roomId: string | null = null;
      if (input.roomCode) {
        const { rows: roomRows } = await deps.db.query<{ id: string }>(
          "select id from public.room where hotel_id = $1 and code = $2;",
          [ctx.hotelId, input.roomCode],
        );
        if (!roomRows[0]) {
          return {
            ok: false,
            summary: `No existe la habitación "${input.roomCode}" en este hotel; no se creó ningún ticket.`,
          };
        }
        roomId = roomRows[0].id;
      }

      const { rows: policyRows } = await deps.db.query<{ sla_minutes: number }>(
        `select sla_minutes from public.ticket_sla_policy
         where hotel_id = $1 and department = $2 and priority = $3;`,
        [ctx.hotelId, input.department, input.priority],
      );
      const slaMinutes = policyRows[0]?.sla_minutes ?? DEFAULT_SLA_MINUTES_BY_PRIORITY[input.priority];

      const createdBy = ctx.actor.type === "staff" ? ctx.actor.id : null;
      // $8/$9 llevan el MISMO valor (sla_minutes) en dos posiciones de parámetro
      // separadas a propósito -- reusar un solo `$n` en dos contextos de tipo distintos
      // (columna `integer` y operando de `||` con texto) le impide a Postgres inferir un
      // tipo único para ese parámetro bajo el protocolo extendido ("could not determine
      // data type of parameter", el mismo fallo real ya documentado en
      // routes/mantenimiento.ts::PATCH .../asignar).
      const { rows } = await deps.db.query<{ id: string; sla_due_at: string }>(
        `insert into public.guest_ticket
           (tenant_id, hotel_id, room_id, department, priority, channel, guest_message,
            sla_minutes, sla_due_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' minutes')::interval, $10)
         returning id, sla_due_at::text as sla_due_at;`,
        [
          ctx.orgId,
          ctx.hotelId,
          roomId,
          input.department,
          input.priority,
          input.channel,
          input.guestMessage,
          slaMinutes,
          slaMinutes,
          createdBy,
        ],
      );
      const ticketId = rows[0]!.id;

      // H6b-notif: notificación ACTIVA por WhatsApp al departamento responsable -- ver
      // staffNotify.ts. `input.department` ya es el `StaffRole` real (huésped/QR/staff
      // ya lo decidieron o `classifyGuestMessage` lo resolvió por defecto ANTES de
      // invocar esta tool, ver comentario de archivo); `assignedTo` nunca se fija en
      // esta creación, así que esto siempre notifica por rol/departamento.
      const notificacion = await notifyStaffOfNewTask(deps, {
        hotelId: ctx.hotelId,
        role: input.department,
        templateName: "ticket_huesped_nuevo",
        parameters: [input.department, input.priority, input.guestMessage.slice(0, 200)],
        dedupeKey: ticketId,
      });

      return {
        ok: true,
        summary:
          `Ticket creado para ${input.department} (prioridad ${input.priority}, SLA ${slaMinutes} min)` +
          (input.roomCode ? ` — habitación ${input.roomCode}.` : "."),
        data: {
          ticketId,
          department: input.department satisfies StaffRole,
          priority: input.priority,
          slaMinutes,
          slaDueAt: rows[0]!.sla_due_at,
          notificacion,
        },
      };
    },
  });
}
