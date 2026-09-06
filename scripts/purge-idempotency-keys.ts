#!/usr/bin/env node
// auditoria-1/datos [MEDIO] pendiente: "no se implementó todavía un job de purga por
// lote (la columna/índice ya lo dejan listo) -- documentado como siguiente paso, no
// simulado" (docs/auditoria-1/correccion-bd.md). Este script es ese job, ejecutable
// por CLI directa (cron del sistema operativo, o el runbook de operación) contra el
// Postgres de desarrollo persistente/producción -- corre con el cliente ADMIN (mismo
// criterio que scripts/backup.ts/restore.ts): la purga de `idempotency_key` es
// mantenimiento de plataforma, no una acción de ningún tenant/usuario.
//
// Uso:
//   node scripts/purge-idempotency-keys.ts [--batch-size 500]
import { bootstrapDevEngine } from "../apps/api/src/db.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import { purgeExpiredIdempotencyKeys } from "../apps/api/src/jobs/purgeIdempotencyKeys.ts";

async function main() {
  const batchFlagIndex = process.argv.indexOf("--batch-size");
  const batchSize = batchFlagIndex >= 0 ? Number(process.argv[batchFlagIndex + 1]) : undefined;

  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);
  try {
    const result = await purgeExpiredIdempotencyKeys(engine.admin, { batchSize });
    console.log(`idempotency_key purgadas: ${result.deletedTotal} fila(s) en ${result.batches} lote(s) de hasta ${batchSize ?? 500}.`);
  } finally {
    await engine.stop();
  }
}

if (process.argv[1] && process.argv[1].endsWith("purge-idempotency-keys.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
