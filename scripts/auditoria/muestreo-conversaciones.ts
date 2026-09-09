#!/usr/bin/env node
// REQ-HUE-007 · "El sistema debe auditar semanalmente una muestra de
// conversaciones/llamadas (p. ej. 30) para detectar errores del bot [...]." Este script
// es el comando de aceptación que `docs/ACEPTACION.md` ya prescribía
// (`node scripts/auditoria/muestreo-conversaciones.ts --n=30`) pero que no existía en
// el repo: genera (o reutiliza, si ya existe) la muestra semanal de CADA hotel del
// tenant, la persiste en `public.conversation_audit_sample`
// (packages/db/migrations/0124_auditoria_conversaciones_semanal.sql) exactamente con la
// misma lógica determinística que usa la ruta interactiva
// (`apps/api/src/routes/auditoriaConversaciones.ts` -- ambas llaman a
// `selectWeeklyAuditSample`, @atiende-hoteles/domain-hotel), y escribe un reporte
// fechado en `docs/logs/operativo/` con lo que quedó pendiente de revisar.
//
// Corre contra `embedded-postgres` persistente de desarrollo (mismo mecanismo exacto
// que `scripts/run-ticket-escalation-scheduler.ts`/`scripts/run-night-audit-scheduler.ts`:
// `bootstrapDevEngine()` -- aplica migraciones y siembra datos de desarrollo si la base
// está vacía) -- Postgres real, ADR-003, nunca un mock. Producción (Supabase) queda
// fuera de este script a propósito, mismo motivo que ya deja explícito el comentario de
// cabecera de `packages/db/src/engines.ts` sobre `ManagedPostgresEngine.admin`: ese
// cliente es DELIBERADAMENTE el rol de mínimo privilegio `atiende_app` sin sesión
// (nunca superusuario), así que no puede escribir `conversation_audit_sample` bajo RLS
// -- una escalación a "job de sistema" con su propia identidad de servicio en
// producción es una decisión de infraestructura pendiente, la misma que ya aplica hoy
// a `ticketEscalationScheduler`/`purgeConversations` (ningún job de este repo la
// resuelve todavía para Supabase; no se inventa aquí una solución que esos otros jobs
// tampoco tienen).
//
// Uso:
//   node --experimental-strip-types scripts/auditoria/muestreo-conversaciones.ts [--n=30] [--hotel-id=<uuid>] [--week-of=YYYY-MM-DD] [--out-dir=docs/logs/operativo]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "@atiende-hoteles/db";
import {
  DEFAULT_WEEKLY_AUDIT_SAMPLE_SIZE,
  resolveIsoWeekStart,
  resolveAuditWindow,
  selectWeeklyAuditSample,
} from "@atiende-hoteles/domain-hotel";
import { bootstrapDevEngine } from "../../apps/api/src/db.ts";
import { loadEnv } from "../../apps/api/src/env.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");

export interface MuestreoOptions {
  weekOf?: string;
  sampleSize?: number;
  hotelId?: string;
}

interface ItemMuestra {
  id: string;
  conversationId: string;
  canal: string;
  telefonoHuesped: string | null;
  ultimoMensajeEn: string | null;
  pendienteDeRevision: boolean;
}

export interface HotelMuestreoResult {
  hotelId: string;
  hotelNombre: string;
  weekOf: string;
  candidatos: number;
  muestra: ItemMuestra[];
  yaExistia: boolean;
}

/** Genera (o reutiliza) la muestra semanal de UN hotel -- misma query/lógica
 *  determinística que `apps/api/src/routes/auditoriaConversaciones.ts` POST, contra el
 *  cliente de BD que se le pase (real: `EmbeddedPostgresEngine.admin`, o el fixture de
 *  prueba con embedded-postgres real, ADR-003 -- nunca un mock). */
export async function runMuestreoSemanalHotel(
  db: DbClient,
  hotel: { id: string; nombre: string },
  options: MuestreoOptions = {},
): Promise<HotelMuestreoResult> {
  const weekOf = options.weekOf ?? resolveIsoWeekStart(new Date());
  const window = resolveAuditWindow(weekOf);

  const { rows: existentes } = await db.query<{ id: string; conversation_id: string; reviewed_at: string | null }>(
    `select id, conversation_id, reviewed_at::text as reviewed_at
     from public.conversation_audit_sample where hotel_id = $1 and week_of = $2;`,
    [hotel.id, weekOf],
  );

  let sampleRows = existentes;
  const yaExistia = existentes.length > 0;
  let candidatosCount = existentes.length;

  if (!yaExistia) {
    const { rows: candidatos } = await db.query<{ id: string; tenant_id: string }>(
      `select id, tenant_id from public.conversation
       where hotel_id = $1 and last_message_at >= $2 and last_message_at < $3;`,
      [hotel.id, window.start.toISOString(), window.end.toISOString()],
    );
    candidatosCount = candidatos.length;
    const tenantId = candidatos[0]?.tenant_id ?? null;
    const seleccionados = selectWeeklyAuditSample(
      candidatos.map((c) => c.id),
      { seed: `${hotel.id}::${weekOf}`, sampleSize: options.sampleSize ?? DEFAULT_WEEKLY_AUDIT_SAMPLE_SIZE },
    );

    for (const conversationId of seleccionados) {
      await db.query(
        `insert into public.conversation_audit_sample (tenant_id, hotel_id, conversation_id, week_of)
         values (coalesce($1, (select tenant_id from public.conversation where id = $3)), $2, $3, $4)
         on conflict (hotel_id, week_of, conversation_id) do nothing;`,
        [tenantId, hotel.id, conversationId, weekOf],
      );
    }

    const { rows: creados } = await db.query<{ id: string; conversation_id: string; reviewed_at: string | null }>(
      `select id, conversation_id, reviewed_at::text as reviewed_at
       from public.conversation_audit_sample where hotel_id = $1 and week_of = $2;`,
      [hotel.id, weekOf],
    );
    sampleRows = creados;
  }

  const detalles: ItemMuestra[] = [];
  for (const row of sampleRows) {
    const { rows } = await db.query<{ channel: string; guest_phone: string | null; last_message_at: string | null }>(
      `select channel::text as channel, guest_phone, last_message_at::text as last_message_at
       from public.conversation where id = $1;`,
      [row.conversation_id],
    );
    detalles.push({
      id: row.id,
      conversationId: row.conversation_id,
      canal: rows[0]?.channel ?? "desconocido",
      telefonoHuesped: rows[0]?.guest_phone ?? null,
      ultimoMensajeEn: rows[0]?.last_message_at ?? null,
      pendienteDeRevision: row.reviewed_at === null,
    });
  }

  return {
    hotelId: hotel.id,
    hotelNombre: hotel.nombre,
    weekOf,
    candidatos: candidatosCount,
    muestra: detalles,
    yaExistia,
  };
}

