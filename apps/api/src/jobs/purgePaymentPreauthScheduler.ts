// REQ-SEG-011: mismo patrón EXACTO que `purgeIdentityVaultScheduler.ts`
// (auditoria-2/legal [CRITICO] "la purga existe y está probada pero no corre en ningún
// proceso real") aplicado a la purga de pre-autorizaciones vencidas: planificador EN
// PROCESO (`setInterval`), lock POR HOTEL en memoria, y un resultado por corrida
// (`onHotelResult`/`onTick`, ver `apps/api/src/metrics.ts::incrementPaymentPreauthPurged`
// y `server.ts`).
import type { DbClient } from "@atiende-hoteles/db";
import { purgeExpiredPaymentPreauth, type PurgePaymentPreauthResult } from "./purgePaymentPreauth.ts";

export interface HotelForPaymentPreauthPurge {
  id: string;
  tenantId: string;
}

export interface PaymentPreauthPurgeTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "ya_en_progreso_en_este_proceso";
  result?: PurgePaymentPreauthResult;
  error?: string;
}

export interface PaymentPreauthPurgeSchedulerOptions {
  batchSize?: number;
  /** Llamado una vez POR HOTEL con el resultado de su purga (o su error) -- usado para
   *  incrementar la métrica de Prometheus (ver server.ts). */
  onHotelResult?: (hotelId: string, result: PurgePaymentPreauthResult) => void;
}

export class PaymentPreauthPurgeScheduler {
  private readonly inFlight = new Set<string>();
  private readonly db: DbClient;
  private readonly options: PaymentPreauthPurgeSchedulerOptions;

  constructor(db: DbClient, options: PaymentPreauthPurgeSchedulerOptions = {}) {
    this.db = db;
    this.options = options;
  }

  /** Hoteles con una purga en curso EN ESTE PROCESO en este instante. */
  hotelesEnProceso(): string[] {
    return [...this.inFlight];
  }

  async tick(hotels: readonly HotelForPaymentPreauthPurge[]): Promise<PaymentPreauthPurgeTickResult[]> {
    const results: PaymentPreauthPurgeTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }

      this.inFlight.add(hotel.id);
      try {
        const result = await purgeExpiredPaymentPreauth(this.db, {
          hotelId: hotel.id,
          tenantId: hotel.tenantId,
          batchSize: this.options.batchSize,
        });
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

export async function loadHotelsForPaymentPreauthPurge(db: DbClient): Promise<HotelForPaymentPreauthPurge[]> {
  const { rows } = await db.query<{ id: string; tenant_id: string }>("select id, org_id as tenant_id from public.hotel order by id;");
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/**
 * Arranca el planificador EN PROCESO (ver server.ts): corre un `tick()` inmediatamente
 * y luego cada `intervalMs` (default 1h -- una pre-autorización se retiene por días,
 * igual criterio de frecuencia que `purgeIdentityVaultScheduler.ts`; también sigue
 * siendo ejecutable de forma independiente vía `node scripts/purge-payment-preauth.ts`,
 * cron del sistema operativo). Devuelve `stop()` para detenerlo limpiamente (usado
 * también por tests).
 */
export function startPaymentPreauthPurgeScheduler(
  db: DbClient,
  options: PaymentPreauthPurgeSchedulerOptions & {
    intervalMs?: number;
    onTick?: (results: PaymentPreauthPurgeTickResult[]) => void;
    onError?: (err: unknown) => void;
  } = {},
): { scheduler: PaymentPreauthPurgeScheduler; stop: () => void } {
  const scheduler = new PaymentPreauthPurgeScheduler(db, options);
  const intervalMs = options.intervalMs ?? 60 * 60_000;

  const runOnce = () => {
    loadHotelsForPaymentPreauthPurge(db)
      .then((hotels) => scheduler.tick(hotels))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  // No debe mantener vivo el proceso solo por este timer (mismo criterio que
  // nightAuditScheduler.ts/purgeIdentityVaultScheduler.ts -- permite apagar limpio con
  // SIGTERM/SIGINT).
  timer.unref?.();

  return { scheduler, stop: () => clearInterval(timer) };
}
