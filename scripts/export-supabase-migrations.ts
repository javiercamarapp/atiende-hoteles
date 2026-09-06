#!/usr/bin/env node
// H12b · LAUNCH-009/D-001: producción sigue siendo Supabase (docs/BLOQUEOS.md D-001,
// docs/ARQUITECTURA.md ADR-003). Las migraciones de `packages/db/migrations/*.sql` están
// escritas para ser compatibles con Supabase (mismos roles `authenticated`/`atiende_app`,
// mismas políticas RLS, `auth.uid()` con la misma firma), EXCEPTO una sola pieza: la
// migración 0001 emula LOCALMENTE (solo PGlite/embedded-postgres) el esquema `auth` y la
// función `auth.uid()` que un proyecto Supabase real YA TRAE integradas (GoTrue) — desplegar
// esa emulación contra Supabase fallaría (el esquema/función ya existen, con otro dueño) o,
// peor, SOMBREARÍA la función real con una versión que lee un `set_config` que GoTrue nunca
// escribe.
//
// Este script genera `supabase/migrations/*.sql` a partir de `packages/db/migrations/*.sql`:
//   - Copia cada migración TAL CUAL, excepto 0001, donde omite la emulación local del
//     esquema `auth` (create schema auth / auth.uid() / grants sobre schema auth) y ajusta
//     la creación de roles: `authenticated`/`anon`/`service_role` YA EXISTEN en Supabase
//     (los crea GoTrue) — no se recrean; solo se crea `atiende_app` (el rol de LOGIN que
//     usa el pool del backend) y se le otorga `authenticated`.
//   - Antepone a cada archivo generado un encabezado `-- ORIGEN: <archivo> sha256:<hash>`
//     con el checksum del archivo FUENTE (packages/db/migrations/<mismo nombre>) — permite
//     verificar, sin Docker/Supabase, que el resultado no quedó desincronizado del origen
//     (ver tests/unit/supabase-export.spec.ts).
//   - NUNCA ejecuta nada contra un proyecto Supabase real: solo escribe archivos locales.
//     `supabase link`/`supabase db push` los ejecuta el USUARIO (GOB-058, ver
//     docs/runbooks/migracion-a-supabase.md) — este script no tiene, ni pide, credenciales
//     de Supabase.
//
// Uso:
//   node --experimental-strip-types scripts/export-supabase-migrations.ts          # genera
//   node --experimental-strip-types scripts/export-supabase-migrations.ts --check  # falla
//     si supabase/migrations/ no está sincronizado con packages/db/migrations/ (CI)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE_DIR = join(here, "..", "packages", "db", "migrations");
export const OUTPUT_DIR = join(here, "..", "supabase", "migrations");

/** Objetos que SOLO tiene sentido crear en el entorno local (PGlite/embedded-postgres,
 *  ADR-003) porque Supabase ya los provee -- si aparecieran en `supabase/migrations/`
 *  después de la transformación, es un bug de esta exportación (ver prueba estática). */
export const PROHIBITED_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "create schema auth", re: /create\s+schema\s+(if\s+not\s+exists\s+)?auth\b/i },
  { name: "create function auth.uid()", re: /create\s+(or\s+replace\s+)?function\s+auth\.uid\s*\(/i },
  { name: 'create role "authenticated"', re: /create\s+role\s+authenticated\b/i },
  { name: 'create role "anon"', re: /create\s+role\s+anon\b/i },
  { name: 'create role "service_role"', re: /create\s+role\s+service_role\b/i },
  { name: "contraseña de desarrollo hardcodeada (atiende_app)", re: /atiende_app_dev_only_local/ },
  { name: "contraseña de desarrollo hardcodeada (postgres)", re: /postgres_dev_only_local/ },
];

const MIGRACION_AUTH_LOCAL = "0001_extensions_and_auth.sql";

/**
 * Transformación de la migración 0001: quita la emulación local de `auth.uid()`/schema
 * `auth` y ajusta la creación de roles (Supabase ya trae `authenticated`/`anon`/
 * `service_role` vía GoTrue -- solo hace falta crear `atiende_app`, el rol de LOGIN propio
 * del backend, y otorgarle `authenticated`).
 */