/** Corre el muestreo de todos los hoteles del tenant (o de uno solo, si se pasa
 *  `options.hotelId`). El nombre se lee de `location` (mismo criterio que
 *  `hoteles.ts`): `hotel.id` referencia `location.id`, `hotel` no tiene columna de
 *  nombre propia. */
export async function runMuestreoSemanal(db: DbClient, options: MuestreoOptions = {}): Promise<HotelMuestreoResult[]> {
  const { rows: hoteles } = await db.query<{ id: string; nombre: string }>(
    `select h.id, l.name as nombre from public.hotel h
     join public.location l on l.id = h.id
     where $1::uuid is null or h.id = $1::uuid
     order by l.name;`,
    [options.hotelId ?? null],
  );
  const resultados: HotelMuestreoResult[] = [];
  for (const hotel of hoteles) {
    resultados.push(await runMuestreoSemanalHotel(db, hotel, options));
  }
  return resultados;
}

export function buildReporteMarkdown(resultados: HotelMuestreoResult[], weekOf: string, generadoEn: Date): string {
  const lineas: string[] = [
    `# REQ-HUE-007 -- auditoría semanal de conversaciones (semana del ${weekOf})`,
    "",
    `Generado: ${generadoEn.toISOString()}`,
    "",
  ];
  for (const r of resultados) {
    lineas.push(`## ${r.hotelNombre} (${r.hotelId})`);
    lineas.push(
      `- Candidatas en la ventana: ${r.candidatos} · Muestra: ${r.muestra.length} · ${r.yaExistia ? "ya existía (idempotente)" : "generada ahora"}`,
    );
    if (r.muestra.length === 0) {
      lineas.push("- Sin conversaciones candidatas esta semana (0 conversaciones con mensaje en la ventana).");
    } else {
      lineas.push("", "| id muestra | conversación | canal | teléfono | último mensaje | pendiente |", "|---|---|---|---|---|---|");
      for (const item of r.muestra) {
        lineas.push(
          `| ${item.id} | ${item.conversationId} | ${item.canal} | ${item.telefonoHuesped ?? "-"} | ${item.ultimoMensajeEn ?? "-"} | ${item.pendienteDeRevision ? "sí" : "no"} |`,
        );
      }
    }
    lineas.push("");
  }
  return lineas.join("\n");
}

function parseArgs(argv: string[]): MuestreoOptions & { outDir?: string } {
  const out: MuestreoOptions & { outDir?: string } = {};
  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "n") out.sampleSize = Number(value);
    if (key === "hotel-id") out.hotelId = value;
    if (key === "week-of") out.weekOf = value;
    if (key === "out-dir") out.outDir = value;
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const weekOf = opts.weekOf ?? resolveIsoWeekStart(new Date());
  const outDir = opts.outDir ?? join(ROOT, "docs", "logs", "operativo");

  const env = loadEnv();
  const engine = await bootstrapDevEngine(env);

  try {
    const resultados = await runMuestreoSemanal(engine.admin, opts);
    const totalMuestra = resultados.reduce((acc, r) => acc + r.muestra.length, 0);
    const totalPendiente = resultados.reduce((acc, r) => acc + r.muestra.filter((i) => i.pendienteDeRevision).length, 0);

    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `REQ-HUE-007-auditoria-semanal-${weekOf}.md`);
    const generadoEn = new Date();
    writeFileSync(outFile, buildReporteMarkdown(resultados, weekOf, generadoEn));

    console.log(`Semana auditada: ${weekOf}`);
    for (const r of resultados) {
      console.log(
        `  ${r.hotelNombre} (${r.hotelId}): ${r.muestra.length}/${r.candidatos} candidatas muestreadas (${r.yaExistia ? "ya existía" : "nueva"}), ${r.muestra.filter((i) => i.pendienteDeRevision).length} pendientes de revisión.`,
      );
    }
    console.log(`Total: ${totalMuestra} conversaciones en muestra, ${totalPendiente} pendientes de revisión.`);
    console.log(`Reporte guardado en: ${outFile}`);
  } finally {
    await engine.stop();
  }
}

if (process.argv[1] && process.argv[1].endsWith("muestreo-conversaciones.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
