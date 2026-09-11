// REQ-RES-011 · planificador EN PROCESO de la detección de cotizaciones abandonadas
// (ver jobs/quoteAbandonment.ts) -- mismo patrón EXACTO que
// `ticketEscalationScheduler.ts`/`purgeConversationsScheduler.ts`: lock por hotel EN
// MEMORIA (evita que un hotel con muchas cotizaciones abandonadas todavía escaneando se
// dispare dos veces en el mismo proceso si un tick tarda más que el intervalo), log/
// métrica por corrida, arrancado desde server.ts. También ejecutable de forma
// independiente vía `node scripts/run-quote-abandonment-scheduler.ts` (cron del sistema
// operativo).
//
// A diferencia de `ticketEscalationScheduler.ts`, este planificador NO despacha ninguna
// notificación él mismo: `detectAndMarkAbandonedQuotes` ya encola un evento
// `reservation.abandonment_contact` por `public.outbox` (ver ese archivo) -- el correo
// real lo entrega el worker de outbox que YA corre en `server.ts`
// (`startEmailOutboxScheduler`/`buildEmailOutboxHandlers.ts`), sin duplicar ese
// mecanismo de entrega/reintento/dead-letter aquí.
import type { DbClient } from "@atiende-hoteles/db";
import { detectAndMarkAbandonedQuotes, type DetectAbandonedQuotesResult } from "./quoteAbandonment.ts";

export interface HotelForQuoteAbandonment {
  id: string;
  tenantId: string;
}

export interface QuoteAbandonmentTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "ya_en_progreso_en_este_proceso";
  result?: DetectAbandonedQuotesResult;
  error?: string;
}

export interface QuoteAbandonmentSchedulerOptions {
  /** Reloj inyectable para pruebas deterministas -- default `Date.now` real. */
  now?: () => Date;
  onHotelResult?: (hotelId: string, result: DetectAbandonedQuotesResult) => void;
}

export class QuoteAbandonmentScheduler {
  private readonly inFlight = new Set<string>();
  private readonly db: DbClient;
  private readonly options: QuoteAbandonmentSchedulerOptions;

  constructor(db: DbClient, options: QuoteAbandonmentSchedulerOptions = {}) {
    this.db = db;
    this.options = options;
  }

  hotelesEnProceso(): string[] {
    return [...this.inFlight];
  }

  async tick(hotels: readonly HotelForQuoteAbandonment[]): Promise<QuoteAbandonmentTickResult[]> {
    const results: QuoteAbandonmentTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }

      this.inFlight.add(hotel.id);
      try {
        const result = await detectAndMarkAbandonedQuotes(
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

export async function loadHotelsForQuoteAbandonment(db: DbClient): Promise<HotelForQuoteAbandonment[]> {
  const { rows } = await db.query<{ id: string; tenant_id: string }>(
    "select id, org_id as tenant_id from public.hotel order by id;",
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/** Arranca el planificador EN PROCESO -- corre un `tick()` inmediatamente y luego cada
 *  `intervalMs` (default 5 min: la ventana más corta del REQ es de 10 min, así que 5 min
 *  de granularidad de escaneo es un margen razonable sin sondear en exceso, mismo
 *  criterio que `ticketEscalationScheduler.ts` con un SLA "alta" de 30 min). Devuelve
 *  `stop()` para apagarlo limpio (usado también por pruebas para no dejar timers
 *  colgados). */
export function startQuoteAbandonmentScheduler(
  db: DbClient,
  options: QuoteAbandonmentSchedulerOptions & {
    intervalMs?: number;
    onTick?: (results: QuoteAbandonmentTickResult[]) => void;
    onError?: (err: unknown) => void;
  } = {},
): { scheduler: QuoteAbandonmentScheduler; stop: () => void } {
  const scheduler = new QuoteAbandonmentScheduler(db, options);
  const intervalMs = options.intervalMs ?? 5 * 60_000;

  const runOnce = () => {
    loadHotelsForQuoteAbandonment(db)
      .then((hotels) => scheduler.tick(hotels))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();

  return { scheduler, stop: () => clearInterval(timer) };
}
