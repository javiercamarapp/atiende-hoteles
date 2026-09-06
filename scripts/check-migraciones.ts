#!/usr/bin/env node
// H8 · REQ-QA-007/REQ-GOB-010 (ADR-008 "migraciones reversibles: expand-only"):
// análisis ESTÁTICO (sin BD) de `packages/db/migrations/*.sql` que falla si:
//   (a) una migración YA MERGEADA (presente en el manifiesto base
//       `scripts/checks/migraciones-checksums.json`) cambió de contenido/hash, o
//   (b) CUALQUIER migración (mergeada o nueva) contiene un `DROP COLUMN`/`DROP TABLE`/
//       `TRUNCATE`/`ALTER COLUMN ... TYPE` sin un marcador explícito
//       `-- CONTRACT-APPROVED: <justificación>` en el mismo archivo (fase "contract"
//       de expand→migrate→contract, aprobada a mano por quien la escribe), o
//   (c) auditoria-2/arquitectura [MEDIO]: DOS archivos distintos reclaman el MISMO
//       prefijo numérico (ej. "0027_add_x.sql" y "0027_add_y.sql") -- la asignación de
//       rangos por agente/hito (docs/PROGRESO.md) es una convención de PROCESO, no una
//       regla verificable por máquina: si dos líneas de trabajo en paralelo (worktrees
//       distintos, como esta misma ronda de corrección con lotes A/B/C) reclaman
//       rangos que terminan solapando un mismo número al fusionar a `main`,
//       `packages/db/src/runner.ts` los aplicaría igual, en el orden alfabético
//       COMPLETO del nombre de archivo (no en el orden que cada línea de trabajo
//       asumió), pudiendo referenciar una columna/función que la migración "hermana"
//       del mismo número todavía no creó.
//
// Complementa (no reemplaza) la protección en runtime que ya existe en
// `packages/db/src/runner.ts` (`applyMigrations` lanza `migracion_modificada` si el
// checksum de una migración ya aplicada cambió) -- este script corre SIN necesitar una
// base de datos, apto para un job de CI que falla rápido antes de `npm test`.
//
// Uso:
//   node --experimental-strip-types scripts/check-migraciones.ts          # valida
//   node --experimental-strip-types scripts/check-migraciones.ts --write  # regenera
//     el manifiesto base con el estado ACTUAL (usar solo tras revisar a mano que los
//     cambios son legítimos -- nunca en CI).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "packages", "db", "migrations");
export const BASELINE_PATH = join(here, "checks", "migraciones-checksums.json");

export interface CheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// Patrones destructivos: pérdida de datos posible. "drop constraint"/"drop index"/
// "drop policy"/"drop function"/"drop trigger" quedan FUERA a propósito: son operaciones
// de esquema seguras (no pierden filas/datos de columnas) y muy comunes en el patrón
// expand-migrate-contract legítimo (ej. redefinir un constraint).
const DESTRUCTIVE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "DROP COLUMN", re: /\bdrop\s+column\b/i },
  { name: "DROP TABLE", re: /\bdrop\s+table\b/i },
  { name: "TRUNCATE", re: /\btruncate\b/i },
  { name: "ALTER COLUMN ... TYPE", re: /\balter\s+column\s+\S+\s+type\b/i },
];
const APPROVAL_MARKER = /--\s*CONTRACT-APPROVED:\s*\S.+/i;

export function computeChecksums(migrationsDir: string): Map<string, string> {
  if (!existsSync(migrationsDir)) return new Map();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const out = new Map<string, string>();
  for (const filename of files) {
    const sql = readFileSync(join(migrationsDir, filename), "utf8");
    out.set(filename, createHash("sha256").update(sql).digest("hex"));
  }
  return out;
}

export function loadBaseline(baselinePath: string): Record<string, string> {
  if (!existsSync(baselinePath)) return {};
  return JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, string>;
}

export function findDestructiveStatements(sql: string): string[] {
  if (APPROVAL_MARKER.test(sql)) return [];
  return DESTRUCTIVE_PATTERNS.filter((p) => p.re.test(sql)).map((p) => p.name);
}

const NUMBER_PREFIX_RE = /^(\d+)_/;

