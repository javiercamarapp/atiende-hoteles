// H12a · Variante de tests/support/api-fixture.ts (que NO se toca aquí -- es
// infraestructura compartida con los otros dos correctores en paralelo, ver
// instrucciones de la tarea) con dos diferencias necesarias para las pruebas de
// Google OAuth/registro/correo:
//   1. Acepta overrides de variables de entorno (para apuntar `GOOGLE_*` al servidor
//      OAuth falso de tests/support/fakeGoogleOAuth.ts en vez de a Google real).
//   2. Expone el `EmailPort` resuelto (un `FakeEmailAdapter` respaldado por
//      `email_outbox`) para que las pruebas puedan leer "el correo que se habría
//      enviado" sin golpear ningún proveedor real.
import { createApp, loadEnv, MetricsRegistry, RateLimiter, type AppDeps, type HonoEnvBindings } from "@atiende-hoteles/api";
import { FakeEmailAdapter, dbEmailOutboxSink } from "@atiende-hoteles/email";
import pino from "pino";
import { openEmbeddedPostgres, applyMigrations, seedDev, type EmbeddedPostgresEngine, type SeedResult } from "@atiende-hoteles/db";
import type { Hono } from "hono";

export interface ApiFixtureH12a {
  engine: EmbeddedPostgresEngine;
  seed: SeedResult;
  app: Hono<HonoEnvBindings>;
  deps: AppDeps;
  emailAdapter: FakeEmailAdapter;
}

export async function createApiFixtureH12a(envOverrides: Record<string, string> = {}): Promise<ApiFixtureH12a> {
  const engine = await openEmbeddedPostgres();
  await applyMigrations(engine.admin);
  const seed = await seedDev(engine.admin);

  const env = loadEnv({
    NODE_ENV: "test",
    JWT_SECRET: "test-secret-not-for-production",
    ...envOverrides,
  } as NodeJS.ProcessEnv);

  const emailAdapter = new FakeEmailAdapter(dbEmailOutboxSink(engine.admin));

  const deps: AppDeps = {
    engine,
    env,
    logger: pino({ level: "silent" }),
    ipLimiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
    userLimiter: new RateLimiter({ limit: 1000, windowMs: 60_000 }),
    metrics: new MetricsRegistry(),
    emailPort: emailAdapter,
  };

  const app = createApp(deps);
  return { engine, seed, app, deps, emailAdapter };
}

export async function destroyApiFixtureH12a(fixture: ApiFixtureH12a): Promise<void> {
  await fixture.engine.stop();
}

export interface EmailOutboxRow {
  id: string;
  template: string;
  to_email: string;
  subject: string;
  html: string;
  text_body: string;
  dedupe_key: string | null;
}

/** Lee lo último enviado a `toEmail` (opcionalmente filtrado por `template`) desde
 *  `email_outbox` -- lo que usan las pruebas para verificar el contenido del correo sin
 *  depender de ningún proveedor real. */
export async function ultimoCorreoPara(engine: EmbeddedPostgresEngine, toEmail: string, template?: string): Promise<EmailOutboxRow | null> {
  const { rows } = await engine.admin.query<EmailOutboxRow>(
    `select id, template, to_email, subject, html, text_body, dedupe_key
     from public.email_outbox
     where to_email = $1 ${template ? "and template = $2" : ""}
     order by created_at desc
     limit 1;`,
    template ? [toEmail, template] : [toEmail],
  );
  return rows[0] ?? null;
}
