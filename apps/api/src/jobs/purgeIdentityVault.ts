// REQ-REC-011/REQ-SEG-004 · "retención ≤30 días post-checkout salvo obligación
// distinta" con purga automática. Borra en LOTES (mismo criterio que
// jobs/purgeIdempotencyKeys.ts) las filas de `identity_vault` (y su `identity_ref`
// correspondiente, por ON DELETE CASCADE) cuyo `checkout_at + retention_days` ya
// venció -- nunca toca una fila con `checkout_at` nulo (huésped todavía en casa).
import type { DbClient } from "@atiende-hoteles/db";

export interface PurgeIdentityVaultResult {
  deletedTotal: number;
  batches: number;
}

export interface PurgeIdentityVaultOptions {
  batchSize?: number;
}

export async function purgeExpiredIdentityVault(
  db: DbClient,
  opts: PurgeIdentityVaultOptions = {},
): Promise<PurgeIdentityVaultResult> {
  const batchSize = opts.batchSize ?? 500;
  if (batchSize < 1) throw new Error("batch_size_invalido: debe ser >= 1.");

  let deletedTotal = 0;
  let batches = 0;

  for (;;) {
    const { rows } = await db.query<{ id: string }>(
      `delete from public.identity_vault
       where id in (
         select id from public.identity_vault
         where checkout_at is not null
           and checkout_at + (retention_days || ' days')::interval < now()
         order by checkout_at asc
         limit $1
       )
       returning id;`,
      [batchSize],
    );

    if (rows.length === 0) break;
    batches += 1;
    deletedTotal += rows.length;
    if (rows.length < batchSize) break;
  }

  return { deletedTotal, batches };
}
