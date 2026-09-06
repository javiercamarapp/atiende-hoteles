#!/usr/bin/env node
// H8 · ADR-008 "Backups: pg_dump programado contra el Postgres real (aplica a
// embedded-postgres en desarrollo y a Supabase remoto en producción)". Este script:
//  1) Arranca (o reutiliza, si ya hay uno corriendo) el `embedded-postgres` persistente
//     de desarrollo (mismo data dir/puerto/credenciales que `packages/db/src/cli.ts` y
//     `apps/api/src/db.ts`), porque el paquete npm `embedded-postgres` NO incluye
//     `pg_dump`/`psql` (solo `postgres`/`pg_ctl`/`initdb` -- ver
//     `node_modules/@embedded-postgres/<plataforma>/native/bin/`, verificado en este
//     repo el 2026-09-06; documentado también como blocker B-002 en docs/BLOQUEOS.md).
//  2) Corre `pg_dump -Fc` (formato "custom", el único que soporta `pg_restore
//     --no-owner` limpio y restauración parcial) contra ese servidor.
//  3) Detiene el servidor si este script lo arrancó (lo deja vivo si ya estaba
//     corriendo antes, para no interrumpir un `npm run dev` en curso).
//
// En producción (Supabase, ADR-003) NO se usa este script tal cual: se apunta
// `pg_dump`/`psql` directo al `DATABASE_URL` de Supabase (que sí expone Postgres real
// vía su "connection pooler"/conexión directa) -- ver
// docs/runbooks/backups-restauracion.md "Producción (Supabase)".
//
// Uso:
//   node --experimental-strip-types scripts/backup.ts [--out-dir <dir>]
//   PG_DUMP_BIN=/ruta/a/pg_dump node --experimental-strip-types scripts/backup.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { openEmbeddedPostgres, type EmbeddedPostgresEngine } from "@atiende-hoteles/db";
import { findClientBinary, isServerReachable, DEFAULT_DB_DATA_DIR, DEFAULT_DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } from "./lib/pgClientBin.ts";

export interface BackupResult {
  outFile: string;
  sizeBytes: number;
  startedServerItself: boolean;
}

export async function runBackup(outDir: string): Promise<BackupResult> {
  const pgDumpBin = findClientBinary("pg_dump");
  mkdirSync(outDir, { recursive: true });

  const port = DEFAULT_DB_PORT;
  const alreadyRunning = await isServerReachable(port);
  let engine: EmbeddedPostgresEngine | null = null;

  if (!alreadyRunning) {
    engine = await openEmbeddedPostgres({ databaseDir: DEFAULT_DB_DATA_DIR, port, persistent: true });
  }

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outFile = join(outDir, `atiende-hoteles-${DB_NAME}-${stamp}.dump`);

    execFileSync(
      pgDumpBin,
      ["-h", "127.0.0.1", "-p", String(port), "-U", DB_USER, "-d", DB_NAME, "-Fc", "-f", outFile],
      { env: { ...process.env, PGPASSWORD: DB_PASSWORD }, stdio: "inherit" },
    );

    if (!existsSync(outFile)) throw new Error(`pg_dump no produjo el archivo esperado: ${outFile}`);
    const sizeBytes = statSync(outFile).size;
    return { outFile, sizeBytes, startedServerItself: !alreadyRunning };
  } finally {
    if (engine) await engine.stop();
  }
}

async function main() {
  const outDirFlagIndex = process.argv.indexOf("--out-dir");
  const outDir = outDirFlagIndex >= 0 ? process.argv[outDirFlagIndex + 1]! : join(import.meta.dirname, "..", "backups");
  const result = await runBackup(outDir);
  console.log(`Backup escrito en: ${result.outFile}`);
  console.log(`Tamaño: ${(result.sizeBytes / 1024).toFixed(1)} KiB`);
  console.log(`Servidor embedded-postgres arrancado por este script (y detenido al terminar): ${result.startedServerItself}`);
}

if (process.argv[1] && process.argv[1].endsWith("backup.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
