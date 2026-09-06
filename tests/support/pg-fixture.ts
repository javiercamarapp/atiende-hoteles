// Fixture compartido para tests/integration: arranca un `embedded-postgres` real
// (Postgres 18.4, ADR-003) con datadir/puerto efimeros, aplica migraciones y siembra.
// Cada test file debe abrir/cerrar su propia instancia (ver singleFork en
// vitest.config para evitar colisiones de puerto entre archivos).

import { applyMigrations, openEmbeddedPostgres, seedDev, type EmbeddedPostgresEngine, type SeedResult } from "@atiende-hoteles/db";

export interface PgFixture {
  engine: EmbeddedPostgresEngine;
  seed: SeedResult;
}

export async function createPgFixture(): Promise<PgFixture> {
  const engine = await openEmbeddedPostgres();
  await applyMigrations(engine.admin);
  const seed = await seedDev(engine.admin);
  return { engine, seed };
}

export async function destroyPgFixture(fixture: PgFixture): Promise<void> {
  await fixture.engine.stop();
}
