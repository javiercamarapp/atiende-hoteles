#!/usr/bin/env node
// REQ-REV-017 · recomendación de ajuste de BAR por reputación, ejecutable por CLI (cron
// del sistema operativo), alternativa/complemento al planificador en proceso de
// apps/api/src/server.ts -- un solo "tick": evalúa el índice de reputación de cada
// hotel dentro de la ventana configurada y persiste una recomendación (idempotente) si
// hubo un cruce de umbral.
//
// Uso: node --experimental-strip-types scripts/run-bar-reputacion-scheduler.ts
import { bootstrapDevEngine } from "../apps/api/src/db.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import { BarReputacionScheduler, loadHotelsForBarReputacion } from "../apps/api/src/jobs/barReputacionScheduler.ts";

async function main() {
  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);
  try {
    const hotels = await loadHotelsForBarReputacion(engine.admin);
    const scheduler = new BarReputacionScheduler(engine.admin);
    const results = await scheduler.tick(hotels);

    for (const r of results) {
      if (r.ran) {
        const rec = r.result?.recomendacion;
        console.log(
          rec
            ? `hotel ${r.hotelId}: recomendación de +${rec.ajustePorcentaje}% de BAR (índice ${rec.indiceAntesDeCruce} -> ${rec.indiceActual}, ${r.result?.isNew ? "nueva" : "ya existía"}).`
            : `hotel ${r.hotelId}: sin cruce de umbral (${r.result?.puntosEnVentana ?? 0} día(s) con reseñas en la ventana).`,
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

if (process.argv[1] && process.argv[1].endsWith("run-bar-reputacion-scheduler.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
