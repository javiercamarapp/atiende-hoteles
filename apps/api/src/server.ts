// H2 · Punto de entrada real del servidor (Node, `@hono/node-server`). NO se usa en
// tests (que inyectan un `EmbeddedPostgresEngine` efímero directamente a `createApp`,
// ver tests/support/api-fixture.ts) -- este archivo arranca el Postgres embebido
// persistente de desarrollo (`bootstrapDevEngine`, ADR-003) y sirve HTTP de verdad.
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { bootstrapDevEngine } from "./db.ts";
import { bootstrapProductionEngine, readProductionDbConfig } from "./dbProduction.ts";
import { loadEnv } from "./env.ts";
import { rootLogger } from "./logger.ts";
import { RateLimiter } from "./lib/rateLimit.ts";
import { MetricsRegistry } from "./metrics.ts";
import type { AppDeps } from "./types.ts";
import { startNightAuditScheduler } from "./jobs/nightAuditScheduler.ts";
import { startIdentityVaultPurgeScheduler } from "./jobs/purgeIdentityVaultScheduler.ts";
import { startConversationPurgeScheduler } from "./jobs/purgeConversationsScheduler.ts";
import { startEmailOutboxScheduler, resolveEmailPort } from "./emailOutbox/runEmailOutboxWorker.ts";

async function main() {
  const env = loadEnv();
  const logger = rootLogger;

  logger.info({ port: env.port, nodeEnv: env.nodeEnv }, "arrancando apps/api");

  // H12b · LAUNCH-009/D-006: `SUPABASE_DB_HOST`/`SUPABASE_DB_PASSWORD_APP` presentes ->
  // motor de producción contra Postgres gestionado (nunca arranca un servidor propio,
  // nunca aplica migraciones -- ver dbProduction.ts). Sin esas variables (el caso de
  // desarrollo/CI de hoy) se mantiene exactamente el comportamiento anterior
  // (`bootstrapDevEngine`, embedded-postgres persistente, ADR-003). En
  // `NODE_ENV=production` sin esas variables, falla explícito -- nunca arranca un
  // Postgres embebido "por accidente" en un despliegue real (ADR-003 "producción sigue
  // siendo Supabase", nunca embedded-postgres).
  const productionDbConfig = readProductionDbConfig(process.env);
  if (env.nodeEnv === "production" && !productionDbConfig) {
    throw new Error(
      "NODE_ENV=production sin SUPABASE_DB_HOST/SUPABASE_DB_PASSWORD_APP -- ver deploy/env-matrix.md. " +
        "apps/api nunca arranca un Postgres embebido en producción (ADR-003).",
    );
  }
  const engine = productionDbConfig ? bootstrapProductionEngine(productionDbConfig) : await bootstrapDevEngine(env);

  // H12a/H12b pendiente-coordinación cerrada por el integrador: `EmailPort` real
  // (Resend > SMTP > `FakeEmailAdapter` sobre `email_outbox`, ver
  // emailOutbox/runEmailOutboxWorker.ts) para que `routes/registro.ts`/`routes/correo.ts`
  // envíen correos de verdad en cuanto existan credenciales, en vez de depender siempre
  // del default de `createApp()` (que nunca ve las variables de entorno del proceso).
  const emailPort = resolveEmailPort(engine.admin);

  const deps: AppDeps = {
    engine,
    env,
    logger,
    ipLimiter: new RateLimiter({ limit: env.rateLimitPerIpPerMinute, windowMs: 60_000 }),
    userLimiter: new RateLimiter({ limit: env.rateLimitPerUserPerMinute, windowMs: 60_000 }),
    metrics: new MetricsRegistry(),
    emailPort,
  };

  const app = createApp(deps);

  serve({ fetch: app.fetch, port: env.port }, (info) => {
    logger.info({ port: info.port }, "apps/api escuchando");
  });

  // REQ-REV-013 · planificador en proceso del night audit (lock por hotel +
  // idempotencia real vía night_audit_claim, ver jobs/nightAuditScheduler.ts) --
  // también ejecutable de forma independiente vía
  // `node scripts/run-night-audit-scheduler.ts` (cron del sistema operativo).
  const nightAuditScheduler = startNightAuditScheduler(engine.admin, {
    onTick: (results) => logger.info({ results }, "night audit scheduler: tick"),
    onError: (err) => logger.error({ err }, "night audit scheduler: error en tick"),
  });

  // auditoria-2/legal [CRITICO] "la purga de la bóveda de identidad existe y está
  // probada, pero no corre en ningún proceso real": mismo criterio que el night audit
  // de arriba -- planificador en proceso, lock por hotel, log + métrica por corrida.
  const identityVaultPurgeScheduler = startIdentityVaultPurgeScheduler(engine.admin, {
    onHotelResult: (hotelId, result) => deps.metrics.incrementIdentityVaultPurged(hotelId, result.deletedTotal),
    onTick: (results) => logger.info({ results }, "purga de bóveda de identidad: tick"),
    onError: (err) => logger.error({ err }, "purga de bóveda de identidad: error en tick"),
  });

  // auditoria-2/legal [ALTO] "retención configurable por hotel para
  // conversation/message con purga programada".
  const conversationPurgeScheduler = startConversationPurgeScheduler(engine.admin, {
    onHotelResult: (hotelId, result) => deps.metrics.incrementConversationsPurged(hotelId, result.deletedConversations),
    onTick: (results) => logger.info({ results }, "purga de conversaciones: tick"),
    onError: (err) => logger.error({ err }, "purga de conversaciones: error en tick"),
  });

  // H12a · REQ-LAUNCH-013: drena `public.outbox` hacia correos reales (recibo de pago,
  // confirmación de reserva, aviso de CFDI, invitación de staff...) -- mismo `EmailPort`
  // que `deps.emailPort` de arriba (Resend/SMTP/Fake), así que un pago/reserva/CFDI real
  // procesado por esta misma API dispara el correo correspondiente sin depender de un
  // proceso separado (aunque `runEmailOutboxWorker.ts` también puede correr solo, ej.
  // como cron adicional de recuperación).
  const emailOutboxScheduler = startEmailOutboxScheduler(engine.admin, {
    onTick: (result) => logger.info({ result }, "worker de correo por outbox: tick"),
    onError: (err) => logger.error({ err }, "worker de correo por outbox: error en tick"),
  });

  const shutdown = async () => {
    logger.info("apagando apps/api");
    nightAuditScheduler.stop();
    identityVaultPurgeScheduler.stop();
    conversationPurgeScheduler.stop();
    emailOutboxScheduler.stop();
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
