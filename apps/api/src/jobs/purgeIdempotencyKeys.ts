// auditoria-1/datos [MEDIO] "idempotency_key no tiene TTL ni columna de expiración" --
// la corrección ya cerrada (`expires_at`, migración 0022, `apps/api/src/lib/idempotency.ts`)
// dejó documentado explícitamente en docs/auditoria-1/correccion-bd.md: "No se
// implementó todavía un job de purga por lote (la columna/índice ya lo dejan listo) --
// documentado como siguiente paso, no simulado."
//
// Este es ese job: borra en LOTES (nunca un único `DELETE` masivo que tome un lock
// prolongado sobre una tabla de alto tráfico de escritura) las filas de
// `idempotency_key` cuya ventana de protección (`expires_at`) ya venció. Ejecutable
// bajo demanda vía CLI (`scripts/purge-idempotency-keys.ts`) o desde un planificador
// (mismo patrón que `runNightAuditScheduler`, ver jobs/nightAuditScheduler.ts).
import type { DbClient } from "@atiende-hoteles/db";

export interface PurgeIdempotencyKeysResult {
  deletedTotal: number;
  batches: number;
}

export interface PurgeIdempotencyKeysOptions {
  /** Filas borradas por lote. Default 500: suficientemente grande para purgar rápido
   *  un backlog real, suficientemente chico para no retener el lock del `DELETE` por
   *  mucho tiempo sobre una tabla con escrituras concurrentes de producción. */
  batchSize?: number;
}

export async function purgeExpiredIdempotencyKeys(
  db: DbClient,
  opts: PurgeIdempotencyKeysOptions = {},
): Promise<PurgeIdempotencyKeysResult> {
  const batchSize = opts.batchSize ?? 500;
  if (batchSize < 1) throw new Error("batch_size_invalido: debe ser >= 1.");

  let deletedTotal = 0;
  let batches = 0;

  // Se ordena por `expires_at` ascendente (el índice `idempotency_key_expires_at_idx`,
  // migración 0022, hace este `ORDER BY ... LIMIT` barato) para purgar primero lo que
  // lleva más tiempo vencido -- sin que esto cambie el resultado final, es la forma más
  // predecible de recorrer el backlog bajo un corte por lotes.
  for (;;) {
    const { rows } = await db.query<{ id: string }>(
      `delete from public.idempotency_key
       where id in (
         select id from public.idempotency_key
         where expires_at < now()
         order by expires_at asc
         limit $1
       )
       returning id;`,
      [batchSize],
    );

    if (rows.length === 0) break;
    batches += 1;
    deletedTotal += rows.length;
    if (rows.length < batchSize) break; // último lote parcial: no queda nada más vencido.
  }

  return { deletedTotal, batches };
}