/** auditoria-2/arquitectura [MEDIO]: agrupa nombres de archivo por su prefijo numérico
 *  (`"0027_x.sql"` -> `"0027"`) y devuelve los grupos con MÁS de un archivo -- dos
 *  migraciones distintas reclamando el mismo número, el escenario exacto que el
 *  hallazgo describe (dos líneas de trabajo en paralelo, mismo rango). Archivos sin
 *  prefijo numérico reconocible se ignoran aquí (no es este check el que decide el
 *  formato de nombre válido). */
export function findDuplicateNumberPrefixes(filenames: string[]): string[][] {
  const byPrefix = new Map<string, string[]>();
  for (const filename of filenames) {
    const match = NUMBER_PREFIX_RE.exec(filename);
    if (!match) continue;
    const prefix = match[1]!;
    const group = byPrefix.get(prefix) ?? [];
    group.push(filename);
    byPrefix.set(prefix, group);
  }
  return [...byPrefix.values()].filter((group) => group.length > 1).map((group) => group.sort());
}

export function checkMigrations(migrationsDir: string, baselinePath: string): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const current = computeChecksums(migrationsDir);
  const baseline = loadBaseline(baselinePath);

  for (const [filename, baselineChecksum] of Object.entries(baseline)) {
    const currentChecksum = current.get(filename);
    if (currentChecksum === undefined) {
      errors.push(
        `"${filename}" está en el manifiesto base (ya mergeada) pero ya no existe en el directorio de migraciones -- una migración mergeada nunca se borra.`,
      );
      continue;
    }
    if (currentChecksum !== baselineChecksum) {
      errors.push(
        `"${filename}" ya fue mergeada con otro contenido (checksum cambió de ${baselineChecksum.slice(0, 12)}… a ${currentChecksum.slice(0, 12)}…). ` +
          "Patrón expand-only (REQ-GOB-010): nunca se edita una migración ya mergeada, crea una migración nueva.",
      );
    }
  }

  for (const [filename] of current) {
    const sql = readFileSync(join(migrationsDir, filename), "utf8");
    const destructivas = findDestructiveStatements(sql);
    if (destructivas.length > 0) {
      const esNueva = !(filename in baseline);
      const mensaje = `"${filename}" contiene ${destructivas.join(", ")} sin marcador "-- CONTRACT-APPROVED: <justificación>". Fase "contract" requiere aprobación explícita y backfill previo verificado.`;
      if (esNueva) errors.push(mensaje);
      else warnings.push(`(migración ya mergeada) ${mensaje}`);
    }
  }

  const duplicados = findDuplicateNumberPrefixes([...current.keys()]);
  for (const grupo of duplicados) {
    errors.push(
      `${grupo.length} migraciones distintas reclaman el mismo prefijo numérico: ${grupo.join(", ")} -- ` +
        "dos líneas de trabajo en paralelo asignaron el mismo número; renumera una de las dos antes de fusionar a main " +
        "(packages/db/src/runner.ts las aplicaría en orden alfabético completo del nombre, no en el orden que cada línea asumió).",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

function writeBaseline(migrationsDir: string, baselinePath: string): void {
  const current = computeChecksums(migrationsDir);
  mkdirSync(dirname(baselinePath), { recursive: true });
  const obj = Object.fromEntries([...current.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
  console.log(`Manifiesto base escrito con ${current.size} migración(es): ${baselinePath}`);
}

async function main() {
  const write = process.argv.includes("--write");
  if (write) {
    writeBaseline(MIGRATIONS_DIR, BASELINE_PATH);
    return;
  }

  const result = checkMigrations(MIGRATIONS_DIR, BASELINE_PATH);
  for (const w of result.warnings) console.warn(`[advertencia] ${w}`);
  if (!result.ok) {
    console.error("check-migraciones: FALLÓ (REQ-QA-007, expand-only)\n");
    for (const e of result.errors) console.error(` - ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check-migraciones: OK (${computeChecksums(MIGRATIONS_DIR).size} migración(es) verificadas contra el manifiesto base, 0 DROP/ALTER destructivo sin aprobar).`);
}

// Solo ejecuta `main()` si el archivo se invocó directamente (permite importar las
// funciones desde el test unitario sin correr el CLI).
if (process.argv[1] && process.argv[1].endsWith("check-migraciones.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
