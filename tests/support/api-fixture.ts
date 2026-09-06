// Fixture compartido para tests/integration/api y tests/adversarial: arranca un
// `embedded-postgres` real (mismo fixture que tests/support/pg-fixture.ts) y monta la
// app Hono real de apps/api encima, sin abrir un socket HTTP (Hono `app.request()`
// corre el mismo pipeline de middlewares/handlers en proceso). Cada test file abre y
// cierra su propia instancia.
import { createApp, loadEnv, MetricsRegistry, RateLimiter, type AppDeps } from "@atiende-hoteles/api";
import pino from "pino";
import { openEmbeddedPostgres, applyMigrations, seedDev, DEV_SEED_PASSWORD, type EmbeddedPostgresEngine, type SeedResult } from "@atiende-hoteles/db";
import type { Hono } from "hono";
import type { HonoEnvBindings } from "@atiende-hoteles/api";

export interface ApiFixture {
  engine: EmbeddedPostgresEngine;
  seed: SeedResult;
  app: Hono<HonoEnvBindings>;
  deps: AppDeps;
}

export async function createApiFixture(): Promise<ApiFixture> {
  const engine = await openEmbeddedPostgres();
  await applyMigrations(engine.admin);
  const seed = await seedDev(engine.admin);

  const env = loadEnv({ NODE_ENV: "test", JWT_SECRET: "test-secret-not-for-production" } as NodeJS.ProcessEnv);
  const deps: AppDeps = {
    engine,
    env,
    logger: pino({ level: "silent" }),
    ipLimiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
    userLimiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
    metrics: new MetricsRegistry(),
  };

  const app = createApp(deps);
  return { engine, seed, app, deps };
}

export async function destroyApiFixture(fixture: ApiFixture): Promise<void> {
  await fixture.engine.stop();
}

/** Inicia sesión con un email sembrado por `seedDev` y la contraseña de desarrollo
 *  compartida (`DEV_SEED_PASSWORD`), devolviendo el `token` para usar en
 *  `Authorization: Bearer`. */
export async function loginAs(app: Hono<HonoEnvBindings>, email: string, password: string = DEV_SEED_PASSWORD): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`login fallido para ${email}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}
