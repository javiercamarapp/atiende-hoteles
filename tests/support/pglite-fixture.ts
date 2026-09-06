// Fixture compartido para tests/unit: abre PGlite, aplica todas las migraciones desde
// cero y siembra los datos de desarrollo, para que cada spec arranque de un estado
// conocido sin tener que repetir el boilerplate.

import { applyMigrations, openPglite, seedDev, type PgliteEngine, type SeedResult } from "@atiende-hoteles/db";

export interface PgliteFixture {
  engine: PgliteEngine;
  seed: SeedResult;
}

export async function createPgliteFixture(): Promise<PgliteFixture> {
  const engine = await openPglite();
  await applyMigrations(engine.admin);
  const seed = await seedDev(engine.admin);
  return { engine, seed };
}

export async function destroyPgliteFixture(fixture: PgliteFixture): Promise<void> {
  await fixture.engine.close();
}
