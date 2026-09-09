#!/usr/bin/env node
// REQ-HUE-014 · escalación automática de `guest_ticket` por SLA vencido, ejecutable por
// CLI (cron del sistema operativo), alternativa/complemento al planificador en proceso
// de apps/api/src/server.ts -- un solo "tick": escala cada `guest_ticket` abierto/en
// progreso de cada hotel cuyo `sla_due_at` ya quedó atrás de la hora actual.
//
// Uso: node scripts/run-ticket-escalation-scheduler.ts
import { bootstrapDevEngine } from "../apps/api/src/db.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import {
  loadHotelsForTicketEscalation,
  TicketEscalationScheduler,
} from "../apps/api/src/jobs/ticketEscalationScheduler.ts";

async function main() {
  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);
  try {
    const hotels = await loadHotelsForTicketEscalation(engine.admin);
    const scheduler = new TicketEscalationScheduler(engine.admin);
    const results = await scheduler.tick(hotels);

    for (const r of results) {
      if (r.ran) {
        console.log(`hotel ${r.hotelId}: ${r.result?.escalated.length ?? 0} ticket(s) escalado(s).`);
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

if (process.argv[1] && process.argv[1].endsWith("run-ticket-escalation-scheduler.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
