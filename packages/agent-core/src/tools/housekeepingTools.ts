// H6b · Tools de dominio REALES (no de ejemplo) para housekeeping/mantenimiento, sobre
// las tablas de packages/db/migrations/0040-0043. Patron Likida (docs/referencia/06 §2.5,
// ver tool.ts): la unica identidad de tenant/hotel que usan viene de `ctx` (ToolContext),
// nunca del input del modelo -- `roomCode`/`ticketId` son identificadores de NEGOCIO
// (numero de habitacion, folio de ticket), no de tenant/hotel/actor, por lo que
// `defineTool()` los permite explicitamente (ver DEFAULT_FORBIDDEN_FIELD_PATTERNS en
// tool.ts: no cubre "room"/"ticket", solo org/hotel/tenant/guest/actor/staff/property/
// location).
//
// Reciben su acceso a datos por INYECCION de dependencias (`deps.db`), nunca importan
// `@atiende-hoteles/db`: agent-core sigue sin depender de un motor de base de datos
// concreto (H6a) -- `SqlClient` (sql.ts) es la forma minima que necesitan, y el `DbClient`
// real de packages/db ya la cumple sin adaptador.

import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool.ts";
import { recordToolAudit } from "../audit.ts";
import type { SqlClient } from "../sql.ts";

/** Umbral (MXN) a partir del cual un ticket de mantenimiento se marca como
 * `requires_approval` -- informativo en la creacion; la aprobacion real la exige la tool
 * `autorizar_gasto_mantenimiento` (effect="money") al momento de cerrar con costo real,
 * nunca en la creacion del ticket. Configurable por variable de entorno para no fijar un
 * numero de negocio en codigo (mismo espiritu que `resolveModelForRole`, roles.ts). */
export function maintenanceApprovalThresholdMxn(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MAINTENANCE_APPROVAL_THRESHOLD_MXN;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3000;
}

export interface HousekeepingToolDeps {
  readonly db: SqlClient;
}

const priorityEnum = z.enum(["alta", "media", "baja"]);

const createHousekeepingTaskInput = z.object({
  roomCode: z.string().trim().min(1).max(20),
  priority: priorityEnum.default("media"),
  checklist: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  notes: z.string().trim().max(500).optional(),
});
export type CreateHousekeepingTaskInput = z.infer<typeof createHousekeepingTaskInput>;

/** REQ-HK-001/002: crea una tarea de limpieza para una habitacion del hotel en curso.
 * effect="write" sin aprobacion -- asignar/crear tareas de housekeeping no mueve dinero
 * ni sale del sistema, es operacion interna reversible (GOB-026 no aplica). */
export function createHousekeepingTaskTool(deps: HousekeepingToolDeps): ToolDefinition<CreateHousekeepingTaskInput> {
  return defineTool({
    name: "crear_tarea_housekeeping",
    description:
      "Crea una tarea de limpieza/preparacion de habitacion para el equipo de housekeeping del hotel en curso.",
    inputSchema: createHousekeepingTaskInput,
    effect: "write",
    needsApproval: false,
    run: async (ctx, input) => {
      const { rows: roomRows } = await deps.db.query<{ id: string }>(
        "select id from public.room where hotel_id = $1 and code = $2;",
        [ctx.hotelId, input.roomCode],
      );
      const room = roomRows[0];
      if (!room) {
        return {
          ok: false,
          summary: `No existe la habitación "${input.roomCode}" en este hotel; no se creó ninguna tarea.`,
        };
      }

      const createdBy = ctx.actor.type === "staff" ? ctx.actor.id : null;
      const { rows } = await deps.db.query<{ id: string }>(
        `insert into public.housekeeping_task
           (tenant_id, hotel_id, room_id, priority, checklist, notes, created_by)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)
         returning id;`,
        [ctx.orgId, ctx.hotelId, room.id, input.priority, JSON.stringify(input.checklist), input.notes ?? null, createdBy],
      );

      return {
        ok: true,
        summary: `Tarea de housekeeping creada para la habitación ${input.roomCode} (prioridad ${input.priority}).`,
        data: { taskId: rows[0]!.id, roomCode: input.roomCode },
      };
    },
  });
}