// `_sourceSql` no se usa (la transformación es un reemplazo fijo, no un parche del
// original) -- se conserva en la firma para que el llamador siga pasando el contenido
// real de 0001 explícitamente, y para poder auditar/diferenciar el original en el mismo
// lugar si en el futuro esta función deja de ser un reemplazo completo.
export function transformAuthMigrationForSupabase(_sourceSql: string): string {
  return `-- H12b · Transformado por scripts/export-supabase-migrations.ts a partir de
-- packages/db/migrations/${MIGRACION_AUTH_LOCAL} (ver encabezado ORIGEN abajo).
--
-- OMITIDO respecto al original (Supabase ya lo provee vía GoTrue, ADR-003):
--   - \`create schema auth\` y \`auth.uid()\` (emulación LOCAL de PGlite/embedded-postgres).
--   - \`create role authenticated/anon/service_role\` -- YA EXISTEN en cualquier proyecto
--     Supabase; recrearlos fallaría o los tomaría con otro dueño/privilegios.
--
-- CONSERVADO: \`gen_random_uuid()\` sigue sin requerir \`create extension pgcrypto\` (nativo
-- desde Postgres 13, igual en Supabase); el bloqueo \`revoke all ... from public\` sobre el
-- esquema \`public\` (Supabase no lo hace por defecto); la creación de \`atiende_app\` (rol de
-- LOGIN propio del backend, no lo trae Supabase) y su membresía en \`authenticated\`.
--
-- ACCIÓN MANUAL REQUERIDA (docs/runbooks/migracion-a-supabase.md): tras aplicar esta
-- migración, ejecutar UNA VEZ, con una contraseña real generada aparte (nunca la de este
-- archivo, que es un placeholder que Postgres rechaza si se usara tal cual en producción
-- por ser previsible):
--   ALTER ROLE atiende_app WITH PASSWORD '<contraseña real, ej. openssl rand -base64 32>';
-- y usar esa contraseña real en \`SUPABASE_DB_PASSWORD\`/la cadena de conexión del backend
-- -- nunca commitear la contraseña real a este repositorio.

do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'atiende_app') then
    create role atiende_app login password 'CAMBIAR_ANTES_DE_PRODUCCION_ver_ALTER_ROLE_arriba'
      nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
  end if;
end
$do$;

grant authenticated to atiende_app;

-- Bloqueo por defecto sobre el esquema public (Supabase no lo aplica de fábrica); el
-- esquema auth NO se toca aquí -- es propiedad de supabase_auth_admin, no de este proyecto.
revoke all on schema public from public;
grant usage on schema public to atiende_app, authenticated;
`;
}

export interface ExportedMigration {
  filename: string;
  sourceChecksum: string;
  content: string;
}

export function buildExportedMigrations(): ExportedMigration[] {
  const files = readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  return files.map((filename) => {
    const sourceSql = readFileSync(join(SOURCE_DIR, filename), "utf8");
    const sourceChecksum = createHash("sha256").update(sourceSql).digest("hex");
    const body = filename === MIGRACION_AUTH_LOCAL ? transformAuthMigrationForSupabase(sourceSql) : sourceSql;
    const header = `-- ORIGEN: packages/db/migrations/${filename} sha256:${sourceChecksum}\n-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de\n-- nuevo el script tras cambiar la migración fuente.\n\n`;
    return { filename, sourceChecksum, content: header + body };
  });
}

/** Quita comentarios de línea `-- ...` antes de buscar objetos prohibidos: los
 *  encabezados que este propio script antepone (ORIGEN, "OMITIDO respecto al
 *  original: create schema auth...") NOMBRAN a propósito los patrones prohibidos para
 *  explicar la transformación -- sin esto, el check se dispararía contra su propia
 *  documentación en vez de contra SQL ejecutable real. Simplificación deliberada: no
 *  hay literales de cadena con `--` dentro en ninguna migración de este repo. */
function stripSqlLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

export function findProhibitedObjects(content: string): string[] {
  const executable = stripSqlLineComments(content);
  return PROHIBITED_PATTERNS.filter((p) => p.re.test(executable)).map((p) => p.name);
}

function writeExport(): void {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const exported = buildExportedMigrations();
  for (const m of exported) {
    const violations = findProhibitedObjects(m.content);
    if (violations.length > 0) {
      throw new Error(`export-supabase-migrations: "${m.filename}" contiene objetos prohibidos tras transformar: ${violations.join(", ")}`);
    }
    writeFileSync(join(OUTPUT_DIR, m.filename), m.content, "utf8");
  }
  console.log(`export-supabase-migrations: ${exported.length} migración(es) escritas en ${OUTPUT_DIR}`);
}

function checkExport(): boolean {
  if (!existsSync(OUTPUT_DIR)) {
    console.error("export-supabase-migrations --check: supabase/migrations/ no existe todavía. Corre el script sin --check primero.");
    return false;
  }
  const expected = buildExportedMigrations();
  let ok = true;
  for (const m of expected) {
    const outPath = join(OUTPUT_DIR, m.filename);
    if (!existsSync(outPath)) {
      console.error(`export-supabase-migrations --check: falta "${m.filename}" en supabase/migrations/.`);
      ok = false;
      continue;
    }
    const actual = readFileSync(outPath, "utf8");
    if (actual !== m.content) {
      console.error(`export-supabase-migrations --check: "${m.filename}" está desincronizado de packages/db/migrations/ -- vuelve a correr el script sin --check.`);
      ok = false;
    }
  }
  const existingFiles = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".sql")));
  const expectedFiles = new Set(expected.map((m) => m.filename));
  for (const f of existingFiles) {
    if (!expectedFiles.has(f)) {
      console.error(`export-supabase-migrations --check: "${f}" existe en supabase/migrations/ pero ya no tiene fuente en packages/db/migrations/.`);
      ok = false;
    }
  }
  return ok;
}

function main(): void {
  const check = process.argv.includes("--check");
  if (check) {
    const ok = checkExport();
    if (!ok) {
      process.exitCode = 1;
      return;
    }
    console.log("export-supabase-migrations --check: OK (supabase/migrations/ sincronizado).");
    return;
  }
  writeExport();
}

if (process.argv[1] && process.argv[1].endsWith("export-supabase-migrations.ts")) {
  main();
}
