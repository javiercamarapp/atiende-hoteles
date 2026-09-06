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
}

export interface DrainOutboxResult {
  delivered: string[];
  retried: string[];
  deadLettered: string[];
}

export function computeBackoffMs(attempts: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attempts, maxDelayMs);
}

export async function drainOutboxOnce(db: DbClient, options: DrainOutboxOptions): Promise<DrainOutboxResult> {
  const batchSize = options.batchSize ?? 20;
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 5 * 60 * 1000;

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
      await handler(row);
      await db.query("update public.outbox set status = 'enviado', updated_at = now() where id = $1;", [row.id]);
      result.delivered.push(row.id);
    } catch {
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        await db.query(
          "update public.outbox set status = 'fallido', attempts = $2, updated_at = now() where id = $1;",
          [row.id, attempts],
        );
        result.deadLettered.push(row.id);
      } else {
        const delayMs = computeBackoffMs(attempts, baseDelayMs, maxDelayMs);
        await db.query(
          "update public.outbox set attempts = $2, available_at = now() + ($3 || ' milliseconds')::interval, updated_at = now() where id = $1;",
          [row.id, attempts, String(delayMs)],
        );
        result.retried.push(row.id);
      }
    }
  }

  return result;
}