const createMaintenanceTicketInput = z.object({
  roomCode: z.string().trim().min(1).max(20).optional(),
  title: z.string().trim().min(1).max(150),
  description: z.string().trim().min(1).max(1000),
  origin: z.enum(["huesped", "staff", "agente", "sensor"]).default("agente"),
  severity: z.enum(["alta", "media", "baja"]).default("media"),
  estimatedCost: z.number().nonnegative().max(1_000_000).default(0),
});
export type CreateMaintenanceTicketInput = z.infer<typeof createMaintenanceTicketInput>;

/** REQ-HK-011: recibe un ticket de mantenimiento de cualquier origen. effect="write" sin
 * aprobacion -- reportar un problema no autoriza gasto todavia (eso lo exige
 * `autorizar_gasto_mantenimiento` por separado). Detecta duplicados simples (mismo
 * titulo+habitacion, ticket abierto) dentro de una ventana de 24h (REQ-HK-011/012) y
 * marca la habitacion "fuera de servicio" cuando la severidad es alta (REQ-HK-014,
 * pendiente de PMS real -- aqui es la unica fuente de estado). */
export function createMaintenanceTicketTool(deps: HousekeepingToolDeps): ToolDefinition<CreateMaintenanceTicketInput> {
  return defineTool({
    name: "crear_ticket_mantenimiento",
    description: "Registra un ticket de mantenimiento correctivo (huésped, staff, agente o sensor) en el hotel en curso.",
    inputSchema: createMaintenanceTicketInput,
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

      const { rows: duplicateRows } = await deps.db.query<{ id: string }>(
        `select id from public.maintenance_ticket
         where hotel_id = $1
           and title = $2
           and coalesce(room_id::text, '') = coalesce($3::text, '')
           and status not in ('cerrado', 'cancelado')
           and created_at > now() - interval '24 hours'
         order by created_at desc
         limit 1;`,
        [ctx.hotelId, input.title, roomId],
      );
      if (duplicateRows[0]) {
        return {
          ok: true,
          summary: `Ya existe un ticket abierto "${input.title}" en las últimas 24h; no se duplicó.`,
          data: { ticketId: duplicateRows[0].id, duplicate: true },
        };
      }

      const requiresApproval = input.estimatedCost > maintenanceApprovalThresholdMxn();
      const marksOutOfService = input.severity === "alta" && roomId !== null;
      const createdBy = ctx.actor.type === "staff" ? ctx.actor.id : null;

      const { rows } = await deps.db.query<{ id: string }>(
        `insert into public.maintenance_ticket
           (tenant_id, hotel_id, room_id, title, description, origin, severity,
            estimated_cost, requires_approval, marks_room_out_of_service, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning id;`,
        [
          ctx.orgId,
          ctx.hotelId,
          roomId,
          input.title,
          input.description,
          input.origin,
          input.severity,
          input.estimatedCost,
          requiresApproval,
          marksOutOfService,
          createdBy,
        ],
      );

      if (marksOutOfService && roomId) {
        await deps.db.query("update public.room set status = 'fuera_de_servicio', updated_at = now() where id = $1;", [
          roomId,
        ]);
      }

      return {
        ok: true,
        summary: `Ticket de mantenimiento "${input.title}" creado (severidad ${input.severity}).`,
        data: { ticketId: rows[0]!.id, requiresApproval, marksOutOfService },
      };
    },
  });
}

export const AUTHORIZE_MAINTENANCE_EXPENSE_TOOL_NAME = "autorizar_gasto_mantenimiento";

const authorizeMaintenanceExpenseInput = z.object({
  ticketId: z.string().uuid(),
  actualCost: z.number().positive().max(1_000_000),
  partUsed: z.string().trim().max(200).optional(),
  resolutionNote: z.string().trim().max(1000).optional(),
});
export type AuthorizeMaintenanceExpenseInput = z.infer<typeof authorizeMaintenanceExpenseInput>;

