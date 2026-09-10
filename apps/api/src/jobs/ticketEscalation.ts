// REQ-HUE-014: "un ticket sin cierre dentro del SLA configurado debe escalar
// automáticamente". Trabajador POR HOTEL (mismo patrón que `purgeConversations.ts`):
// puro respecto al reloj -- SIEMPRE recibe `now` como parámetro (nunca `Date.now()`
// interno) y lo pasa como PARÁMETRO SQL en la comparación (`sla_due_at < $now`), nunca
// usa el `now()` de Postgres -- así, tanto una corrida real (reloj real inyectado por
// `ticketEscalationScheduler.ts`) como una prueba con "reloj simulado" (inyectando
// cualquier `Date`, ver `tests/integration/tickets/sla-escalado.spec.ts`) ejercitan
// EXACTAMENTE la misma consulta, sin necesitar mover el reloj del propio Postgres.
import type { DbClient } from "@atiende-hoteles/db";
import { SLA_WARNING_THRESHOLD_RATIO } from "@atiende-hoteles/domain-hotel";

export interface EscalateTicketsParams {
  hotelId: string;
  tenantId: string;
}

export interface EscalateTicketsOptions {
  /** Reloj inyectable (default: la hora real). Nunca se lee `Date.now()` en ningún otro
   *  punto de este módulo -- toda comparación de vencimiento pasa por este valor. */
  now?: () => Date;
  /** Roles destinatarios de la escalación (REQ-REC-014/fraud_alert usa el mismo patrón
   *  `recipient_roles`/aquí `escalated_to_roles`) -- default gm+owner: el departamento
   *  original ya tuvo su SLA y no lo cumplió, así que la escalación sube un nivel, no se
   *  vuelve a asignar al mismo departamento. */
  escalateToRoles?: readonly string[];
}

export interface EscalatedTicket {
  id: string;
  department: string;
  priority: string;
  roomId: string | null;
}

export interface EscalateTicketsResult {
  escalated: EscalatedTicket[];
  /** Roles a los que se escaló ESTE lote (mismo valor para todos los `escalated` de una
   *  sola corrida, ya que `escalateToRoles` es un único parámetro por llamada) --
   *  expuesto para que el llamador (`ticketEscalationScheduler.ts`) pueda resolver
   *  destinatarios reales y disparar la notificación activa sin adivinar qué roles se
   *  usaron. */
  escalateToRoles: readonly string[];
}

/** Escala (status -> 'escalado', `escalated_at`/`escalated_to_roles` fijados) todo
 *  `guest_ticket` ABIERTO o EN PROGRESO de `hotelId` cuyo `sla_due_at` ya quedó atrás de
 *  `now`. Idempotente: una segunda corrida sobre los mismos tickets ya escalados no
 *  vuelve a tocarlos (el `where status in ('abierto','en_progreso')` los excluye) --
 *  segura de llamar en cada "tick" del planificador sin necesitar su propio lock
 *  transaccional (a diferencia de night audit, esto nunca contabiliza dinero dos veces,
 *  solo cambia un estado que ya queda fijo tras la primera escalación). */
export async function escalateOverdueGuestTickets(
  db: DbClient,
  params: EscalateTicketsParams,
  opts: EscalateTicketsOptions = {},
): Promise<EscalateTicketsResult> {
  const now = (opts.now ?? (() => new Date()))();
  const escalateToRoles = opts.escalateToRoles ?? ["gm", "owner"];

  const { rows } = await db.query<{ id: string; department: string; priority: string; room_id: string | null }>(
    `update public.guest_ticket
     set status = 'escalado',
         escalated_at = $1,
         escalated_to_roles = $2::jsonb,
         updated_at = $1
     where hotel_id = $3
       and status in ('abierto', 'en_progreso')
       and sla_due_at < $1
     returning id, department::text as department, priority::text as priority, room_id;`,
    [now, JSON.stringify(escalateToRoles), params.hotelId],
  );

  const escalated: EscalatedTicket[] = rows.map((r) => ({
    id: r.id,
    department: r.department,
    priority: r.priority,
    roomId: r.room_id,
  }));

  if (escalated.length > 0) {
    await db.query(
      "select public.record_audit_log($1, $2, 'guest_ticket.escalado', 'guest_ticket', null, $3);",
      [
        params.tenantId,
        params.hotelId,
        JSON.stringify({
          ticketIds: escalated.map((t) => t.id),
          escalatedToRoles: escalateToRoles,
          slaVencidoAl: now.toISOString(),
        }),
      ],
    );
  }

  return { escalated, escalateToRoles };
}

