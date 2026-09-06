#!/usr/bin/env node
// H8 · ADR-008 "Backups": restaura un dump (`-Fc`, producido por `scripts/backup.ts`)
// en una BASE DE DATOS NUEVA del MISMO cluster embedded-postgres (nunca sobrescribe la
// original) y verifica que el conteo total de filas de `public.*` coincide EXACTO
// entre el origen y la base restaurada -- la "prueba real: dump + restore en BD nueva y
// conteo igual" que exige el encargo. No usa `n_live_tup`/`pg_stat_user_tables`
// (estimado, puede leer 0 justo después de un restore antes del primer autovacuum):
// cuenta filas reales con `count(*)` por tabla.
import { execFileSync } from "node:child_process";
import pg from "pg";
import { openEmbeddedPostgres, type EmbeddedPostgresEngine } from "@atiende-hoteles/db";
import { findClientBinary, isServerReachable, DEFAULT_DB_DATA_DIR, DEFAULT_DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from "./lib/pgClientBin.ts";

export interface RestoreVerifyResult {
  newDbName: string;
  totalRowsOrigen: number;
  totalRowsRestaurado: number;
  porTabla: { tabla: string; origen: number; restaurado: number; coincide: boolean }[];
  ok: boolean;
}

async function contarFilasPorTabla(client: pg.Client): Promise<Map<string, number>> {
  const { rows: tablas } = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name;`,
  );
  const out = new Map<string, number>();
  for (const { table_name } of tablas) {
    const { rows } = await client.query<{ count: string }>(`select count(*)::text as count from "public"."${table_name}";`);
    out.set(table_name, Number(rows[0]?.count ?? "0"));
  }
  return out;
}

export async function runRestoreAndVerify(dumpFile: string, newDbNameArg?: string): Promise<RestoreVerifyResult> {
  const psqlBin = findClientBinary("psql");
  const pgRestoreBin = findClientBinary("pg_restore");
  const port = DEFAULT_DB_PORT;

  const alreadyRunning = await isServerReachable(port);
  let engine: EmbeddedPostgresEngine | null = null;
  if (!alreadyRunning) {
    engine = await openEmbeddedPostgres({ databaseDir: DEFAULT_DB_DATA_DIR, port, persistent: true });
  }

  const newDbName = newDbNameArg ?? `restore_check_${Date.now()}`;

  try {
    execFileSync(psqlBin, ["-h", "127.0.0.1", "-p", String(port), "-U", DB_USER, "-d", "postgres", "-c", `create database "${newDbName}";`], {
      env: { ...process.env, PGPASSWORD: DB_PASSWORD },
      stdio: "inherit",
    });

    execFileSync(
      pgRestoreBin,
      ["-h", "127.0.0.1", "-p", String(port), "-U", DB_USER, "-d", newDbName, "--no-owner", "--no-privileges", dumpFile],
      { env: { ...process.env, PGPASSWORD: DB_PASSWORD }, stdio: "inherit" },
    );

    const origenClient = new pg.Client({ host: "127.0.0.1", port, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
    const restauradoClient = new pg.Client({ host: "127.0.0.1", port, user: DB_USER, password: DB_PASSWORD, database: newDbName });
    await origenClient.connect();
    await restauradoClient.connect();

    let origenPorTabla: Map<string, number>;
    let restauradoPorTabla: Map<string, number>;
    try {
      origenPorTabla = await contarFilasPorTabla(origenClient);
      restauradoPorTabla = await contarFilasPorTabla(restauradoClient);
    } finally {
      await origenClient.end();
      await restauradoClient.end();
    }

    const porTabla = [...origenPorTabla.entries()].map(([tabla, origen]) => {
      const restaurado = restauradoPorTabla.get(tabla) ?? -1;
      return { tabla, origen, restaurado, coincide: origen === restaurado };
    });
    const totalRowsOrigen = porTabla.reduce((a, t) => a + t.origen, 0);
    const totalRowsRestaurado = porTabla.reduce((a, t) => a + Math.max(0, t.restaurado), 0);
    const ok = porTabla.every((t) => t.coincide) && origenPorTabla.size === restauradoPorTabla.size;

    return { newDbName, totalRowsOrigen, totalRowsRestaurado, porTabla, ok };
  } finally {
    if (engine) await engine.stop();
  }
}

async function main() {
  const dumpFile = process.argv[2];
  if (!dumpFile) {
    console.error("Uso: node --experimental-strip-types scripts/restore.ts <archivo .dump> [nombre_bd_nueva]");
    process.exitCode = 1;
    return;
  }
  const newDbName = process.argv[3];
  const result = await runRestoreAndVerify(dumpFile, newDbName);

  console.log(`Base restaurada: ${result.newDbName}`);
  console.log("Conteo de filas por tabla (origen vs. restaurado):");
  for (const t of result.porTabla) {
    console.log(`  ${t.coincide ? "OK  " : "DIFF"} ${t.tabla}: origen=${t.origen} restaurado=${t.restaurado}`);
  }
  console.log(`Total origen=${result.totalRowsOrigen} restaurado=${result.totalRowsRestaurado}`);
  console.log(result.ok ? "VERIFICACIÓN: conteo igual en todas las tablas." : "VERIFICACIÓN: DIVERGENCIA -- revisar arriba.");
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("restore.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
