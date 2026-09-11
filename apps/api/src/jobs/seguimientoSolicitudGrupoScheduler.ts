// REQ-RES-013 · planificador EN PROCESO del seguimiento automático de
// `solicitud_grupo` sin respuesta (ver `jobs/seguimientoSolicitudGrupo.ts`) -- mismo
// patrón exacto que `ticketEscalationScheduler.ts`: lock por hotel EN MEMORIA (evita que
// un hotel con muchas solicitudes todavía procesando se dispare dos veces en el mismo
// proceso si un tick tarda más que el intervalo), log/métrica por corrida, arrancado
// desde server.ts. También ejecutable de forma independiente vía
// `node scripts/run-seguimiento-solicitud-grupo-scheduler.ts` (cron del sistema
// operativo).
import type { DbClient } from "@atiende-hoteles/db";
import { runGroupFollowUps, type RunGroupFollowUpsOptions, type RunGroupFollowUpsResult } from "./seguimientoSolicitudGrupo.ts";

export interface HotelForGroupFollowUps {
  id: string;
  tenantId: string;
}

export interface GroupFollowUpTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "ya_en_progreso_en_este_proceso";
  result?: RunGroupFollowUpsResult;
  error?: string;
}

export interface GroupFollowUpSchedulerOptions extends RunGroupFollowUpsOptions {
  onHotelResult?: (hotelId: string, result: RunGroupFollowUpsResult) => void;
  logger?: { error: (obj: unknown, msg?: string) => void };
}

export class GroupFollowUpScheduler {
  private readonly inFlight = new Set<string>();
  private readonly db: DbClient;
  private readonly options: GroupFollowUpSchedulerOptions;

  constructor(db: DbClient, options: GroupFollowUpSchedulerOptions = {}) {
    this.db = db;
    this.options = options;
  }

  hotelesEnProceso(): string[] {
    return [...this.inFlight];
  }

  async tick(hotels: readonly HotelForGroupFollowUps[]): Promise<GroupFollowUpTickResult[]> {
    const results: GroupFollowUpTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }

      this.inFlight.add(hotel.id);
      try {
        const result = await runGroupFollowUps(
          this.db,
          { hotelId: hotel.id, tenantId: hotel.tenantId },
          {
            now: this.options.now,
            messagingPort: this.options.messagingPort,
            templateNameByType: this.options.templateNameByType,
            languageCode: this.options.languageCode,
          },
        );
        this.options.onHotelResult?.(hotel.id, result);
        results.push({ hotelId: hotel.id, ran: true, result });
      } catch (err) {
        this.options.logger?.error({ err, hotelId: hotel.id }, "seguimiento de solicitudes de grupo: error en tick");
        results.push({ hotelId: hotel.id, ran: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.inFlight.delete(hotel.id);
      }
    }

    return results;
  }
}

export async function loadHotelsForGroupFollowUps(db: DbClient): Promise<HotelForGroupFollowUps[]> {
  const { rows } = await db.query<{ id: string; tenant_id: string }>(
    "select id, org_id as tenant_id from public.hotel order by id;",
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/** Arranca el planificador EN PROCESO -- corre un `tick()` inmediatamente y luego cada
 *  `intervalMs` (default 30 min: a diferencia del SLA de tickets -- minutos --, la
 *  ventana más corta aquí es de 48 HORAS, así que 30 min de granularidad de escaneo es
 *  un margen amplio sin sondear en exceso). Devuelve `stop()` para apagarlo limpio
 *  (usado también por pruebas para no dejar timers colgados). */
export function startGroupFollowUpScheduler(
  db: DbClient,
  options: GroupFollowUpSchedulerOptions & {
    intervalMs?: number;
    onTick?: (results: GroupFollowUpTickResult[]) => void;
    onError?: (err: unknown) => void;
  } = {},
): { scheduler: GroupFollowUpScheduler; stop: () => void } {
  const scheduler = new GroupFollowUpScheduler(db, options);
  const intervalMs = options.intervalMs ?? 30 * 60_000;

  const runOnce = () => {
    loadHotelsForGroupFollowUps(db)
      .then((hotels) => scheduler.tick(hotels))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  timer.unref?.();

  return { scheduler, stop: () => clearInterval(timer) };
}
