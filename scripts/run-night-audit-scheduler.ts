#!/usr/bin/env node
// REQ-REV-013 · planificador de night audit ejecutable por CLI (cron del sistema
// operativo), alternativa/complemento al planificador en proceso de apps/api/src/server.ts
// -- un solo "tick": cierra el día anterior de cada hotel cuya hora local ya pasó la
// hora configurada (default 03:00), con lock por hotel EN ESTE PROCESO
// (NightAuditScheduler) e idempotencia real entre procesos/instancias
// (night_audit_claim, packages/db/migrations/0031 -- advisory lock transaccional por
// hotel+fecha).
//
// Uso: node scripts/run-night-audit-scheduler.ts [--run-hour-local 3]
import { bootstrapDevEngine } from "../apps/api/src/db.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import { loadHotelsForNightAudit, NightAuditScheduler } from "../apps/api/src/jobs/nightAuditScheduler.ts";

async function main() {
  const hourFlagIndex = process.argv.indexOf("--run-hour-local");
  const runHourLocal = hourFlagIndex >= 0 ? Number(process.argv[hourFlagIndex + 1]) : undefined;

  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);
  try {
    const hotels = await loadHotelsForNightAudit(engine.admin);
    const scheduler = new NightAuditScheduler(engine.admin, { runHourLocal });
    const results = await scheduler.tick(hotels);

    for (const r of results) {
      if (r.ran) {
        console.log(`hotel ${r.hotelId}: night audit ${r.businessDate} completado.`);
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

if (process.argv[1] && process.argv[1].endsWith("run-night-audit-scheduler.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
