#!/usr/bin/env node
// REQ-RES-013 · seguimiento automático (48h/7 días) de `solicitud_grupo` sin respuesta,
// ejecutable por CLI (cron del sistema operativo), alternativa/complemento al
// planificador en proceso de `apps/api/src/server.ts` -- un solo "tick": envía la
// plantilla de WhatsApp correspondiente a cada seguimiento vencido de cada hotel cuya
// solicitud sigue `pendiente`.
//
// Uso: node --experimental-strip-types scripts/run-seguimiento-solicitud-grupo-scheduler.ts
import { bootstrapDevEngine } from "../apps/api/src/db.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import {
  loadHotelsForGroupFollowUps,
  GroupFollowUpScheduler,
} from "../apps/api/src/jobs/seguimientoSolicitudGrupoScheduler.ts";

async function main() {
  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);
  try {
    const hotels = await loadHotelsForGroupFollowUps(engine.admin);
    // Sin `messagingPort` explícito: usa el default real (`sharedWhatsappAdapter`,
    // ver `apps/api/src/lib/messaging.ts`) -- mismo criterio que el planificador en
    // proceso de `server.ts`.
    const scheduler = new GroupFollowUpScheduler(engine.admin);
    const results = await scheduler.tick(hotels);

    for (const r of results) {
      if (r.ran) {
        console.log(`hotel ${r.hotelId}: ${r.result?.ejecutados.length ?? 0} seguimiento(s) de grupo enviado(s).`);
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

if (process.argv[1] && process.argv[1].endsWith("run-seguimiento-solicitud-grupo-scheduler.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
