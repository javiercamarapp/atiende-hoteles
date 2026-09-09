// REQ-HUE-014: "un ticket sin cierre dentro del SLA configurado debe escalar
// automáticamente". Trabajador POR HOTEL (mismo patrón que `purgeConversations.ts`):
// puro respecto al reloj -- SIEMPRE recibe `now` como parámetro (nunca `Date.now()`
// interno) y lo pasa como PARÁMETRO SQL en la comparación (`sla_due_at < $now`), nunca
// usa el `now()` de Postgres -- así, tanto una corrida real (reloj real inyectado por
// `ticketEscalationScheduler.ts`) como una prueba con "reloj simulado" (inyectando
// cualquier `Date`, ver `tests/integration/tickets/sla-escalado.spec.ts`) ejercitan
// EXACTAMENTE la misma consulta, sin necesitar mover el reloj del propio Postgres.
import type { DbClient } from "@atiende-hoteles/db";

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

  return { escalated };
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
