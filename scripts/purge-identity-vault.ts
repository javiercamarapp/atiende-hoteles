#!/usr/bin/env node
// REQ-REC-011/REQ-SEG-004 · purga por lote de la bóveda de identidad vencida
// (retención ≤30 días post-checkout, configurable por fila vía
// identity_vault.retention_days). Ejecutable por CLI directa (cron del sistema
// operativo) contra el Postgres de desarrollo persistente/producción, con el cliente
// ADMIN (mismo criterio que scripts/purge-idempotency-keys.ts: mantenimiento de
// plataforma, no acción de ningún tenant/usuario).
//
// Uso:
//   node scripts/purge-identity-vault.ts [--batch-size 500]
import { bootstrapDevEngine } from "../apps/api/src/db.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import { purgeExpiredIdentityVault } from "../apps/api/src/jobs/purgeIdentityVault.ts";

async function main() {
  const batchFlagIndex = process.argv.indexOf("--batch-size");
  const batchSize = batchFlagIndex >= 0 ? Number(process.argv[batchFlagIndex + 1]) : undefined;

  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);
  try {
    const result = await purgeExpiredIdentityVault(engine.admin, { batchSize });
    console.log(`identity_vault purgadas: ${result.deletedTotal} fila(s) en ${result.batches} lote(s) de hasta ${batchSize ?? 500}.`);
  } finally {
    await engine.stop();
  }
}

if (process.argv[1] && process.argv[1].endsWith("purge-identity-vault.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
