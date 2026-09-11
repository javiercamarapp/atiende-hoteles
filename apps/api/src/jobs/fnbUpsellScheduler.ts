// REQ-AB-014 · planificador EN PROCESO del upsell F&B por momentos (ver
// jobs/fnbUpsellOffers.ts) -- mismo patrón exacto que
// jobs/purgeConversationsScheduler.ts/jobs/ticketEscalationScheduler.ts: lock por
// hotel EN MEMORIA (evita que un hotel con muchas reservas todavía evaluando se
// dispare dos veces en el mismo proceso si un tick tarda más que el intervalo),
// log/métrica por corrida, arrancado desde server.ts.
import type { DbClient } from "@atiende-hoteles/db";
import { evaluateAndTriggerFnbUpsellOffers, type EvaluateFnbUpsellResult } from "./fnbUpsellOffers.ts";

export interface HotelForFnbUpsell {
  id: string;
  tenantId: string;
}

export interface FnbUpsellTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "ya_en_progreso_en_este_proceso";
  result?: EvaluateFnbUpsellResult;
  error?: string;
}

export interface FnbUpsellSchedulerOptions {
  /** Reloj inyectable para pruebas deterministas -- default la hora real. */
  now?: () => Date;
  onHotelResult?: (hotelId: string, result: EvaluateFnbUpsellResult) => void;
}

export class FnbUpsellScheduler {
  private readonly inFlight = new Set<string>();
  private readonly db: DbClient;
  private readonly options: FnbUpsellSchedulerOptions;

  constructor(db: DbClient, options: FnbUpsellSchedulerOptions = {}) {
    this.db = db;
    this.options = options;
  }

  hotelesEnProceso(): string[] {
    return [...this.inFlight];
  }

  async tick(hotels: readonly HotelForFnbUpsell[]): Promise<FnbUpsellTickResult[]> {
    const results: FnbUpsellTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }

      this.inFlight.add(hotel.id);
      try {
        const result = await evaluateAndTriggerFnbUpsellOffers(
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

export async function loadHotelsForFnbUpsell(db: DbClient): Promise<HotelForFnbUpsell[]> {
  const { rows } = await db.query<{ id: string; tenant_id: string }>(
    "select id, org_id as tenant_id from public.hotel order by id;",
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/** Arranca el planificador EN PROCESO -- corre un `tick()` inmediatamente y luego cada
 *  `intervalMs` (default 1 hora: los 3 momentos del REQ son de granularidad de DÍAS
 *  -- t-7/t-3/check-in -- así que sondear cada hora deja margen amplio sin perder el
 *  momento por horas de diferencia, muy por debajo del margen de un día completo).
 *  Devuelve `stop()` para apagarlo limpio (usado también por pruebas para no dejar
 *  timers colgados). */
export function startFnbUpsellScheduler(
  db: DbClient,
  options: FnbUpsellSchedulerOptions & {
    intervalMs?: number;
    onTick?: (results: FnbUpsellTickResult[]) => void;
    onError?: (err: unknown) => void;
  } = {},
): { scheduler: FnbUpsellScheduler; stop: () => void } {
  const scheduler = new FnbUpsellScheduler(db, options);
  const intervalMs = options.intervalMs ?? 60 * 60_000;

  const runOnce = () => {
    loadHotelsForFnbUpsell(db)
      .then((hotels) => scheduler.tick(hotels))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();

  return { scheduler, stop: () => clearInterval(timer) };
}
