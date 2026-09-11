#!/usr/bin/env node
// REQ-RES-011 · detección de cotizaciones/reservas abandonadas en el motor propio,
// ejecutable por CLI (cron del sistema operativo), alternativa/complemento al
// planificador en proceso de apps/api/src/server.ts -- un solo "tick": marca y encola el
// contacto de cada `reservation` que sigue `cotizada` y acaba de alcanzar alguna de las
// 3 ventanas (10 min, 2h, 24h). El correo real lo entrega el worker de outbox
// (`scripts/run-email-outbox-worker` / el planificador ya arrancado en `server.ts`), no
// este script.
//
// Uso: node --experimental-strip-types scripts/run-quote-abandonment-scheduler.ts
import { bootstrapDevEngine } from "../apps/api/src/db.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import {
  loadHotelsForQuoteAbandonment,
  QuoteAbandonmentScheduler,
} from "../apps/api/src/jobs/quoteAbandonmentScheduler.ts";

async function main() {
  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);
  try {
    const hotels = await loadHotelsForQuoteAbandonment(engine.admin);
    const scheduler = new QuoteAbandonmentScheduler(engine.admin);
    const results = await scheduler.tick(hotels);

    for (const r of results) {
      if (r.ran) {
        console.log(`hotel ${r.hotelId}: ${r.result?.contacted.length ?? 0} contacto(s) de abandono encolado(s).`);
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

if (process.argv[1] && process.argv[1].endsWith("run-quote-abandonment-scheduler.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
