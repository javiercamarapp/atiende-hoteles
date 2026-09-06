#!/usr/bin/env node
// H12b · Verificación LOCAL del adaptador Vercel (Opción a) SIN necesitar credenciales
// de Supabase ni desplegar nada: prueba que `hono/vercel`'s `handle()` (literalmente
// `(req: Request) => app.fetch(req)`) + `createApp()` de `apps/api/src/app.ts` producen
// una `Response` HTTP correcta de punta a punta -- exactamente el mismo cableado que usa
// `deploy/api/vercel/api/[[...route]].ts`, sustituyendo SOLO el motor de base de datos:
// aquí un `embedded-postgres` efímero (mismo patrón que `tests/support/api-fixture.ts`)
// en vez de `openManagedPostgres()` contra Supabase real (que este script nunca toca).
//
// Uso: node --experimental-transform-types deploy/api/vercel/verify-local.ts
// (mismo flag que `apps/api/package.json` usa para `dev`/`start` -- `--experimental-
// strip-types` no basta aquí porque `packages/mcp-servers/payments` usa "parameter
// properties" de TS, que el modo strip-only no soporta).
import { handle } from "hono/vercel";
import { createApp } from "../../../apps/api/src/app.ts";
import { loadEnv } from "../../../apps/api/src/env.ts";
import { rootLogger } from "../../../apps/api/src/logger.ts";
import { RateLimiter } from "../../../apps/api/src/lib/rateLimit.ts";
import { MetricsRegistry } from "../../../apps/api/src/metrics.ts";
import { openEmbeddedPostgres, applyMigrations } from "../../../packages/db/src/index.ts";
import type { AppDeps } from "../../../apps/api/src/types.ts";

async function main() {
  const engine = await openEmbeddedPostgres();
  await applyMigrations(engine.admin);

  const env = loadEnv({ NODE_ENV: "test", JWT_SECRET: "verify-local-not-for-production" } as NodeJS.ProcessEnv);
  const deps: AppDeps = {
    engine,
    env,
    logger: rootLogger,
    ipLimiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
    userLimiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
    metrics: new MetricsRegistry(),
  };

  const app = createApp(deps);
  const handler = handle(app);

  const res = await handler(new Request("http://localhost/health"));
  const body = (await res.json()) as { status: string };

  if (res.status !== 200 || body.status !== "ok") {
    console.error("verify-local (Vercel adapter): FALLÓ -- /health no respondió 200 {status:'ok'}", res.status, body);
    process.exitCode = 1;
  } else {
    console.log("verify-local (Vercel adapter): OK -- hono/vercel handle(app) + createApp() responden /health correctamente.");
  }

  await engine.stop();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
