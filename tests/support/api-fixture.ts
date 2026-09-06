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

export async function createApiFixture(options: { poolMax?: number } = {}): Promise<ApiFixture> {
  const engine = await openEmbeddedPostgres({ poolMax: options.poolMax });
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

/** H5 · crea una reserva y la confirma (lo que crea su folio principal, ver
 *  routes/reservas.ts) EXCLUSIVAMENTE por la API real -- devuelve `folioId`, nunca
 *  usa el cliente admin para insertar el folio (mismo principio que
 *  tests/integration/reservas/folio-al-confirmar.spec.ts). */
export async function crearFolioConfirmado(
  app: Hono<HonoEnvBindings>,
  token: string,
  hotelId: string,
  params: { roomTypeId: string; checkInDate: string; checkOutDate: string },
): Promise<{ reservationId: string; folioId: string }> {
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const created = await app.request(`/hoteles/${hotelId}/reservas`, {
    method: "POST",
    headers: { ...auth, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(params),
  });
  if (created.status !== 201) throw new Error(`no se pudo crear la reserva: ${created.status} ${await created.text()}`);
  const { id: reservationId } = (await created.json()) as { id: string };

  const confirmed = await app.request(`/hoteles/${hotelId}/reservas/${reservationId}/transicion`, {
    method: "PATCH",
    headers: auth,
    body: JSON.stringify({ toStatus: "confirmada" }),
  });
  if (confirmed.status !== 200) throw new Error(`no se pudo confirmar la reserva: ${confirmed.status} ${await confirmed.text()}`);
  const { folioId } = (await confirmed.json()) as { folioId: string };

  return { reservationId, folioId };
}