export interface WarnedTicket {
  id: string;
  department: string;
  priority: string;
  roomId: string | null;
  /** `staff_user.id` asignado al ticket, si ya se asignó (`assigned_to`, migración
   *  0098) -- null cuando el ticket sigue en la bandeja general del departamento sin
   *  una persona específica encima. El llamador usa esto para notificar al asignado
   *  DIRECTO además del rol supervisor (ver `notifyApproachingSlaGuestTickets`). */
  assignedTo: string | null;
  slaDueAt: string;
}

export interface NotifySlaWarningParams {
  hotelId: string;
  tenantId: string;
}

export interface NotifySlaWarningOptions {
  /** Reloj inyectable (default: la hora real) -- mismo criterio que
   *  `EscalateTicketsOptions.now`: nunca `Date.now()` interno. */
  now?: () => Date;
  /** Fracción del SLA a la que se dispara el aviso temprano (default
   *  `SLA_WARNING_THRESHOLD_RATIO` = 0.75, `@atiende-hoteles/domain-hotel`). Inyectable
   *  solo para pruebas que necesiten un umbral distinto sin esperar minutos reales de
   *  diferencia; en producción SIEMPRE se usa el default documentado del REQ. */
  warningThresholdRatio?: number;
  /** Roles supervisores a notificar junto con el asignado directo (si existe) -- default
   *  `["gm"]`: este esquema no tiene un rol "jefe de departamento" distinto del propio
   *  `department` del ticket ni de gm/owner (8 roles exactos, REQ-TEN-003), así que el
   *  "supervisor" del patrón Duve/Optii es gm (mismo criterio ya usado por
   *  `escalateOverdueGuestTickets` para "sube un nivel" al 100%). El propio
   *  `department` del ticket se notifica SIEMPRE además de estos roles (ver
   *  `notifyApproachingSlaGuestTickets`), representando al "asignado" cuando el ticket
   *  todavía no tiene una persona específica en `assigned_to`. */
  supervisorRoles?: readonly string[];
}

export interface NotifySlaWarningResult {
  warned: WarnedTicket[];
  supervisorRoles: readonly string[];
}

/** REQ-HUE-014 (ampliación "notificación activa", patrón Duve/Optii): marca
 *  (`sla_warning_notified_at`, migración 0127) todo `guest_ticket` ABIERTO o EN
 *  PROGRESO de `hotelId` que ya alcanzó el 75% de su SLA transcurrido (
 *  `isSlaWarningDue`/`computeSlaWarningAt`, `@atiende-hoteles/domain-hotel`) y que
 *  TODAVÍA no recibió ese aviso -- distinto de `escalateOverdueGuestTickets` (100%,
 *  sube de nivel): este aviso NO cambia `status` ni department, es una alerta
 *  preventiva para que el asignado+supervisor actúen ANTES de que el ticket venza del
 *  todo. Idempotente por el mismo criterio que la escalación (`sla_warning_notified_at
 *  is null` en el WHERE): una segunda corrida sobre los mismos tickets ya avisados no
 *  vuelve a tocarlos ni a reenviar el aviso. Un ticket puede recibir el aviso al 75% Y
 *  escalarse después al 100% si nadie actuó a tiempo -- ambos eventos son
 *  independientes y ambos quedan en `audit_log`. */
