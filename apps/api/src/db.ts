// H2 · Arranque de base de datos para el servidor real (dev/local, ADR-003):
// `embedded-postgres` persistente (mismo mecanismo que `packages/db/src/cli.ts`, ahora
// factorizado en `openEmbeddedPostgres({ persistent, databaseDir, port })`), con
// migraciones aplicadas y datos de desarrollo sembrados automáticamente al arrancar SI
// la base está vacía. Los tests de integración/adversarial NO usan este módulo: crean
// su propio `EmbeddedPostgresEngine` efímero (ver tests/support/pg-fixture.ts) e
// inyectan el `AppDeps` directamente a `createApp()`.
import { applyMigrations, openEmbeddedPostgres, seedDev, type EmbeddedPostgresEngine } from "@atiende-hoteles/db";
import type { AppEnv } from "./env.ts";

export async function bootstrapDevEngine(env: AppEnv): Promise<EmbeddedPostgresEngine> {
  const engine = await openEmbeddedPostgres({
    databaseDir: env.dbDataDir,
    port: env.dbPort,
    persistent: true,
  });

  await applyMigrations(engine.admin);

  const { rows: existing } = await engine.admin.query<{ count: string }>(
    "select count(*)::text as count from public.org;",
  );
  if (Number(existing[0]?.count ?? "0") === 0) {
    await seedDev(engine.admin);
  }

  return engine;
}
