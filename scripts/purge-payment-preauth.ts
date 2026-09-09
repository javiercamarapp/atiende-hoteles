#!/usr/bin/env node
// REQ-SEG-011 · purga/expiración por lote de pre-autorizaciones de pago (VCC) vencidas
// (`payment.status = 'autorizado'` con `preauth_expires_at < now()`): transiciona a
// 'expirado' y limpia `token_ref`. Ejecutable por CLI directa (cron del sistema
// operativo) contra el Postgres de desarrollo persistente/producción, con el cliente
// ADMIN (mismo criterio que scripts/purge-identity-vault.ts: mantenimiento de
// plataforma, no acción de ningún tenant/usuario).
//
// Uso:
//   node scripts/purge-payment-preauth.ts [--batch-size 500]
import { bootstrapDevEngine } from "../apps/api/src/db.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import { purgeExpiredPaymentPreauth } from "../apps/api/src/jobs/purgePaymentPreauth.ts";

async function main() {
  const batchFlagIndex = process.argv.indexOf("--batch-size");
  const batchSize = batchFlagIndex >= 0 ? Number(process.argv[batchFlagIndex + 1]) : undefined;

  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);
  try {
    const result = await purgeExpiredPaymentPreauth(engine.admin, { batchSize });
    console.log(
      `payment pre-autorizaciones expiradas/purgadas: ${result.expiredTotal} fila(s) en ${result.batches} lote(s) de hasta ${batchSize ?? 500}.`,
    );
  } finally {
    await engine.stop();
  }
}

if (process.argv[1] && process.argv[1].endsWith("purge-payment-preauth.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
