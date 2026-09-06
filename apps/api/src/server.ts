// H2 · Punto de entrada real del servidor (Node, `@hono/node-server`). NO se usa en
// tests (que inyectan un `EmbeddedPostgresEngine` efímero directamente a `createApp`,
// ver tests/support/api-fixture.ts) -- este archivo arranca el Postgres embebido
// persistente de desarrollo (`bootstrapDevEngine`, ADR-003) y sirve HTTP de verdad.
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { bootstrapDevEngine } from "./db.ts";
import { loadEnv } from "./env.ts";
import { rootLogger } from "./logger.ts";
import { RateLimiter } from "./lib/rateLimit.ts";
import type { AppDeps } from "./types.ts";

async function main() {
  const env = loadEnv();
  const logger = rootLogger;

  logger.info({ port: env.port, nodeEnv: env.nodeEnv }, "arrancando apps/api");

  const engine = await bootstrapDevEngine(env);

  const deps: AppDeps = {
    engine,
    env,
    logger,
    ipLimiter: new RateLimiter({ limit: env.rateLimitPerIpPerMinute, windowMs: 60_000 }),
    userLimiter: new RateLimiter({ limit: env.rateLimitPerUserPerMinute, windowMs: 60_000 }),
  };

  const app = createApp(deps);

  serve({ fetch: app.fetch, port: env.port }, (info) => {
    logger.info({ port: info.port }, "apps/api escuchando");
  });

  const shutdown = async () => {
    logger.info("apagando apps/api");
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
