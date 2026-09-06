// REQ-REC-011/REQ-SEG-004 · "retención ≤30 días post-checkout salvo obligación
// distinta" con purga automática. Borra en LOTES (mismo criterio que
// jobs/purgeIdempotencyKeys.ts) las filas de `identity_vault` (y su `identity_ref`
// correspondiente, por ON DELETE CASCADE) cuyo `checkout_at + retention_days` ya
// venció -- nunca toca una fila con `checkout_at` nulo (huésped todavía en casa).
//
// auditoria-2/legal [CRITICO] "la purga existe y está probada, pero no corre en ningún
// proceso real": esta función seguía siendo correcta, lo que faltaba era el WIRING --
// ver jobs/purgeIdentityVaultScheduler.ts (planificador en proceso, mismo patrón que
// jobs/nightAuditScheduler.ts) y server.ts (arranque real). `hotelId`/`tenantId` ahora
// son opcionales para poder escoger un hotel a la vez (lock/observabilidad por hotel,
// exigido por la corrección) sin romper `scripts/purge-identity-vault.ts` (que sigue
// llamando sin `hotelId`, purga global, comportamiento sin cambios).
import type { DbClient } from "@atiende-hoteles/db";

export interface PurgeIdentityVaultResult {
  deletedTotal: number;
  batches: number;
}

export interface PurgeIdentityVaultOptions {
  batchSize?: number;
  /** Si se da, solo purga la bóveda de ESTE hotel (planificador por hotel). Sin él,
   *  purga globalmente (uso del script standalone / tests existentes). */
  hotelId?: string;
  /** Requerido junto con `hotelId` para poder dejar bitácora (`record_audit_log`
   *  necesita tenant_id). Ignorado si `hotelId` no se da. */
  tenantId?: string;
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
           and ($2::uuid is null or hotel_id = $2)
         order by checkout_at asc
         limit $1
       )
       returning id;`,
      [batchSize, opts.hotelId ?? null],
    );

    if (rows.length === 0) break;
    batches += 1;
    deletedTotal += rows.length;
    if (rows.length < batchSize) break;
  }

  // Bitácora (REQ-SEG-004/GOB-044 "job automatizado confirma borrado"): solo cuando se
  // conoce el hotel/tenant (purga global sin hotelId no tiene un solo tenant al que
  // atribuir la fila -- se deja sin log en ese caso, igual que antes de este cambio).
  if (opts.hotelId && opts.tenantId && deletedTotal > 0) {
    await db.query("select public.record_audit_log($1, $2, 'identity_vault.purged', 'identity_vault', null, $3);", [
      opts.tenantId,
      opts.hotelId,
      JSON.stringify({ deletedTotal, batches }),
    ]);
  }

  return { deletedTotal, batches };
}
