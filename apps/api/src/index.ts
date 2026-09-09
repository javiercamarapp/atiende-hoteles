export { createApp } from "./app.ts";
export { bootstrapDevEngine } from "./db.ts";
export { loadEnv, type AppEnv } from "./env.ts";
export { rootLogger, createLogger, REDACT_PATHS, type Logger } from "./logger.ts";
export { RateLimiter, MemoryRateLimitStore, type RateLimitStore } from "./lib/rateLimit.ts";
// REQ-HUE-023: expuesto para que las pruebas puedan espiar (`vi.spyOn`) el envío real
// de OTP de cambio de contacto -- sigue siendo la MISMA instancia compartida por
// proceso que usan todas las rutas (mensajeria.ts, agentes.ts, huespedes.ts,
// aprobaciones*.ts, ver comentario de cabecera de ese archivo), nunca una segunda
// instancia paralela.
export { sharedWhatsappAdapter } from "./lib/messaging.ts";
export { MetricsRegistry } from "./metrics.ts";
export { drainOutboxOnce, computeBackoffMs, type OutboxHandler, type OutboxRow } from "./outbox/worker.ts";
export type { AppDeps, Variables, HonoEnvBindings } from "./types.ts";
export {
  HOTEL_ROLES,
  MONEY_ROLES,
  MANAGE_INVENTORY_ROLES,
  MANAGE_RESERVATIONS_ROLES,
  MANAGE_ROOM_STATUS_ROLES,
  ADMIN_ROLES,
  type HotelRole,
} from "./domain/roles.ts";
