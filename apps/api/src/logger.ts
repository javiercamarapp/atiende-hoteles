// H2 · ADR-008: logger estructurado (JSON) con request_id/org_id/hotel_id/user_id en
// cada línea. `pino` con nivel configurable; en desarrollo interactivo se puede apuntar
// a `pino-pretty` vía `LOG_PRETTY=1`, nunca en producción (formato JSON siempre ahí).
import pino from "pino";

export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    // REQ-AGT-006/ADR-008: nunca persistir PII sensible en trazas (contraseñas, tokens).
    paths: ["password", "req.headers.authorization", "*.password", "*.token"],
    censor: "[redactado]",
  },
  transport:
    process.env.LOG_PRETTY === "1"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export type Logger = typeof rootLogger;
