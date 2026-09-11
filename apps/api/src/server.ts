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
import { bootstrapProductionSecrets } from "./lib/secretsProvider.ts";
import { resolvePaymentPort } from "./lib/resolvePaymentPort.ts";
import { resolveOutboundTaskSyncPort } from "./lib/resolveOutboundTaskSyncPort.ts";
import { MetricsRegistry } from "./metrics.ts";
import type { AppDeps } from "./types.ts";
import { startNightAuditScheduler } from "./jobs/nightAuditScheduler.ts";
import { startIdentityVaultPurgeScheduler } from "./jobs/purgeIdentityVaultScheduler.ts";
import { startConversationPurgeScheduler } from "./jobs/purgeConversationsScheduler.ts";
import { startTicketEscalationScheduler } from "./jobs/ticketEscalationScheduler.ts";
import { startEmailOutboxScheduler, resolveEmailPort } from "./emailOutbox/runEmailOutboxWorker.ts";
import { startPaymentPreauthPurgeScheduler } from "./jobs/purgePaymentPreauthScheduler.ts";
import { startPmsCloudbedsSyncScheduler } from "./jobs/pmsCloudbedsSyncScheduler.ts";
import { startBarReputacionScheduler } from "./jobs/barReputacionScheduler.ts";

async function main() {
  // REQ-SEG-013 · antes de leer cualquier secreto de `process.env`, le da a Vault/KMS
  // la oportunidad de poblarlo (opt-in vía SECRETS_BACKEND=vault -- sin esa variable
  // es un no-op exacto, 0 llamadas de red). `loadEnv()`/`identityEncryption.ts`/etc.
  // siguen leyendo `process.env` sin ningún cambio; no necesitan saber si el valor
  // vino de Vault o de un export de shell.
  const secretsBoot = await bootstrapProductionSecrets();
  const env = loadEnv();
  const logger = rootLogger;

  logger.info(
    { port: env.port, nodeEnv: env.nodeEnv, secretsBackend: secretsBoot.backend, secretsKeysLoaded: secretsBoot.keysLoaded.length },
    "arrancando apps/api",
  );

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

  // Auditoría de producción (2026-09-09): `createApp()` (app.ts) SIEMPRE instanciaba
  // `FakeStripeAdapter` como único default de `payments` -- este archivo (el arranque
  // real) nunca llamaba a nada que resolviera Stripe/Conekta real, así que en producción
  // el cobro a huéspedes corría contra el Fake sin importar qué credenciales existieran.
  // Mismo criterio que `emailPort` arriba: se resuelve aquí, UNA vez, a partir de las
  // variables de entorno del proceso real -- ver `resolvePaymentPort()`.
  const paymentPort = resolvePaymentPort();
  logger.info(
    { provider: paymentPort.status().provider, simulated: paymentPort.status().simulated },
    "adaptador de pagos resuelto",
  );

  // H18 · conector-pms-enterprise: mismo criterio que `paymentPort` arriba -- se
  // resuelve aquí, una vez, a partir de las variables de entorno del proceso real (ver
  // `resolveOutboundTaskSyncPort()`). No hay credencial global que reportar en el log
  // (la credencial es por hotel, ver `hotel_pms_outbound_config`), solo si el mecanismo
  // de envío en sí está activo o apagado por el interruptor operativo.
  const outboundTaskSyncPort = resolveOutboundTaskSyncPort(process.env);
  logger.info(
    { provider: outboundTaskSyncPort.status().provider, simulated: outboundTaskSyncPort.status().simulated },
    "conector outbound pms-enterprise resuelto",
  );

  const deps: AppDeps = {
    engine,
    env,
    logger,
    ipLimiter: new RateLimiter({ limit: env.rateLimitPerIpPerMinute, windowMs: 60_000 }),
    userLimiter: new RateLimiter({ limit: env.rateLimitPerUserPerMinute, windowMs: 60_000 }),
    metrics: new MetricsRegistry(),
    emailPort,
    payments: paymentPort,
    outboundTaskSync: outboundTaskSyncPort,
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

  // REQ-HUE-014 · escalación automática de `guest_ticket` cuyo SLA ya venció (lock por
  // hotel, ver jobs/ticketEscalationScheduler.ts) -- también ejecutable de forma
  // independiente vía `node scripts/run-ticket-escalation-scheduler.ts`. `logger` se
  // inyecta también para la notificación activa (webhook genérico, `lib/
  // ticketAlertDispatch.ts`) del aviso al 75% del SLA y de la escalación al 100% --
  // `alertDestination`/`dispatch` se dejan en su default real (`process.env`,
  // `dispatchTicketAlert`), igual que `routes/fraude.ts` con `resolveFraudAlertDestination()`.
  const ticketEscalationScheduler = startTicketEscalationScheduler(engine.admin, {
    logger,
    onTick: (results) => logger.info({ results }, "escalación de tickets: tick"),
    onError: (err) => logger.error({ err }, "escalación de tickets: error en tick"),
  });

  // H12a · REQ-LAUNCH-043: drena `public.outbox` hacia correos reales (recibo de pago,
  // confirmación de reserva, aviso de CFDI, invitación de staff...) -- mismo `EmailPort`
  // que `deps.emailPort` de arriba (Resend/SMTP/Fake), así que un pago/reserva/CFDI real
  // procesado por esta misma API dispara el correo correspondiente sin depender de un
  // proceso separado (aunque `runEmailOutboxWorker.ts` también puede correr solo, ej.
  // como cron adicional de recuperación).
  const emailOutboxScheduler = startEmailOutboxScheduler(engine.admin, {
    onTick: (result) => logger.info({ result }, "worker de correo por outbox: tick"),
    onError: (err) => logger.error({ err }, "worker de correo por outbox: error en tick"),
  });

  // REQ-SEG-011 · "los tokens de VCC/pre-autorización no utilizados deben
  // purgarse/expirar automáticamente" -- mismo criterio que las purgas de arriba:
  // planificador en proceso, lock por hotel, log + métrica por corrida (ver
  // jobs/purgePaymentPreauthScheduler.ts).
  const paymentPreauthPurgeScheduler = startPaymentPreauthPurgeScheduler(engine.admin, {
    onHotelResult: (hotelId, result) => deps.metrics.incrementPaymentPreauthPurged(hotelId, result.expiredTotal),
    onTick: (results) => logger.info({ results }, "purga de pre-autorizaciones de pago: tick"),
    onError: (err) => logger.error({ err }, "purga de pre-autorizaciones de pago: error en tick"),
  });

  // H15-001/ADR-007 · primer caller real de `@atiende-hoteles/mcp-pms` (auditoria
  // confirmo 0 antes de esto): sincroniza tarifas de Cloudbeds hacia `rate_plan` para
  // cada `room_type.cloudbeds_room_type_id` configurado (migracion 0125). Sin las 4
  // variables OAuth de Cloudbeds en el entorno, cada tick solo registra
  // `status().reason` -- 0 llamadas de red, ver jobs/pmsCloudbedsSyncScheduler.ts.
  const pmsCloudbedsSyncScheduler = startPmsCloudbedsSyncScheduler(engine.admin, {
    onTick: (results) => logger.info({ results }, "sincronizacion de tarifas Cloudbeds: tick"),
    onError: (err) => logger.error({ err }, "sincronizacion de tarifas Cloudbeds: error en tick"),
  });

  // REQ-REV-017 · recomienda un ajuste de BAR cuando el índice de reputación (derivado
  // de `guest_review.sentiment_score`, REQ-CRM-002) sube sobre el umbral en la ventana
  // configurada (ver jobs/barReputacionEvaluator.ts) -- idempotente por diseño de BD
  // (`bar_reputation_recommendation`, 0130), así que un intervalo generoso (1h) no
  // arriesga duplicar recomendaciones si un tick se atrasa.
  const barReputacionScheduler = startBarReputacionScheduler(engine.admin, {
    onTick: (results) => logger.info({ results }, "recomendación de BAR por reputación: tick"),
    onError: (err) => logger.error({ err }, "recomendación de BAR por reputación: error en tick"),
  });

  const shutdown = async () => {
    logger.info("apagando apps/api");
    nightAuditScheduler.stop();
    identityVaultPurgeScheduler.stop();
    conversationPurgeScheduler.stop();
    ticketEscalationScheduler.stop();
    emailOutboxScheduler.stop();
    paymentPreauthPurgeScheduler.stop();
    pmsCloudbedsSyncScheduler.stop();
    barReputacionScheduler.stop();
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
