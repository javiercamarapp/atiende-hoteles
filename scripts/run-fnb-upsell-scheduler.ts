#!/usr/bin/env node
// REQ-AB-014 · disparo de ofertas de upsell F&B (T-7/T-3/check-in), ejecutable por CLI
// (cron del sistema operativo), alternativa/complemento al planificador en proceso de
// apps/api/src/server.ts -- un solo "tick": evalúa cada reserva activa de cada hotel y
// dispara (idempotente) las ofertas cuyo momento ya venció.
//
// Uso: node --experimental-strip-types scripts/run-fnb-upsell-scheduler.ts
import { bootstrapDevEngine } from "../apps/api/src/db.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import { FnbUpsellScheduler, loadHotelsForFnbUpsell } from "../apps/api/src/jobs/fnbUpsellScheduler.ts";

async function main() {
  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);
  try {
    const hotels = await loadHotelsForFnbUpsell(engine.admin);
    const scheduler = new FnbUpsellScheduler(engine.admin);
    const results = await scheduler.tick(hotels);

    for (const r of results) {
      if (r.ran) {
        console.log(
          `hotel ${r.hotelId}: ${r.result?.reservationsEvaluated ?? 0} reserva(s) evaluada(s), ${r.result?.triggered.filter((t) => !t.yaDisparada).length ?? 0} oferta(s) disparada(s) de nuevo.`,
        );
      } else if (r.error) {
        console.error(`hotel ${r.hotelId}: ERROR -- ${r.error}`);
      } else {
        console.log(`hotel ${r.hotelId}: omitido (${r.skippedReason}).`);
      }
    }

    process.exitCode = results.some((r) => r.error) ? 1 : 0;
  } finally {
    await engine.stop();
  }
}

if (process.argv[1] && process.argv[1].endsWith("run-fnb-upsell-scheduler.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
