// REQ-REV-013 (H15-018/H16-003/H07-032): "night audit canónico independiente del PMS
// del hotel" -- la lógica de negocio (posteo de hospedaje, no-shows, resumen de caja)
// ya está hecha y probada desde H5 (`runNightAudit`, jobs/nightAudit.ts), disparable
// bajo demanda vía `POST /hoteles/:hotelId/night-audit`. Lo que faltaba, documentado
// explícitamente en ese archivo y en routes/night-audit.ts ("el cron pendiente de
// infraestructura"), es el PLANIFICADOR: correrlo automáticamente, con lock por hotel
// e idempotencia, sin depender de que alguien lo dispare a mano.
//
// Dos capas de protección contra doble ejecución, cada una con su propio alcance:
//   1. `night_audit_claim()` (packages/db/migrations/0031): advisory lock
//      TRANSACCIONAL por (hotel_id, business_date) -- correcto incluso con VARIOS
//      procesos/instancias de apps/api corriendo el planificador a la vez (nunca
//      postea dos veces el mismo día del mismo hotel).
//   2. `NightAuditScheduler.inFlight` (este archivo): lock EN PROCESO por hotel --
//      evita que el mismo proceso dispare una segunda corrida para un hotel cuya
//      corrida anterior todavía no terminó (p. ej. un hotel grande cuyo cierre tarda
//      más que el intervalo del planificador), sin depender de la capa 1 para algo
//      que es puramente una optimización de este mismo proceso.
import type { DbClient } from "@atiende-hoteles/db";
import { runNightAudit, type NightAuditSummary } from "./nightAudit.ts";

export interface HotelToClose {
  id: string;
  tenantId: string;
  timezone: string;
}

export interface NightAuditSchedulerOptions {
  /** Hora local (0-23) del hotel a partir de la cual se considera "ya se puede cerrar
   *  el día anterior". Default 3 (03:00 hora local) -- después de medianoche, con
   *  margen para checkouts/cargos tardíos del día que se cierra. */
  runHourLocal?: number;
  /** Reloj inyectable para pruebas deterministas -- default `Date.now` real. */
  now?: () => Date;
}

export interface NightAuditTickResult {
  hotelId: string;
  ran: boolean;
  skippedReason?: "fuera_de_horario" | "ya_en_progreso_en_este_proceso";
  businessDate?: string;
  summary?: NightAuditSummary;
  error?: string;
}

/** Fecha de negocio a cerrar: el día ANTERIOR a "hoy", en la zona horaria LOCAL del
 *  hotel (`hotel.timezone`, migración 0023) -- nunca UTC del servidor. */
export function businessDateToClose(nowUtc: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowUtc);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  // `en-CA` da directo el orden YYYY-MM-DD; se resta 1 día operando sobre un Date UTC
  // sintético construido desde esas partes, para no reinventar aritmética de
  // calendario/DST a mano.
  const localAsUtcMidnight = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  localAsUtcMidnight.setUTCDate(localAsUtcMidnight.getUTCDate() - 1);
  return localAsUtcMidnight.toISOString().slice(0, 10);
}

/** Hora local (0-23) del hotel en este instante. */
export function localHour(nowUtc: Date, timezone: string): number {
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).format(nowUtc);
  return Number(formatted) % 24;
}

export class NightAuditScheduler {
  private readonly inFlight = new Set<string>();
  private readonly db: DbClient;
  private readonly options: NightAuditSchedulerOptions;

  constructor(db: DbClient, options: NightAuditSchedulerOptions = {}) {
    this.db = db;
    this.options = options;
  }

  /** Hoteles con una corrida en curso EN ESTE PROCESO en este instante (para pruebas
   *  de la sección "lock por hotel" y para observabilidad). */
  hotelesEnProceso(): string[] {
    return [...this.inFlight];
  }

  /** Un "tick" del planificador: recorre `hotels`, cerrando el día anterior de cada
   *  uno cuya hora local ya pasó `runHourLocal` y que no tenga una corrida en curso EN
   *  ESTE PROCESO. Nunca lanza -- cada hotel reporta su propio resultado/error, un
   *  fallo en un hotel no detiene el resto. */
  async tick(hotels: readonly HotelToClose[]): Promise<NightAuditTickResult[]> {
    const runHourLocal = this.options.runHourLocal ?? 3;
    const now = (this.options.now ?? (() => new Date()))();
    const results: NightAuditTickResult[] = [];

    for (const hotel of hotels) {
      if (this.inFlight.has(hotel.id)) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "ya_en_progreso_en_este_proceso" });
        continue;
      }
      if (localHour(now, hotel.timezone) < runHourLocal) {
        results.push({ hotelId: hotel.id, ran: false, skippedReason: "fuera_de_horario" });
        continue;
      }

      this.inFlight.add(hotel.id);
      const businessDate = businessDateToClose(now, hotel.timezone);
      try {
        const summary = await runNightAudit(this.db, { tenantId: hotel.tenantId, hotelId: hotel.id, businessDate });
        results.push({ hotelId: hotel.id, ran: true, businessDate, summary });
      } catch (err) {
        results.push({ hotelId: hotel.id, ran: false, businessDate, error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.inFlight.delete(hotel.id);
      }
    }

    return results;
  }
}

export async function loadHotelsForNightAudit(db: DbClient): Promise<HotelToClose[]> {
  const { rows } = await db.query<{ id: string; tenant_id: string; timezone: string }>(
    "select id, org_id as tenant_id, timezone from public.hotel order by id;",
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, timezone: r.timezone }));
}

/**
 * Arranca el planificador EN PROCESO (un `setInterval`, ver server.ts) -- corre un
 * `tick()` inmediatamente y luego cada `intervalMs` (default 15 min: mismo orden de
 * magnitud que el polling incremental de REQ-REV-009, sin necesidad de mayor
 * precisión para un cierre que corre una vez al día por hotel). Devuelve `stop()`
 * para detenerlo limpiamente (usado también por tests para no dejar timers colgados).
 */
export function startNightAuditScheduler(
  db: DbClient,
  options: NightAuditSchedulerOptions & { intervalMs?: number; onTick?: (results: NightAuditTickResult[]) => void; onError?: (err: unknown) => void } = {},
): { scheduler: NightAuditScheduler; stop: () => void } {
  const scheduler = new NightAuditScheduler(db, options);
  const intervalMs = options.intervalMs ?? 15 * 60_000;

  const runOnce = () => {
    loadHotelsForNightAudit(db)
      .then((hotels) => scheduler.tick(hotels))
      .then((results) => options.onTick?.(results))
      .catch((err) => options.onError?.(err));
  };

  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  // No debe mantener vivo el proceso solo por este timer (permite que el servidor
  // apague limpio con SIGTERM/SIGINT sin esperar el próximo tick, mismo criterio que
  // el resto de apps/api/src/server.ts).
  timer.unref?.();

  return { scheduler, stop: () => clearInterval(timer) };
}
