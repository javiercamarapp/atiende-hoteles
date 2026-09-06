// H2/H8 · ADR-008: logger estructurado (JSON) con request_id/org_id/hotel_id/user_id
// en cada línea. `pino` con nivel configurable; en desarrollo interactivo se puede
// apuntar a `pino-pretty` vía `LOG_PRETTY=1`, nunca en producción (formato JSON
// siempre ahí). `redactPaths`/`createLogger` se separan de `rootLogger` para que las
// pruebas de redacción (tests/unit/api/logger-redact.spec.ts) puedan construir un pino
// real con un destino capturable, sin duplicar la configuración de `redact`.
import pino, { type DestinationStream, type LoggerOptions } from "pino";

// REQ-AGT-006/ADR-008: nunca persistir PII sensible en trazas (contraseñas, tokens,
// datos de identidad/documento de huéspedes). `censor` reemplaza el valor completo,
// nunca lo trunca (un valor truncado sigue siendo PII parcial).
const SENSITIVE_FIELDS = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "jwt",
  "email",
  "telefono",
  "phone",
  "rfc",
  "curp",
  "numeroDocumento",
  "passportNumber",
  "pan",
  "cvv",
];

// Cada campo sensible se redacta tanto en la raíz del objeto logueado como en
// cualquier profundidad de un nivel bajo otra llave (`pino` "paths" no soporta
// comodines recursivos tipo `**`, así que se declaran ambas formas explícitas).
export const REDACT_PATHS = [
  ...SENSITIVE_FIELDS,
  ...SENSITIVE_FIELDS.map((f) => `*.${f}`),
  "req.headers.authorization",
];

export function createLogger(options: Partial<LoggerOptions> = {}, destination?: DestinationStream) {
  const base: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redactado]" },
    transport:
      !destination && process.env.LOG_PRETTY === "1"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    ...options,
  };
  return destination ? pino(base, destination) : pino(base);
}

export const rootLogger = createLogger();

export type Logger = typeof rootLogger;
