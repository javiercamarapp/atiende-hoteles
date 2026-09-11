#!/usr/bin/env node
// REQ-HK-010 · "El sistema debe generar un reporte diario al gerente con minutos reales
// vs. estándar por camarista, habitaciones listas a una hora objetivo, re-limpiezas,
// incidencias y tickets generados." Comando operativo (cron real del sistema operativo,
// mismo criterio exacto que `scripts/auditoria/muestreo-conversaciones.ts` para
// REQ-HUE-007 y `scripts/run-ticket-escalation-scheduler.ts`): genera/regenera el
// reporte del día pedido para CADA hotel del tenant, usando la MISMA lógica
// (`generateHousekeepingDailyReport`/`persistHousekeepingDailyReport`,
// apps/api/src/lib/housekeepingDailyReport.ts) que la ruta interactiva
// (`GET`/`POST /hoteles/:hotelId/housekeeping/reporte-diario`) que el gerente usa desde
// el panel -- una sola implementación, dos formas de dispararla.
//
// Corre contra `embedded-postgres` persistente de desarrollo (`bootstrapDevEngine()`,
// Postgres real, ADR-003). Producción (Supabase) queda fuera de este script a
// propósito, mismo hueco de infraestructura ya documentado en
// `muestreo-conversaciones.ts`/`ticketEscalationScheduler` (`ManagedPostgresEngine.admin`
// es de mínimo privilegio, sin sesión de staff -- ninguna identidad de servicio de
// producción lo resuelve todavía; no se inventa aquí una solución que esos jobs
// tampoco tienen).
//
// Uso:
//   node --experimental-strip-types scripts/housekeeping/reporte-diario.ts [--date=YYYY-MM-DD] [--hotel-id=<uuid>] [--out-dir=docs/logs/operativo]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "@atiende-hoteles/db";
import type { HousekeepingDailyReport } from "@atiende-hoteles/domain-hotel";
import { generateHousekeepingDailyReport, persistHousekeepingDailyReport } from "../../apps/api/src/lib/housekeepingDailyReport.ts";
import { bootstrapDevEngine } from "../../apps/api/src/db.ts";
import { loadEnv } from "../../apps/api/src/env.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");

export interface ReporteDiarioOptions {
  date?: string;
  hotelId?: string;
}

export interface HotelReporteDiarioResult {
  hotelId: string;
  hotelNombre: string;
  report: HousekeepingDailyReport;
}

/** Genera y persiste el reporte de UN hotel para el día pedido -- misma lógica exacta
 *  que usa la ruta POST interactiva. `tenantId` se resuelve aquí (el script no recibe
 *  sesión de staff autenticada como la ruta HTTP). */
export async function runReporteDiarioHotel(
  db: DbClient,
  hotel: { id: string; nombre: string; tenantId: string },
  options: ReporteDiarioOptions = {},
): Promise<HotelReporteDiarioResult> {
  const reportDate = options.date ?? new Date().toISOString().slice(0, 10);
  const report = await generateHousekeepingDailyReport(db, hotel.id, reportDate);
  await persistHousekeepingDailyReport(db, hotel.tenantId, report, null);
  return { hotelId: hotel.id, hotelNombre: hotel.nombre, report };
}

/** Corre el reporte diario de todos los hoteles del tenant (o de uno solo, si se pasa
 *  `options.hotelId`). Nombre/tenant se leen de `location`/`hotel` -- mismo criterio que
 *  `muestreo-conversaciones.ts`. */
export async function runReporteDiario(db: DbClient, options: ReporteDiarioOptions = {}): Promise<HotelReporteDiarioResult[]> {
  const { rows: hoteles } = await db.query<{ id: string; nombre: string; tenant_id: string }>(
    `select h.id, l.name as nombre, h.org_id as tenant_id from public.hotel h
     join public.location l on l.id = h.id
     where $1::uuid is null or h.id = $1::uuid
     order by l.name;`,
    [options.hotelId ?? null],
  );
  const resultados: HotelReporteDiarioResult[] = [];
  for (const hotel of hoteles) {
    resultados.push(
      await runReporteDiarioHotel(db, { id: hotel.id, nombre: hotel.nombre, tenantId: hotel.tenant_id }, options),
    );
  }
  return resultados;
}

export function buildReporteMarkdown(resultados: HotelReporteDiarioResult[], reportDate: string, generadoEn: Date): string {
  const lineas: string[] = [
    `# REQ-HK-010 -- reporte diario de housekeeping al gerente (día ${reportDate})`,
    "",
    `Generado: ${generadoEn.toISOString()}`,
    "",
  ];
  for (const r of resultados) {
    const rep = r.report;
    lineas.push(`## ${r.hotelNombre} (${r.hotelId})`);
    lineas.push(
      `- Habitaciones limpiadas: ${rep.roomsCleaned} · Listas a hora objetivo (${rep.targetReadyTime}): ${rep.roomsReadyByTarget} · Re-limpiezas: ${rep.reCleans} · Incidencias (inspección rechazada): ${rep.incidents} · Tickets de mantenimiento generados: ${rep.ticketsGenerated}`,
    );
    if (rep.camaristas.length === 0) {
      lineas.push("- Sin tareas completadas por ninguna camarista este día.");
    } else {
      lineas.push(
        "",
        "| camarista | habitaciones | minutos reales | minutos estándar | variación |",
        "|---|---|---|---|---|",
      );
      for (const cam of rep.camaristas) {
        lineas.push(
          `| ${cam.fullName ?? cam.staffUserId} | ${cam.roomsCleaned} | ${cam.actualMinutes} | ${cam.standardMinutes} | ${cam.varianceMinutes >= 0 ? "+" : ""}${cam.varianceMinutes} |`,
        );
      }
    }
    lineas.push("");
  }
  return lineas.join("\n");
}

function parseArgs(argv: string[]): ReporteDiarioOptions & { outDir?: string } {
  const out: ReporteDiarioOptions & { outDir?: string } = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "date") out.date = value;
    if (key === "hotel-id") out.hotelId = value;
    if (key === "out-dir") out.outDir = value;
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const reportDate = opts.date ?? new Date().toISOString().slice(0, 10);
  const outDir = opts.outDir ?? join(ROOT, "docs", "logs", "operativo");

  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);

  try {
    const resultados = await runReporteDiario(engine.admin, opts);

    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `REQ-HK-010-reporte-diario-${reportDate}.md`);
    const generadoEn = new Date();
    writeFileSync(outFile, buildReporteMarkdown(resultados, reportDate, generadoEn));

    console.log(`Día reportado: ${reportDate}`);
    for (const r of resultados) {
      console.log(
        `  ${r.hotelNombre} (${r.hotelId}): ${r.report.roomsCleaned} habitaciones limpiadas, ${r.report.roomsReadyByTarget} listas a tiempo, ${r.report.reCleans} re-limpiezas, ${r.report.incidents} incidencias, ${r.report.ticketsGenerated} tickets.`,
      );
    }
    console.log(`Reporte guardado en: ${outFile}`);
  } finally {
    await engine.stop();
  }
}

if (process.argv[1] && process.argv[1].endsWith("reporte-diario.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
