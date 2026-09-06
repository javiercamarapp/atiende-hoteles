// H2 · ADR-004: worker de outbox con reintentos exponenciales y dead-letter. Corre con
// el cliente ADMIN (superusuario del motor): es un proceso de infraestructura que drena
// eventos de TODOS los tenants, no una sesión de un usuario final -- mismo principio que
// un worker de cola de Supabase Edge Functions con rol de servicio.
//
// Backoff exponencial con techo: `min(baseMs * 2^attempts, maxDelayMs)`. Tras
// `maxAttempts` fallos consecutivos, el evento se marca `fallido` (dead-letter): deja de
// reintentarse automáticamente, pero permanece en la tabla para inspección/reintento
// manual (nunca se borra, ADR-004 "un error transitorio nunca se trata como éxito ni
// como 'no hay nada que reintentar'").
//
// auditoria-1/backend [ALTO]: hasta antes de este arreglo, el `catch {}` no nombraba ni
// registraba el error real (ningún log, ninguna columna) -- un pago/cargo fallido
// quedaba en `status='fallido'` sin ninguna pista de la causa, y un handler colgado
// (sin timeout propio) bloqueaba indefinidamente el resto del batch. Ahora: (1) la causa
// real (mensaje del error, o "handler_timeout: ..." si el handler no respondió a
// tiempo) se persiste en `outbox.last_error` (0020) en cada reintento/dead-letter, y
// opcionalmente se reporta a un logger inyectable; (2) cada `handler(row)` corre bajo
// `withTimeout()` -- si no resuelve dentro de `handlerTimeoutMs`, se trata como una
// falla más de ESE evento (nunca cuelga el resto del batch) y la promesa abandonada del
// handler original se blinda contra "unhandled rejection".
import type { DbClient } from "@atiende-hoteles/db";

export interface OutboxRow {
  id: string;
  tenant_id: string;
  hotel_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
}

export type OutboxHandler = (row: OutboxRow) => Promise<void>;

export interface DrainOutboxOptions {
  handlers: Record<string, OutboxHandler>;
  batchSize?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Tiempo máximo que se espera un `handler(row)` individual antes de tratarlo como
   *  fallo (dead-letter/retry) sin bloquear el resto del batch. Default 10s. */
  handlerTimeoutMs?: number;
  /** Reporte best-effort de la causa real de cada fallo (además de persistirla en
   *  `outbox.last_error`, 0020) — inyectable para no acoplar este módulo a `pino`. */
  onHandlerError?: (row: OutboxRow, error: unknown) => void;
}

export interface DrainOutboxResult {
  delivered: string[];
  retried: string[];
  deadLettered: string[];
}

export function computeBackoffMs(attempts: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attempts, maxDelayMs);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Corre `promise` con un límite de tiempo: si no resuelve/rechaza dentro de `ms`,
 * rechaza con `handler_timeout` SIN esperar a `promise` (evita que un handler colgado
 * bloquee el resto del batch). La promesa original sigue corriendo en segundo plano --
 * se le adjunta un `.catch()` mudo para que un rechazo tardío no se reporte como
 * "unhandled rejection" del proceso.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`handler_timeout: el handler no respondió dentro de ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  }).catch((err) => {
    promise.catch(() => undefined);
    throw err;
  });
}

export async function drainOutboxOnce(db: DbClient, options: DrainOutboxOptions): Promise<DrainOutboxResult> {
  const batchSize = options.batchSize ?? 20;
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 5 * 60 * 1000;
  const handlerTimeoutMs = options.handlerTimeoutMs ?? 10_000;

  const { rows } = await db.query<OutboxRow>(
    `select id, tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload, attempts
     from public.outbox
     where status = 'pendiente' and available_at <= now()
     order by created_at asc
     limit $1;`,
    [batchSize],
  );

  const result: DrainOutboxResult = { delivered: [], retried: [], deadLettered: [] };

  for (const row of rows) {
    const handler = options.handlers[row.event_type];
    try {
      if (!handler) {
        throw new Error(`sin_manejador_registrado: no hay handler para event_type="${row.event_type}"`);
      }
      await withTimeout(handler(row), handlerTimeoutMs);
      await db.query(
        "update public.outbox set status = 'enviado', last_error = null, updated_at = now() where id = $1;",
        [row.id],
      );
      result.delivered.push(row.id);
    } catch (err) {
      const message = errorMessage(err);
      options.onHandlerError?.(row, err);
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        await db.query(
          "update public.outbox set status = 'fallido', attempts = $2, last_error = $3, updated_at = now() where id = $1;",
          [row.id, attempts, message],
        );
        result.deadLettered.push(row.id);
      } else {
        const delayMs = computeBackoffMs(attempts, baseDelayMs, maxDelayMs);
        await db.query(
          `update public.outbox
           set attempts = $2, last_error = $3, available_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
           where id = $1;`,
          [row.id, attempts, message, String(delayMs)],
        );
        result.retried.push(row.id);
      }
    }
  }

  return result;
}
