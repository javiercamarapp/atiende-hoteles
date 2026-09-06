// auditoria-2/legal [CRITICO]: "La purga de la bóveda de identidad existe y está
// probada, pero no corre en ningún proceso real" -- `purgeExpiredIdentityVault` nunca
// se conectaba a ningún scheduler/cron/CI real (a diferencia de night audit, que sí
// tiene `nightAuditScheduler.ts` + wiring en `server.ts`). Este archivo replica
// exactamente ese mismo patrón para la bóveda de identidad: planificador EN PROCESO
// (`setInterval`, ver `startIdentityVaultPurgeScheduler`), lock POR HOTEL en memoria
// (evita que el mismo proceso dispare una segunda purga del mismo hotel mientras la
// anterior no termina) y un log/métrica por corrida (ver `onTick`/`metrics` y
// `apps/api/src/metrics.ts::incrementIdentityVaultPurged`).
import type { DbClient } from "@atiende-hoteles/db";
import { purgeExpiredIdentityVault, type PurgeIdentityVaultResult } from "./purgeIdentityVault.ts";

export interface HotelForIdentityVaultPurge {
  id: string;
  tenantId: string;
}

export interface IdentityVaultPurgeTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "ya_en_progreso_en_este_proceso";
  result?: PurgeIdentityVaultResult;
  error?: string;
}

export interface IdentityVaultPurgeSchedulerOptions {
  batchSize?: number;
  /** Llamado una vez POR HOTEL con el resultado de su purga (o su error) -- usado para
   *  incrementar la métrica de Prometheus (ver server.ts). */
  onHotelResult?: (hotelId: string, result: PurgeIdentityVaultResult) => void;
}

export class IdentityVaultPurgeScheduler {
  private readonly inFlight = new Set<string>();
  private readonly db: DbClient;
  private readonly options: IdentityVaultPurgeSchedulerOptions;

  constructor(db: DbClient, options: IdentityVaultPurgeSchedulerOptions = {}) {
    this.db = db;
    this.options = options;
  }

  /** Hoteles con una purga en curso EN ESTE PROCESO en este instante. */
  hotelesEnProceso(): string[] {
    return [...this.inFlight];
  }

  async tick(hotels: readonly HotelForIdentityVaultPurge[]): Promise<IdentityVaultPurgeTickResult[]> {
    const results: IdentityVaultPurgeTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }

      this.inFlight.add(hotel.id);
      try {
        const result = await purgeExpiredIdentityVault(this.db, {
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

export async function loadHotelsForIdentityVaultPurge(db: DbClient): Promise<HotelForIdentityVaultPurge[]> {
  const { rows } = await db.query<{ id: string; tenant_id: string }>("select id, org_id as tenant_id from public.hotel order by id;");
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

/**
 * Arranca el planificador EN PROCESO (ver server.ts): corre un `tick()` inmediatamente
 * y luego cada `intervalMs` (default 1h -- la purga no es sensible al minuto como el
 * night audit, pero SÍ debe correr sin depender de que alguien la dispare a mano;
 * también sigue siendo ejecutable de forma independiente vía
 * `node scripts/purge-identity-vault.ts`, cron del sistema operativo). Devuelve
 * `stop()` para detenerlo limpiamente (usado también por tests).
 */
export function startIdentityVaultPurgeScheduler(
  db: DbClient,
  options: IdentityVaultPurgeSchedulerOptions & {
    intervalMs?: number;
    onTick?: (results: IdentityVaultPurgeTickResult[]) => void;
    onError?: (err: unknown) => void;
  } = {},
): { scheduler: IdentityVaultPurgeScheduler; stop: () => void } {
  const scheduler = new IdentityVaultPurgeScheduler(db, options);
  const intervalMs = options.intervalMs ?? 60 * 60_000;

  const runOnce = () => {
    loadHotelsForIdentityVaultPurge(db)
      .then((hotels) => scheduler.tick(hotels))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  // No debe mantener vivo el proceso solo por este timer (mismo criterio que
  // nightAuditScheduler.ts -- permite apagar limpio con SIGTERM/SIGINT).
  timer.unref?.();

  return { scheduler, stop: () => clearInterval(timer) };
}