/** REQ-HK-014: autoriza y cierra un ticket de mantenimiento con su costo real.
 * effect="money" + needsApproval=true (GOB-026, exigido por defineTool()): `run()` SOLO
 * se ejecuta despues de que `AgentRunner` confirme que `ApprovalQueue` devolvio la
 * solicitud como "aprobada" (doble confirmacion, dos roles distintos) -- para cuando este
 * codigo corre, la autorizacion humana ya ocurrio.
 *
 * REQ-AGT-001 (tool de ejemplo del criterio de aceptacion): esta es la tool que demuestra
 * el registro de auditoria con valor anterior/nuevo -- lee el estado COMPLETO del ticket
 * antes de escribir (no solo las columnas que necesitaba para la logica de negocio) y
 * llama a `recordToolAudit()` con ese "antes" y el "despues" real que acaba de persistir,
 * DESPUES del UPDATE (para que el "despues" sea el estado que de verdad quedo en la fila,
 * no el input crudo del modelo). */
export function createAuthorizeMaintenanceExpenseTool(
  deps: HousekeepingToolDeps,
): ToolDefinition<AuthorizeMaintenanceExpenseInput> {
  return defineTool({
    name: AUTHORIZE_MAINTENANCE_EXPENSE_TOOL_NAME,
    description:
      "Autoriza el costo real de un ticket de mantenimiento y lo cierra (requiere aprobación humana por tratarse de dinero).",
    inputSchema: authorizeMaintenanceExpenseInput,
    effect: "money",
    needsApproval: true,
    run: async (ctx, input) => {
      const { rows: ticketRows } = await deps.db.query<{
        id: string;
        room_id: string | null;
        marks_room_out_of_service: boolean;
        status: string;
        actual_cost: string | null;
        part_used: string | null;
        resolution_note: string | null;
      }>(
        `select id, room_id, marks_room_out_of_service, status, actual_cost, part_used, resolution_note
         from public.maintenance_ticket where id = $1 and hotel_id = $2;`,
        [input.ticketId, ctx.hotelId],
      );
      const ticket = ticketRows[0];
      if (!ticket) {
        return { ok: false, summary: `No existe el ticket de mantenimiento indicado en este hotel.` };
      }

      await deps.db.query(
        `update public.maintenance_ticket
         set actual_cost = $1, part_used = $2, resolution_note = $3, status = 'cerrado',
             closed_at = now(), updated_at = now()
         where id = $4;`,
        [input.actualCost, input.partUsed ?? null, input.resolutionNote ?? null, ticket.id],
      );

      if (ticket.marks_room_out_of_service && ticket.room_id) {
        await deps.db.query("update public.room set status = 'disponible', updated_at = now() where id = $1;", [
          ticket.room_id,
        ]);
      }

      // REQ-AGT-001: timestamp (created_at, la pone record_audit_log/el trigger) + agente
      // (ctx.actor, nunca el input del modelo) + valor anterior/nuevo del recurso real.
      await recordToolAudit({
        db: deps.db,
        orgId: ctx.orgId,
        hotelId: ctx.hotelId,
        actor: ctx.actor,
        toolName: AUTHORIZE_MAINTENANCE_EXPENSE_TOOL_NAME,
        action: "mantenimiento.gasto_autorizado",
        entityType: "maintenance_ticket",
        entityId: ticket.id,
        before: {
          status: ticket.status,
          actualCost: ticket.actual_cost,
          partUsed: ticket.part_used,
          resolutionNote: ticket.resolution_note,
        },
        after: {
          status: "cerrado",
          actualCost: input.actualCost,
          partUsed: input.partUsed ?? null,
          resolutionNote: input.resolutionNote ?? null,
        },
      });

      return {
        ok: true,
        summary: `Ticket de mantenimiento cerrado con costo autorizado de $${input.actualCost.toFixed(2)} MXN.`,
        data: { ticketId: ticket.id, actualCost: input.actualCost },
      };
    },
  });
}
