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
import { notifyStaffOfNewTask } from "./staffNotify.ts";
import type { WhatsappSenderLike } from "./messagingTools.ts";
import { syncTaskToOutboundConnectorBestEffort, type OutboundTaskSyncLike } from "./outboundTaskSync.ts";

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
  /** Notificación ACTIVA por WhatsApp al staff responsable (ver staffNotify.ts) --
   *  ausente/`undefined`: `createHousekeepingTaskTool`/`createMaintenanceTicketTool` NO
   *  intentan notificar nada (mismo criterio honesto de "sin adaptador configurado" que
   *  el resto de este módulo), `createAuthorizeMaintenanceExpenseTool` la ignora por
   *  completo -- no necesita notificar. */
  readonly messaging?: WhatsappSenderLike;
  readonly simulated?: boolean;
  /** Conector outbound PMS-enterprise (packages/mcp-servers/outbound), opcional -- ver
   *  outboundTaskSync.ts. Sin esta dependencia (la mayoría de llamadores hoy), la tool
   *  se comporta exactamente igual que antes de que existiera este conector. */
  readonly outboundSync?: OutboundTaskSyncLike;
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
      const taskId = rows[0]!.id;

      // Hallazgo de auditoría (H6b): antes de esto, la ÚNICA forma de enterarse de una
      // tarea nueva era el tablero de staff -- ver comentario de archivo de
      // staffNotify.ts. `assignedTo` nunca se fija en esta creación (ver comentario de
      // `HousekeepingToolDeps`), así que esto siempre notifica por rol "housekeeping".
      const notificacion = await notifyStaffOfNewTask(deps, {
        hotelId: ctx.hotelId,
        role: "housekeeping",
        templateName: "tarea_housekeeping_nueva",
        parameters: [input.roomCode, input.priority],
        dedupeKey: taskId,
      });

      // REQ conector-pms-enterprise: best-effort, ver outboundTaskSync.ts -- nunca
      // bloquea ni revierte la creación local de arriba.
      const outboundSync = await syncTaskToOutboundConnectorBestEffort(deps.outboundSync, {
        taskType: "housekeeping_task",
        taskId,
        hotelId: ctx.hotelId,
        title: `Limpieza/preparación habitación ${input.roomCode}`,
        description: input.notes,
        priority: input.priority,
        roomCode: input.roomCode,
        status: "pendiente",
        occurredAt: new Date().toISOString(),
      });

      return {
        ok: true,
        summary: `Tarea de housekeeping creada para la habitación ${input.roomCode} (prioridad ${input.priority}).`,
        data: { taskId, roomCode: input.roomCode, notificacion, ...(outboundSync ? { outboundSync } : {}) },
      };
    },
  });
}

/** REQ-HK-012: umbral/ventana por defecto para escalar automáticamente un activo con
 *  tickets repetidos (3 en 14 días) -- copia intencional (mismo criterio documentado ya
 *  en `DEFAULT_SLA_MINUTES_BY_PRIORITY`, ticketTools.ts: agent-core sigue sin depender
 *  de `@atiende-hoteles/domain-hotel`, "núcleo puro sin dependencias externas al
 *  paquete") del default real de
 *  `packages/domain-hotel/src/tickets/assetEscalation.ts::DEFAULT_ASSET_ESCALATION_POLICY`
 *  -- `tests/unit/domain-hotel/mantenimiento-activo-escalacion.spec.ts` verifica que
 *  ambos coinciden. */
export const DEFAULT_ASSET_ESCALATION_POLICY = { thresholdCount: 3, windowDays: 14 } as const;
/** Roles destinatarios por defecto de la escalación por repetición -- mismo trío
 *  gm+owner que la escalación por SLA vencido de `guest_ticket`
 *  (`apps/api/src/jobs/ticketEscalation.ts::escalateOverdueGuestTickets`): el problema
 *  ya se reportó N veces sin resolverse de raíz, así que sube un nivel jerárquico. */
export const DEFAULT_ASSET_ESCALATION_ROLES = ["gm", "owner"] as const;

const createMaintenanceTicketInput = z.object({
  roomCode: z.string().trim().min(1).max(20).optional(),
  // REQ-HK-012: código del activo/equipo (packages/db/migrations/0130) sobre el que se
  // reporta el ticket -- opcional a propósito (mismo criterio que `roomCode`): un
  // ticket sin activo declarado ("el pasillo del 3er piso huele raro") se sigue
  // registrando exactamente igual que antes de esta migración, sin historial/
  // escalación por repetición.
  assetCode: z.string().trim().min(1).max(20).optional(),
  title: z.string().trim().min(1).max(150),
  description: z.string().trim().min(1).max(1000),
  origin: z.enum(["huesped", "staff", "agente", "sensor"]).default("agente"),
  severity: z.enum(["alta", "media", "baja"]).default("media"),
  estimatedCost: z.number().nonnegative().max(1_000_000).default(0),
});
export type CreateMaintenanceTicketInput = z.infer<typeof createMaintenanceTicketInput>;

