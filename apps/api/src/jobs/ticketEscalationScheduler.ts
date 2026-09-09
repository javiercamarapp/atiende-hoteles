// REQ-HUE-014 · planificador EN PROCESO de la escalación automática de `guest_ticket`
// por SLA vencido (ver jobs/ticketEscalation.ts) -- mismo patrón exacto que
// `purgeConversationsScheduler.ts`/`purgeIdentityVaultScheduler.ts`: lock por hotel EN
// MEMORIA (evita que un hotel con muchos tickets todavía escalando se dispare dos veces
// en el mismo proceso si un tick tarda más que el intervalo), log/métrica por corrida,
// arrancado desde server.ts. También ejecutable de forma independiente vía
// `node scripts/run-ticket-escalation-scheduler.ts` (cron del sistema operativo).
import type { DbClient } from "@atiende-hoteles/db";
import { escalateOverdueGuestTickets, type EscalateTicketsResult } from "./ticketEscalation.ts";

export interface HotelForTicketEscalation {
  id: string;
  tenantId: string;
}

export interface TicketEscalationTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "ya_en_progreso_en_este_proceso";
  result?: EscalateTicketsResult;
  error?: string;
}

export interface TicketEscalationSchedulerOptions {
  /** Reloj inyectable para pruebas deterministas -- default `Date.now` real. */
  now?: () => Date;
  onHotelResult?: (hotelId: string, result: EscalateTicketsResult) => void;
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

  async tick(hotels: readonly HotelForTicketEscalation[]): Promise<TicketEscalationTickResult[]> {
    const results: TicketEscalationTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }

      this.inFlight.add(hotel.id);
      try {
        const result = await escalateOverdueGuestTickets(
          this.db,
          { hotelId: hotel.id, tenantId: hotel.tenantId },
          { now: this.options.now },
        );
        this.options.onHotelResult?.(hotel.id, result);
        results.push({ hotelId: hotel.id, ran: true, result });
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
