// Runner de migraciones idempotente (REQ-GOB-010): aplica los archivos `migrations/*.sql`
// en orden lexicografico, registra cada uno en `schema_migrations` con un checksum, y
// rechaza re-ejecutar el runner si el contenido de una migracion ya aplicada cambio
// (expand-only: nunca se edita una migracion ya mergeada).

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = join(here, "..", "migrations");

export interface MigrationFile {
  filename: string;
  checksum: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function loadMigrationFiles(
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir);
  const files = entries.filter((f) => f.endsWith(".sql")).sort();

  return Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(join(migrationsDir, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      return { filename, checksum, sql };
    }),
  );
}

export async function ensureSchemaMigrationsTable(db: DbClient): Promise<void> {
  await db.exec(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
  `);
}

/**
 * Aplica las migraciones pendientes contra `db` (el `DbClient` admin/superusuario de
 * cualquiera de los dos motores, ver engines.ts). Idempotente: correrlo dos veces
 * seguidas contra la misma base produce el mismo resultado final, con la segunda
 * corrida devolviendo todo en `skipped`.
 */
export async function applyMigrations(
  db: DbClient,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationResult> {
  await ensureSchemaMigrationsTable(db);

  const files = await loadMigrationFiles(migrationsDir);
  const { rows: appliedRows } = await db.query<{ filename: string; checksum: string }>(
    "select filename, checksum from public.schema_migrations;",
  );
  const appliedByFilename = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const priorChecksum = appliedByFilename.get(file.filename);

    if (priorChecksum !== undefined) {
      if (priorChecksum !== file.checksum) {
        throw new Error(
          `migracion_modificada: "${file.filename}" ya fue aplicada con otro contenido. ` +
            "Patron expand-only (REQ-GOB-010): nunca se edita una migracion ya mergeada, " +
            "crea una migracion nueva en su lugar.",
        );
      }
      skipped.push(file.filename);
      continue;
    }

    await db.exec(`begin;\n${file.sql}\ncommit;`);
    await db.query(
      "insert into public.schema_migrations (filename, checksum) values ($1, $2);",
      [file.filename, file.checksum],
    );
    applied.push(file.filename);
  }

  return { applied, skipped };
}

/**
 * Borra todo el esquema `public` (y los roles/objetos definidos en las migraciones) para
 * poder re-aplicar desde cero. Usado por `db:reset` y por `applyMigrations` en pruebas
 * "de cero" (H1: "migraciones aplican desde cero e idempotentes").
 */
export async function dropAllMigratedObjects(db: DbClient): Promise<void> {
  await db.exec(`
    drop schema if exists public cascade;
    drop schema if exists auth cascade;
    create schema public;
    drop role if exists atiende_app;
    drop role if exists authenticated;
  `);
}
