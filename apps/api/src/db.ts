// H2 · Arranque de base de datos para el servidor real (dev/local, ADR-003):
// `embedded-postgres` persistente (mismo mecanismo que `packages/db/src/cli.ts`, ahora
// factorizado en `openEmbeddedPostgres({ persistent, databaseDir, port })`), con
// migraciones aplicadas y datos de desarrollo sembrados automáticamente al arrancar SI
// la base está vacía. Los tests de integración/adversarial NO usan este módulo: crean
// su propio `EmbeddedPostgresEngine` efímero (ver tests/support/pg-fixture.ts) e
// inyectan el `AppDeps` directamente a `createApp()`.
import { applyMigrations, openEmbeddedPostgres, seedDev, type EmbeddedPostgresEngine } from "@atiende-hoteles/db";
import type { AppEnv } from "./env.ts";

export async function bootstrapDevEngine(
  env: AppEnv,
  // auditoria-2/operabilidad [ALTO]: `packages/db` ya no descarta silenciosamente los
  // eventos `pool.on("error")` (ver engines.ts) -- siempre cuenta y loguea una línea
  // JSON mínima por su cuenta, pero quien arranca el proceso real puede inyectar aquí
  // su logger/métricas reales (pino + MetricsRegistry, ver server.ts) para que el
  // evento llegue con el mismo formato/canal que el resto de los logs estructurados
  // del proceso, no una línea aparte a stderr sin correlación.
  onPoolError?: (err: unknown) => void,
): Promise<EmbeddedPostgresEngine> {
  const engine = await openEmbeddedPostgres({
    databaseDir: env.dbDataDir,
    port: env.dbPort,
    persistent: true,
    onPoolError,
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
