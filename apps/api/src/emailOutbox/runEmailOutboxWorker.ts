// H12a · Planificador en proceso del worker de correo por outbox -- MISMO patrón que
// `jobs/nightAuditScheduler.ts`/`jobs/purgeIdentityVaultScheduler.ts` (poll con
// `setInterval`, parada limpia), pero vive en `emailOutbox/` (carpeta NUEVA de este
// agente) en vez de en `jobs/` (lote B, fuera de alcance) para no arriesgar un choque
// de archivo con ese corrector.
//
// PENDIENTE-COORDINACIÓN (documentado también en README de este directorio): arrancar
// este planificador junto a los demás requiere una línea en `apps/api/src/server.ts`
// (lote A, fuera de alcance de este agente) -- mientras tanto:
//   - en producción/desarrollo real, se puede correr como PROCESO INDEPENDIENTE:
//       node --experimental-transform-types apps/api/src/emailOutbox/runEmailOutboxWorker.ts
//     (mismo criterio que `scripts/run-night-audit-scheduler.ts`, un cron del sistema
//     operativo también funcionaría);
//   - en pruebas, se ejercita llamando `drainOutboxOnce()` directo (ver
//     `tests/integration/api/email-outbox-handlers.spec.ts`), sin necesitar este
//     planificador corriendo.
import { drainOutboxOnce } from "../outbox/worker.ts";
import { buildEmailOutboxHandlers } from "./buildEmailOutboxHandlers.ts";
import { bootstrapDevEngine } from "../db.ts";
import { loadEnv } from "../env.ts";
import { rootLogger } from "../logger.ts";
import { FakeEmailAdapter, ResendAdapter, SmtpAdapter, dbEmailOutboxSink } from "@atiende-hoteles/email";
import type { EmailPort } from "@atiende-hoteles/email";
import type { DbClient } from "@atiende-hoteles/db";

const POLL_INTERVAL_MS = 15_000;

function resolveEmailPort(admin: DbClient): EmailPort {
  const resend = new ResendAdapter();
  if (resend.configured) return resend;
  const smtp = new SmtpAdapter();
  if (smtp.configured) return smtp;
  return new FakeEmailAdapter(dbEmailOutboxSink(admin));
}

export function startEmailOutboxScheduler(
  admin: DbClient,
  opts: { onTick?: (result: Awaited<ReturnType<typeof drainOutboxOnce>>) => void; onError?: (err: unknown) => void } = {},
) {
  const emailPort = resolveEmailPort(admin);
  const handlers = buildEmailOutboxHandlers({ db: admin, emailPort });

  const timer = setInterval(() => {
    drainOutboxOnce(admin, { handlers }).then(opts.onTick, opts.onError);
  }, POLL_INTERVAL_MS);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}

async function main() {
  const env = loadEnv();
  const logger = rootLogger;
  const engine = await bootstrapDevEngine(env);

  logger.info("worker de correo por outbox (H12a): arrancando");
  const scheduler = startEmailOutboxScheduler(engine.admin, {
    onTick: (result) => logger.info({ result }, "worker de correo por outbox: tick"),
    onError: (err) => logger.error({ err }, "worker de correo por outbox: error en tick"),
  });

  const shutdown = async () => {
    scheduler.stop();
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
