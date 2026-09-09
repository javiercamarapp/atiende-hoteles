// REQ-HUE-014 · planificador EN PROCESO de la escalación automática de `guest_ticket`
// por SLA vencido (ver jobs/ticketEscalation.ts) -- mismo patrón exacto que
// `purgeConversationsScheduler.ts`/`purgeIdentityVaultScheduler.ts`: lock por hotel EN
// MEMORIA (evita que un hotel con muchos tickets todavía escalando se dispare dos veces
// en el mismo proceso si un tick tarda más que el intervalo), log/métrica por corrida,
// arrancado desde server.ts. También ejecutable de forma independiente vía
// `node scripts/run-ticket-escalation-scheduler.ts` (cron del sistema operativo).
//
// Ampliación "notificación activa" (patrón Duve/Optii verificado hoy: al 75% del SLA
// se alerta al asignado+supervisor, al 100% se escala): antes de este cambio, tanto el
// aviso al 75% como la escalación al 100% solo tocaban `guest_ticket`/`audit_log` --
// ninguna notificación salía del proceso (verificado leyendo el código: 0 `fetch`, 0
// insert a `outbox`, 0 llamada a ningún dispatcher). Este archivo es el punto de
// composición correcto para conectar esa notificación activa (mismo criterio de capas
// que `routes/fraude.ts`, que resuelve destinatarios reales y despacha DESPUÉS de que
// la capa de dominio/BD ya decidió el hallazgo) -- `jobs/ticketEscalation.ts` se queda
// puro (solo BD + reloj inyectado), este scheduler es el "llamador" que decide si
// además despacha una notificación, exactamente como fraude.ts decide "si además
// dispatchFraudAlert()".
import type { DbClient } from "@atiende-hoteles/db";
import {
  escalateOverdueGuestTickets,
  notifyApproachingSlaGuestTickets,
  type EscalateTicketsResult,
  type NotifySlaWarningResult,
} from "./ticketEscalation.ts";
import {
  dispatchTicketAlert,
  resolveTicketAlertDestination,
  type TicketAlertDestinationConfig,
} from "../lib/ticketAlertDispatch.ts";

export interface HotelForTicketEscalation {
  id: string;
  tenantId: string;
}

export interface TicketEscalationTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "ya_en_progreso_en_este_proceso";
  result?: EscalateTicketsResult;
  warningResult?: NotifySlaWarningResult;
  error?: string;
}

type TicketAlertDispatchFn = typeof dispatchTicketAlert;

export interface TicketEscalationSchedulerOptions {
  /** Reloj inyectable para pruebas deterministas -- default `Date.now` real. */
  now?: () => Date;
  onHotelResult?: (hotelId: string, result: EscalateTicketsResult) => void;
  /** Análogo a `onHotelResult` pero para el aviso temprano al 75% del SLA. */
  onHotelWarningResult?: (hotelId: string, result: NotifySlaWarningResult) => void;
  /** Destino de la notificación activa (webhook genérico) -- default:
   *  `resolveTicketAlertDestination()` leyendo `process.env` en cada tick (para que un
   *  operador pueda cambiar la variable de entorno sin reiniciar el proceso, mismo
   *  criterio que `resolveMoneyAlertDestination()` se llama por request en vez de
   *  cachearse). Inyectable para pruebas sin tocar `process.env`. */
  alertDestination?: TicketAlertDestinationConfig;
  /** Función de entrega inyectable -- default `dispatchTicketAlert` (el wrapper real
   *  sobre `dispatchMoneyAlert`, que nunca hace una llamada de red real si `destination`
   *  no tiene ningún webhook/correo configurado). Las pruebas inyectan un espía aquí en
   *  vez de mockear `fetch` global, para verificar QUÉ se hubiera enviado sin depender
   *  del transporte. */
  dispatch?: TicketAlertDispatchFn;
  /** `fetch` inyectable, reenviado tal cual a `dispatch` -- default: `fetch` global. */
  fetchFn?: typeof fetch;
  logger?: { error: (obj: unknown, msg?: string) => void };
}