export async function notifyApproachingSlaGuestTickets(
  db: DbClient,
  params: NotifySlaWarningParams,
  opts: NotifySlaWarningOptions = {},
): Promise<NotifySlaWarningResult> {
  const now = (opts.now ?? (() => new Date()))();
  const warningThresholdRatio = opts.warningThresholdRatio ?? SLA_WARNING_THRESHOLD_RATIO;
  const supervisorRoles = opts.supervisorRoles ?? ["gm"];

  // Umbral = created_at + sla_minutes * ratio minutos -- exactamente
  // `computeSlaWarningAt()` de domain-hotel, reimplementado aquí en SQL (mismo criterio
  // documentado en el encabezado del archivo: la comparación de vencimiento SIEMPRE se
  // hace con `now` como parámetro, nunca con el reloj de Postgres) para poder marcarlo
  // en un solo UPDATE...RETURNING atómico, igual que `escalateOverdueGuestTickets`.
  const { rows } = await db.query<{
    id: string;
    department: string;
    priority: string;
    room_id: string | null;
    assigned_to: string | null;
    sla_due_at: string;
  }>(
    `update public.guest_ticket
     set sla_warning_notified_at = $1
     where hotel_id = $2
       and status in ('abierto', 'en_progreso')
       and sla_warning_notified_at is null
       and created_at + (sla_minutes * $3::numeric) * interval '1 minute' <= $1
     returning id, department::text as department, priority::text as priority, room_id, assigned_to,
               sla_due_at::text as sla_due_at;`,
    [now, params.hotelId, warningThresholdRatio],
  );

  const warned: WarnedTicket[] = rows.map((r) => ({
    id: r.id,
    department: r.department,
    priority: r.priority,
    roomId: r.room_id,
    assignedTo: r.assigned_to,
    slaDueAt: r.sla_due_at,
  }));

  if (warned.length > 0) {
    await db.query(
      "select public.record_audit_log($1, $2, 'guest_ticket.alerta_sla_75', 'guest_ticket', null, $3);",
      [
        params.tenantId,
        params.hotelId,
        JSON.stringify({
          ticketIds: warned.map((t) => t.id),
          umbral: warningThresholdRatio,
          supervisorRoles,
          avisadoAl: now.toISOString(),
        }),
      ],
    );
  }

  return { warned, supervisorRoles };
}

export interface EscalateTicketNowParams {
  ticketId: string;
  hotelId: string;
  tenantId: string;
  /** Motivo de la escalación INMEDIATA (distinto de "SLA vencido") -- p. ej.
   *  "menor_no_acompanado" (REQ-HUE-023). Queda en `audit_log` para trazabilidad. */
  reason: string;
}

export interface EscalateTicketNowOptions {
  now?: () => Date;
  escalateToRoles?: readonly string[];
}

/** REQ-HUE-023: escala UN `guest_ticket` específico de inmediato (sin esperar a que su
 *  SLA venza) -- usada cuando el propio CONTENIDO del mensaje ya exige intervención
 *  humana ahora mismo (menor no acompañado), a diferencia de
 *  `escalateOverdueGuestTickets` (que escanea por `sla_due_at` vencido). Mismo shape de
 *  columnas/auditoría, motivo distinto explícito en `audit_log` para no confundir
 *  ambas causas de escalación en un reporte. Idempotente por el mismo `where status in
 *  (...)`: escalar dos veces el mismo ticket ya escalado no vuelve a tocarlo (0 filas
 *  la segunda vez, `escalated: false`). */
export async function escalateGuestTicketNow(
  db: DbClient,
  params: EscalateTicketNowParams,
  opts: EscalateTicketNowOptions = {},
): Promise<{ escalated: boolean }> {
  const now = (opts.now ?? (() => new Date()))();
  const escalateToRoles = opts.escalateToRoles ?? ["owner", "gm", "frontdesk"];

  const { rows } = await db.query<{ id: string }>(
    `update public.guest_ticket
     set status = 'escalado',
         escalated_at = $1,
         escalated_to_roles = $2::jsonb,
         updated_at = $1
     where id = $3
       and hotel_id = $4
       and status in ('abierto', 'en_progreso')
     returning id;`,
    [now, JSON.stringify(escalateToRoles), params.ticketId, params.hotelId],
  );

  if (rows.length > 0) {
    await db.query(
      "select public.record_audit_log($1, $2, 'guest_ticket.escalado_inmediato', 'guest_ticket', $3, $4);",
      [
        params.tenantId,
        params.hotelId,
        params.ticketId,
        JSON.stringify({ motivo: params.reason, escalatedToRoles: escalateToRoles, escaladoAl: now.toISOString() }),
      ],
    );
  }

  return { escalated: rows.length > 0 };
}