/** REQ-HK-011/012: recibe un ticket de mantenimiento de cualquier origen. effect="write"
 * sin aprobacion -- reportar un problema no autoriza gasto todavia (eso lo exige
 * `autorizar_gasto_mantenimiento` por separado). Detecta duplicados simples (mismo
 * titulo+habitacion, ticket abierto) dentro de una ventana de 24h (REQ-HK-011) y marca
 * la habitacion "fuera de servicio" cuando la severidad es alta (REQ-HK-014, pendiente
 * de PMS real -- aqui es la unica fuente de estado). Cuando el llamador declara
 * `assetCode` (REQ-HK-012), enriquece la respuesta con el historial de tickets previos
 * de ESE activo y escala automáticamente (`escalated_at`/`escalated_to_roles`) al
 * alcanzar el umbral configurado (`maintenance_escalation_policy`, o el default de
 * arriba) de tickets del mismo activo dentro de la ventana de días configurada -- el
 * conteo SIEMPRE incluye el ticket recién creado (mismo criterio "N tickets repetidos"
 * documentado en `DEFAULT_ASSET_ESCALATION_POLICY`). */
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

      let assetId: string | null = null;
      if (input.assetCode) {
        const { rows: assetRows } = await deps.db.query<{ id: string }>(
          "select id from public.maintenance_asset where hotel_id = $1 and code = $2;",
          [ctx.hotelId, input.assetCode],
        );
        if (!assetRows[0]) {
          return {
            ok: false,
            summary: `No existe el activo "${input.assetCode}" en este hotel; no se creó ningún ticket.`,
          };
        }
        assetId = assetRows[0].id;
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
           (tenant_id, hotel_id, room_id, asset_id, title, description, origin, severity,
            estimated_cost, requires_approval, marks_room_out_of_service, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         returning id;`,
        [
          ctx.orgId,
          ctx.hotelId,
          roomId,
          assetId,
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
      const ticketId = rows[0]!.id;

      // REQ-HK-012: historial + escalación por repetición del activo, solo cuando el
      // llamador declaró `assetCode` -- sin activo, el ticket se comporta EXACTAMENTE
      // igual que antes de esta migración (ver comentario de `assetCode` arriba).
      let assetHistorial: { ticketId: string; title: string; severity: string; status: string; createdAt: string }[] = [];
      let escalado = false;
      let escaladoARoles: readonly string[] = [];
      if (assetId) {
        const { rows: policyRows } = await deps.db.query<{ threshold_count: number; window_days: number }>(
          "select threshold_count, window_days from public.maintenance_escalation_policy where hotel_id = $1;",
          [ctx.hotelId],
        );
        const policy =
          policyRows[0] && policyRows[0].threshold_count > 0 && policyRows[0].window_days > 0
            ? { thresholdCount: policyRows[0].threshold_count, windowDays: policyRows[0].window_days }
            : DEFAULT_ASSET_ESCALATION_POLICY;

        // Conteo "N tickets repetidos en X días" -- SIEMPRE incluye el recién creado
        // (`created_at` del nuevo ticket ya cae dentro de la ventana que arranca en
        // `now() - windowDays`, evaluada por Postgres en esta misma consulta).
        const { rows: countRows } = await deps.db.query<{ n: string }>(
          `select count(*)::text as n from public.maintenance_ticket
           where hotel_id = $1 and asset_id = $2
             and created_at >= now() - ($3 || ' days')::interval;`,
          [ctx.hotelId, assetId, policy.windowDays],
        );
        const ticketsEnVentana = Number(countRows[0]?.n ?? "0");
        escalado = ticketsEnVentana >= policy.thresholdCount;

        if (escalado) {
          escaladoARoles = DEFAULT_ASSET_ESCALATION_ROLES;
          await deps.db.query(
            `update public.maintenance_ticket
             set escalated_at = now(), escalated_to_roles = $1::jsonb, updated_at = now()
             where id = $2;`,
            [JSON.stringify(escaladoARoles), ticketId],
          );
          await recordToolAudit({
            db: deps.db,
            orgId: ctx.orgId,
            hotelId: ctx.hotelId,
            actor: ctx.actor,
            toolName: "crear_ticket_mantenimiento",
            action: "maintenance_ticket.escalado_por_repeticion",
            entityType: "maintenance_ticket",
            entityId: ticketId,
            before: { escaladoEn: null },
            after: {
              escaladoEn: new Date().toISOString(),
              escaladoARoles,
              activoId: assetId,
              ticketsEnVentana,
              umbral: policy.thresholdCount,
              ventanaDias: policy.windowDays,
            },
          });
        }

        // Historial del activo (REQ-HK-012 "enriquecer cada ticket con el historial del
        // activo asociado") -- tickets PREVIOS (excluye el recién creado), más
        // recientes primero, sin límite de ventana: el historial completo es lo que
        // permite a mantenimiento ver el patrón de fallas del equipo, no solo las que
        // cayeron dentro de la ventana de escalación.
        const { rows: historyRows } = await deps.db.query<{
          id: string;
          title: string;
          severity: string;
          status: string;
          created_at: string;
        }>(
          `select id, title, severity::text as severity, status::text as status, created_at::text as created_at
           from public.maintenance_ticket
           where hotel_id = $1 and asset_id = $2 and id != $3
           order by created_at desc
           limit 20;`,
          [ctx.hotelId, assetId, ticketId],
        );
        assetHistorial = historyRows.map((h) => ({
          ticketId: h.id,
          title: h.title,
          severity: h.severity,
          status: h.status,
          createdAt: h.created_at,
        }));
      }

      // Hallazgo de auditoría (H6b): antes de esto, la ÚNICA forma de enterarse de un
      // ticket de mantenimiento nuevo era el tablero de staff -- ver comentario de
      // archivo de staffNotify.ts. Se notifica en TODA creación (no solo severidad
      // alta): el trigger de BD `notify_ticket_urgente` (0114) ya cubre el bell interno
      // solo para severidad alta, esta es la notificación ACTIVA por WhatsApp que hoy
      // no existe para ninguna severidad. `assignedTo` nunca se fija en esta creación
      // (ver comentario de `HousekeepingToolDeps`), así que esto siempre notifica por
      // rol "maintenance".
      const notificacion = await notifyStaffOfNewTask(deps, {
        hotelId: ctx.hotelId,
        role: "maintenance",
        templateName: "ticket_mantenimiento_nuevo",
        parameters: [input.title, input.severity, input.roomCode ?? "sin habitación"],
        dedupeKey: ticketId,
      });

      // REQ conector-pms-enterprise: best-effort, ver outboundTaskSync.ts -- nunca
      // bloquea ni revierte la creación local de arriba.
      const outboundSync = await syncTaskToOutboundConnectorBestEffort(deps.outboundSync, {
        taskType: "maintenance_ticket",
        taskId: ticketId,
        hotelId: ctx.hotelId,
        title: input.title,
        description: input.description,
        priority: input.severity,
        roomCode: input.roomCode ?? null,
        status: "abierto",
        occurredAt: new Date().toISOString(),
      });

      return {
        ok: true,
        summary: escalado
          ? `Ticket de mantenimiento "${input.title}" creado (severidad ${input.severity}); escalado a ${escaladoARoles.join("/")} por repetición sobre el mismo activo.`
          : `Ticket de mantenimiento "${input.title}" creado (severidad ${input.severity}).`,
        data: {
          ticketId,
          requiresApproval,
          marksOutOfService,
          notificacion,
          ...(outboundSync ? { outboundSync } : {}),
          ...(assetId ? { assetId, assetHistorial, escalado, escaladoARoles } : {}),
        },
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
    // REQ-AGT-003 (H17-001/GOB-037): el ÚNICO gasto real que este catálogo puede
    // autorizar hoy -- `AgentRunner` (runner.ts) llama esto DESPUÉS de `run()`, solo si
    // `result.ok===true`, para registrar el ROIEvent SIN depender de que el modelo
    // decida llamar aparte "registrar_evento_roi" (REQ-AGT-003 exige cobertura del
    // 100%, sin excepción -- una tool opcional que el modelo puede olvidar llamar no la
    // garantiza). `montoVerificado` (nunca `montoEstimado`): `input.actualCost` es el
    // costo REAL que el humano ya aprobó al autorizar esta tool (GOB-026, doble
    // confirmación), no una proyección -- por eso `confianza: 1`. `input.ticketId` ==
    // `ticket.id` (la query de `run()` ya filtró por ese id + `ctx.hotelId`).
    deriveRoiEvent: (_ctx, input) => ({
      tipoEvento: "gasto_mantenimiento_autorizado",
      montoVerificado: input.actualCost,
      metodoContrafactual:
        "Monto real autorizado y verificado al cerrar el ticket de mantenimiento (costo reportado por " +
        "el técnico/staff tras el diagnóstico, ya confirmado por aprobación humana explícita -- no una " +
        "estimación).",
      confianza: 1,
      referenciaTipo: "tarea",
      referenciaCodigo: input.ticketId,
    }),
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
