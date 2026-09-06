// H8 · REQ-QA-007: prueba del análisis ESTÁTICO de `scripts/check-migraciones.ts`
// (expand-only). Corre contra directorios temporales sintéticos -- nunca contra
// `packages/db/migrations` real, para no depender de (ni poder romper) el manifiesto
// base real del repo.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkMigrations, computeChecksums, findDestructiveStatements } from "../../scripts/check-migraciones.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "check-migraciones-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("findDestructiveStatements", () => {
  it("detecta DROP COLUMN/DROP TABLE/TRUNCATE/ALTER COLUMN TYPE", () => {
    expect(findDestructiveStatements("alter table x drop column y;")).toContain("DROP COLUMN");
    expect(findDestructiveStatements("drop table x;")).toContain("DROP TABLE");
    expect(findDestructiveStatements("truncate x;")).toContain("TRUNCATE");
    expect(findDestructiveStatements("alter table x alter column y type int;")).toContain("ALTER COLUMN ... TYPE");
  });

  it("NO marca drop constraint/index/policy/function/trigger como destructivo (expand-migrate legítimo)", () => {
    expect(findDestructiveStatements("alter table x drop constraint x_check;")).toHaveLength(0);
    expect(findDestructiveStatements("drop index if exists x_idx;")).toHaveLength(0);
    expect(findDestructiveStatements("drop policy x on y;")).toHaveLength(0);
    expect(findDestructiveStatements("drop function x();")).toHaveLength(0);
    expect(findDestructiveStatements("drop trigger x on y;")).toHaveLength(0);
  });

  it("un marcador CONTRACT-APPROVED exime al archivo completo", () => {
    const sql = "-- CONTRACT-APPROVED: backfill verificado en docs/logs/backfill-x.log\ndrop table x;";
    expect(findDestructiveStatements(sql)).toHaveLength(0);
  });
});

describe("checkMigrations: falla si una migración ya mergeada cambió de hash", () => {
  it("pasa cuando el contenido coincide con el manifiesto base", () => {
    const migrationsDir = crearDirTemporal();
    writeFileSync(join(migrationsDir, "0001_x.sql"), "create table x (id uuid primary key);\n");
    const checksums = computeChecksums(migrationsDir);
    const baselinePath = join(migrationsDir, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(checksums)));

    const result = checkMigrations(migrationsDir, baselinePath);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("falla cuando el archivo de una migración ya mergeada cambia después", () => {
    const migrationsDir = crearDirTemporal();
    const filePath = join(migrationsDir, "0001_x.sql");
    writeFileSync(filePath, "create table x (id uuid primary key);\n");
    const checksums = computeChecksums(migrationsDir);
    const baselinePath = join(migrationsDir, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(checksums)));

    // Edita la migración "ya mergeada" -- exactamente lo que GOB-011/REQ-QA-007
    // prohíbe.
    writeFileSync(filePath, "create table x (id uuid primary key, extra text);\n");

    const result = checkMigrations(migrationsDir, baselinePath);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("ya fue mergeada con otro contenido");
  });

  it("falla si una migración del manifiesto base fue borrada del directorio", () => {
    const migrationsDir = crearDirTemporal();
    const baselinePath = join(migrationsDir, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ "0001_x.sql": "deadbeef" }));

    const result = checkMigrations(migrationsDir, baselinePath);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("ya no existe");
  });
});

describe("checkMigrations: falla si una migración nueva trae DROP/ALTER destructivo sin aprobar", () => {
  it("una migración NUEVA (no en el manifiesto) con DROP COLUMN sin marcador falla", () => {
    const migrationsDir = crearDirTemporal();
    writeFileSync(join(migrationsDir, "0001_nueva.sql"), "alter table x drop column y;\n");
    const baselinePath = join(migrationsDir, "baseline-vacio.json");
    writeFileSync(baselinePath, "{}");

    const result = checkMigrations(migrationsDir, baselinePath);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("DROP COLUMN");
  });

  it("una migración nueva con DROP COLUMN y el marcador CONTRACT-APPROVED pasa", () => {
    const migrationsDir = crearDirTemporal();
    writeFileSync(
      join(migrationsDir, "0001_nueva.sql"),
      "-- CONTRACT-APPROVED: backfill de 'y' verificado en docs/logs/backfill.log, fase contract\nalter table x drop column y;\n",
    );
    const baselinePath = join(migrationsDir, "baseline-vacio.json");
    writeFileSync(baselinePath, "{}");

    const result = checkMigrations(migrationsDir, baselinePath);
    expect(result.ok).toBe(true);
  });

  it("una migración YA mergeada con DROP destructivo (deuda heredada) genera advertencia, no error bloqueante", () => {
    const migrationsDir = crearDirTemporal();
    const filePath = join(migrationsDir, "0001_x.sql");
    writeFileSync(filePath, "drop table viejo;\n");
    const checksums = computeChecksums(migrationsDir);
    const baselinePath = join(migrationsDir, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(checksums)));

    const result = checkMigrations(migrationsDir, baselinePath);
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
