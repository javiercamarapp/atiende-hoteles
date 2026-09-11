// REQ-REV-017 (P2/F): planificador EN PROCESO que llama
// `evaluarAjusteBarPorReputacion()` (barReputacionEvaluator.ts) para cada hotel --
// mismo patrón exacto que `ticketEscalationScheduler.ts`/`purgeConversationsScheduler.ts`:
// lock por hotel EN MEMORIA (evita que un hotel con muchas reseñas todavía evaluando
// se dispare dos veces en el mismo proceso si un tick tarda más que el intervalo),
// arrancado desde server.ts, también ejecutable de forma independiente vía
// `node scripts/run-bar-reputacion-scheduler.ts` (cron del sistema operativo).
//
// Este planificador NO dispara ninguna notificación activa (a diferencia de
// `ticketEscalationScheduler.ts`) -- REQ-REV-017 solo exige "recomendar" (persistir la
// recomendación para que owner/gm la vean, `bar_reputation_recommendation`), no exige
// un canal de alerta propio; agregar uno sin que el requisito lo pida sería inventar
// alcance. `onTick`/`onHotelResult` quedan disponibles para que quien arranque el
// scheduler (server.ts, o una prueba) decida loguear/observar cada corrida.
import type { DbClient } from "@atiende-hoteles/db";
import { evaluarAjusteBarPorReputacion, type EvaluateBarReputationResult } from "./barReputacionEvaluator.ts";

export interface HotelForBarReputacion {
  id: string;
  tenantId: string;
}

export interface BarReputacionTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "ya_en_progreso_en_este_proceso";
  result?: EvaluateBarReputationResult;
  error?: string;
}

export interface BarReputacionSchedulerOptions {
  /** Reloj inyectable para pruebas deterministas -- default la hora real, reenviado
   *  tal cual a `evaluarAjusteBarPorReputacion`. */
  now?: () => Date;
  umbral?: number;
  ventanaDias?: number;
  onHotelResult?: (hotelId: string, result: EvaluateBarReputationResult) => void;
}

export class BarReputacionScheduler {
  private readonly inFlight = new Set<string>();
  private readonly db: DbClient;
  private readonly options: BarReputacionSchedulerOptions;

  constructor(db: DbClient, options: BarReputacionSchedulerOptions = {}) {
    this.db = db;
    this.options = options;
  }

  hotelesEnProceso(): string[] {
    return [...this.inFlight];
  }

  async tick(hotels: readonly HotelForBarReputacion[]): Promise<BarReputacionTickResult[]> {
    const results: BarReputacionTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }

      this.inFlight.add(hotel.id);
      try {
        const result = await evaluarAjusteBarPorReputacion(
          this.db,
          { hotelId: hotel.id, tenantId: hotel.tenantId },
          { now: this.options.now, umbral: this.options.umbral, ventanaDias: this.options.ventanaDias },
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

export async function loadHotelsForBarReputacion(db: DbClient): Promise<HotelForBarReputacion[]> {
  const { rows } = await db.query<{ id: string; tenant_id: string }>(
    "select id, org_id as tenant_id from public.hotel order by id;",
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/** Arranca el planificador EN PROCESO -- corre un `tick()` inmediatamente y luego cada
 *  `intervalMs` (default 1h: la reputación no cambia con la urgencia de un SLA de
 *  ticket, un escaneo horario es un margen razonable sin sondear en exceso). Devuelve
 *  `stop()` para apagarlo limpio (usado también por pruebas para no dejar timers
 *  colgados). */
export function startBarReputacionScheduler(
  db: DbClient,
  options: BarReputacionSchedulerOptions & {
    intervalMs?: number;
    onTick?: (results: BarReputacionTickResult[]) => void;
    onError?: (err: unknown) => void;
  } = {},
): { scheduler: BarReputacionScheduler; stop: () => void } {
  const scheduler = new BarReputacionScheduler(db, options);
  const intervalMs = options.intervalMs ?? 60 * 60_000;

  const runOnce = () => {
    loadHotelsForBarReputacion(db)
      .then((hotels) => scheduler.tick(hotels))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();

  return { scheduler, stop: () => clearInterval(timer) };
}