/** Resuelve el staff real (user_id + email) del hotel que tiene alguno de `roles` --
 *  mismo patrón que `resolveRecipients()` de `routes/fraude.ts` (placeholders
 *  posicionales, `roles` siempre viene de un valor propio del dominio, nunca del
 *  cuerpo de una solicitud, así que la consulta parametrizada sigue siendo segura). */
async function resolveStaffByRoles(
  db: DbClient,
  hotelId: string,
  roles: readonly string[],
): Promise<{ userId: string; email: string; role: string }[]> {
  const uniqueRoles = [...new Set(roles)];
  if (uniqueRoles.length === 0) return [];
  const placeholders = uniqueRoles.map((_, i) => `$${i + 2}`).join(",");
  const { rows } = await db.query<{ user_id: string; email: string; role: string }>(
    `select hs.user_id, su.email, hs.role
     from public.hotel_staff hs
     join public.staff_user su on su.id = hs.user_id
     where hs.hotel_id = $1 and hs.role = any(array[${placeholders}]::public.hotel_role[]);`,
    [hotelId, ...uniqueRoles],
  );
  return rows.map((r) => ({ userId: r.user_id, email: r.email, role: r.role }));
}

/** Resuelve UN `staff_user` puntual por id -- usado para el "asignado" directo de un
 *  ticket (`guest_ticket.assigned_to`), que es una persona específica y no un rol. */
async function resolveStaffUserById(db: DbClient, userId: string): Promise<{ userId: string; email: string } | null> {
  const { rows } = await db.query<{ id: string; email: string }>("select id, email from public.staff_user where id = $1;", [
    userId,
  ]);
  return rows[0] ? { userId: rows[0].id, email: rows[0].email } : null;
}

export class TicketEscalationScheduler {
  private readonly inFlight = new Set<string>();
  private readonly db: DbClient;
  private readonly options: TicketEscalationSchedulerOptions;

  constructor(db: DbClient, options: TicketEscalationSchedulerOptions = {}) {
    this.db = db;
    this.options = options;
  }

  hotelesEnProceso(): string[] {
    return [...this.inFlight];
  }

  /** Notificación activa del aviso temprano (75%): asignado directo (si existe) +
   *  supervisor (default gm) + el propio departamento del ticket (representa al
   *  "asignado" cuando `assigned_to` todavía está vacío -- ver comentario de
   *  `NotifySlaWarningOptions.supervisorRoles` en ticketEscalation.ts). */
  private async dispatchWarnings(hotelId: string, warningResult: NotifySlaWarningResult): Promise<void> {
    if (warningResult.warned.length === 0) return;
    const destination = this.options.alertDestination ?? resolveTicketAlertDestination();
    const dispatch = this.options.dispatch ?? dispatchTicketAlert;

    const departamentos = warningResult.warned.map((t) => t.department);
    const recipientsByRole = await resolveStaffByRoles(this.db, hotelId, [...warningResult.supervisorRoles, ...departamentos]);

    for (const ticket of warningResult.warned) {
      const destinatarios = new Map<string, string>();
      for (const r of recipientsByRole) {
        if (warningResult.supervisorRoles.includes(r.role) || r.role === ticket.department) {
          destinatarios.set(r.userId, r.email);
        }
      }
      if (ticket.assignedTo) {
        const asignado = await resolveStaffUserById(this.db, ticket.assignedTo);
        if (asignado) destinatarios.set(asignado.userId, asignado.email);
      }

      await dispatch(
        {
          nivel: "alerta",
          tipo: "ticket_sla_alerta_75",
          ticket_id: ticket.id,
          hotel_id: hotelId,
          departamento: ticket.department,
          prioridad: ticket.priority,
          sla_vence_en: ticket.slaDueAt,
          asignado_a: ticket.assignedTo,
          roles_supervisor: warningResult.supervisorRoles,
          destinatarios: [...destinatarios.values()],
        },
        destination,
        { fetchFn: this.options.fetchFn, logger: this.options.logger },
      );
    }
  }

