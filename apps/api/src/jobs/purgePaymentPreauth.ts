// REQ-SEG-011/H19-013/H15-020 · "los tokens de VCC/pre-autorización no utilizados
// deben purgarse/expirar automáticamente; la retención de datos de tarjeta se limita a
// lo estrictamente necesario para conciliación y disputa de contracargo."
//
// `public.payment` ya modela la máquina de estados real de `PaymentProviderPort`
// (migración 0030_folio_engine.sql): `status` incluye 'autorizado' (pre-auth vigente,
// no capturada) y 'expirado', `token_ref` guarda la referencia OPACA del PSP (nunca un
// PAN -- constraint `payment_token_ref_not_pan`), y `preauth_expires_at` guarda el
// vencimiento de la retención (`PreAuthorizeInput.holdMinutes`,
// `packages/mcp-servers/payments/src/port.ts`). Lo que faltaba -- igual que
// `identity_vault` antes de `jobs/purgeIdentityVault.ts` (auditoria-2/legal
// [CRITICO]) -- era el JOB que de verdad recorre esa tabla: sin él, un token de
// pre-autorización vencido se queda vivo en la fila indefinidamente, exactamente la
// "retención de datos de tarjeta más allá de lo estrictamente necesario" que este
// requisito prohíbe.
//
// Esta función borra en LOTES (mismo criterio que purgeIdempotencyKeys.ts/
// purgeIdentityVault.ts: nunca un único UPDATE masivo que retenga el lock por mucho
// tiempo sobre una tabla de dinero) y hace DOS cosas por cada pre-auth vencida, en la
// misma fila:
//   1. transiciona `status` a 'expirado' (fail-closed: `capturePreAuth()` en el
//      adaptador ya lanza `PreAuthExpiredError` si se intenta capturar una vencida --
//      esto deja esa misma verdad reflejada en la BD sin esperar a que alguien lo
//      intente y falle).
//   2. limpia `token_ref` a NULL -- "purgar" el token, no solo "expirarlo": una
//      pre-autorización vencida nunca se puede capturar (ver 1), así que el token del
//      PSP ya no sirve para nada y conservarlo es exactamente la retención innecesaria
//      que el requisito prohíbe. El resto de la fila (monto, folio, external_ref,
//      timestamps) SÍ se conserva -- es lo "estrictamente necesario para conciliación
//      y disputa de contracargo" que el mismo requisito exige seguir teniendo.
//
// Nunca toca una fila ya 'expirado'/'capturado'/'fallido'/'reembolsado' (solo
// 'autorizado' vencida) ni una sin `preauth_expires_at` (cobro directo sin
// pre-autorización, `charge()` en vez de `preAuthorize()`).
import type { DbClient } from "@atiende-hoteles/db";

export interface PurgePaymentPreauthResult {
  expiredTotal: number;
  batches: number;
}

export interface PurgePaymentPreauthOptions {
  /** Filas actualizadas por lote. Default 500, mismo criterio que los demás jobs de
   *  purga por lote de este repo. */
  batchSize?: number;
  /** Si se da, solo purga las pre-autorizaciones de ESTE hotel (planificador por
   *  hotel, mismo patrón que `purgeIdentityVault.ts`). Sin él, purga globalmente (uso
   *  del script standalone / tests). */
  hotelId?: string;
  /** Requerido junto con `hotelId` para poder dejar bitácora (`record_audit_log`
   *  necesita tenant_id). Ignorado si `hotelId` no se da. */
  tenantId?: string;
}

export async function purgeExpiredPaymentPreauth(
  db: DbClient,
  opts: PurgePaymentPreauthOptions = {},
): Promise<PurgePaymentPreauthResult> {
  const batchSize = opts.batchSize ?? 500;
  if (batchSize < 1) throw new Error("batch_size_invalido: debe ser >= 1.");

  let expiredTotal = 0;
  let batches = 0;

  for (;;) {
    // Actualiza status+token_ref en el mismo UPDATE (nunca dos pasadas separadas que
    // dejarían una ventana con status ya 'expirado' pero token_ref todavía vivo, o
    // viceversa) -- orden por preauth_expires_at ascendente para purgar primero lo que
    // lleva más tiempo vencido, igual criterio que purgeIdempotencyKeys.ts.
    const { rows } = await db.query<{ id: string }>(
      `update public.payment
       set status = 'expirado', token_ref = null
       where id in (
         select id from public.payment
         where status = 'autorizado'
           and preauth_expires_at is not null
           and preauth_expires_at < now()
           and ($2::uuid is null or hotel_id = $2)
         order by preauth_expires_at asc
         limit $1
       )
       returning id;`,
      [batchSize, opts.hotelId ?? null],
    );

    if (rows.length === 0) break;
    batches += 1;
    expiredTotal += rows.length;
    if (rows.length < batchSize) break; // último lote parcial: no queda nada más vencido.
  }

  // Bitácora (mismo criterio que purgeIdentityVault.ts: solo cuando se conoce el
  // hotel/tenant -- una purga global sin hotelId no tiene un solo tenant al que
  // atribuir la fila).
  if (opts.hotelId && opts.tenantId && expiredTotal > 0) {
    await db.query(
      "select public.record_audit_log($1, $2, 'payment.preauth_expirado_purgado', 'payment', null, $3);",
      [opts.tenantId, opts.hotelId, JSON.stringify({ expiredTotal, batches })],
    );
  }

  return { expiredTotal, batches };
}
