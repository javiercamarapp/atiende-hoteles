// REQ-GOB-010: migraciones expand-only, aplicadas desde cero e idempotentes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, dropAllMigratedObjects, openPglite, type PgliteEngine } from "@atiende-hoteles/db";

describe("runner de migraciones (PGlite)", () => {
  let engine: PgliteEngine;

  beforeEach(async () => {
    engine = await openPglite();
  });

  afterEach(async () => {
    await engine.close();
  });

  it("aplica todas las migraciones desde una base vacia", async () => {
    const result = await applyMigrations(engine.admin);
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);

    const { rows } = await engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.schema_migrations;",
    );
    expect(Number(rows[0]!.count)).toBe(result.applied.length);
  });

  it("es idempotente: correrlo dos veces no reaplica nada la segunda vez", async () => {
    const first = await applyMigrations(engine.admin);
    const second = await applyMigrations(engine.admin);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);
  });

  it("rechaza continuar si una migracion ya aplicada fue editada (expand-only)", async () => {
    await applyMigrations(engine.admin);
    await engine.admin.query(
      "update public.schema_migrations set checksum = 'tampered' where filename = '0001_extensions_and_auth.sql';",
    );

    await expect(applyMigrations(engine.admin)).rejects.toThrow(/migracion_modificada/);
  });

  it("db:reset (dropAllMigratedObjects) deja la base lista para re-aplicar desde cero", async () => {
    await applyMigrations(engine.admin);
    await dropAllMigratedObjects(engine.admin);

    const result = await applyMigrations(engine.admin);
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
  });
});