  /** Notificación activa de la escalación (100%): a los roles reales de
   *  `result.escalateToRoles` (default gm+owner, ver ticketEscalation.ts). */
  private async dispatchEscalations(hotelId: string, result: EscalateTicketsResult): Promise<void> {
    if (result.escalated.length === 0) return;
    const destination = this.options.alertDestination ?? resolveTicketAlertDestination();
    const dispatch = this.options.dispatch ?? dispatchTicketAlert;

    const recipients = await resolveStaffByRoles(this.db, hotelId, result.escalateToRoles);
    const destinatarios = recipients.map((r) => r.email);

    for (const ticket of result.escalated) {
      await dispatch(
        {
          nivel: "alerta",
          tipo: "ticket_sla_escalado",
          ticket_id: ticket.id,
          hotel_id: hotelId,
          departamento: ticket.department,
          prioridad: ticket.priority,
          roles_destinatario: result.escalateToRoles,
          destinatarios,
        },
        destination,
        { fetchFn: this.options.fetchFn, logger: this.options.logger },
      );
    }
  }

  async tick(hotels: readonly HotelForTicketEscalation[]): Promise<TicketEscalationTickResult[]> {
    const results: TicketEscalationTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }

      this.inFlight.add(hotel.id);
      try {
        // Orden: aviso temprano (75%) antes que escalación (100%) -- refleja la
        // urgencia creciente del propio patrón (Duve/Optii). Un ticket cuyo reloj
        // simulado salta directo más allá del 100% puede cumplir AMBAS condiciones en
        // el mismo tick (p. ej. una prueba que adelanta el reloj de un salto); eso es
        // correcto, no un bug: de verdad está tanto "por encima del 75%" como
        // "vencido", así que ambas notificaciones son ciertas.
        const warningResult = await notifyApproachingSlaGuestTickets(
          this.db,
          { hotelId: hotel.id, tenantId: hotel.tenantId },
          { now: this.options.now },
        );
        this.options.onHotelWarningResult?.(hotel.id, warningResult);
        await this.dispatchWarnings(hotel.id, warningResult);

        const result = await escalateOverdueGuestTickets(
          this.db,
          { hotelId: hotel.id, tenantId: hotel.tenantId },
          { now: this.options.now },
        );
        this.options.onHotelResult?.(hotel.id, result);
        await this.dispatchEscalations(hotel.id, result);

        results.push({ hotelId: hotel.id, ran: true, result, warningResult });
      } catch (err) {
        results.push({ hotelId: hotel.id, ran: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.inFlight.delete(hotel.id);
      }
    }

    return results;
  }
}

export async function loadHotelsForTicketEscalation(db: DbClient): Promise<HotelForTicketEscalation[]> {
  const { rows } = await db.query<{ id: string; tenant_id: string }>(
    "select id, org_id as tenant_id from public.hotel order by id;",
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/** Arranca el planificador EN PROCESO -- corre un `tick()` inmediatamente y luego cada
 *  `intervalMs` (default 5 min: un SLA "alta" por defecto es de 30 min, así que 5 min de
 *  granularidad de escaneo es un margen razonable sin sondear en exceso). Devuelve
 *  `stop()` para apagarlo limpio (usado también por pruebas para no dejar timers
 *  colgados). */
export function startTicketEscalationScheduler(
  db: DbClient,
  options: TicketEscalationSchedulerOptions & {
    intervalMs?: number;
    onTick?: (results: TicketEscalationTickResult[]) => void;
    onError?: (err: unknown) => void;
  } = {},
): { scheduler: TicketEscalationScheduler; stop: () => void } {
  const scheduler = new TicketEscalationScheduler(db, options);
  const intervalMs = options.intervalMs ?? 5 * 60_000;

  const runOnce = () => {
    loadHotelsForTicketEscalation(db)
      .then((hotels) => scheduler.tick(hotels))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();

  return { scheduler, stop: () => clearInterval(timer) };
}
