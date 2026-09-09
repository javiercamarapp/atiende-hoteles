// H12c · Utilidades mínimas compartidas por este paquete. Deliberadamente NO depende de
// `@atiende-hoteles/mcp-shared` (que usa `node:crypto`, apto solo para el backend):
// `packages/analytics` se importa tanto desde `apps/api` (Node) como desde `apps/web`
// (navegador vía Vite) y no puede arrastrar una dependencia server-only al bundle del
// panel -- mismo motivo por el que `packages/mcp-servers/billing` duplicó
// `stripeSignedPayload` en vez de importarlo de `mcp-payments`.

export interface AdapterStatus {
  provider: string;
  available: boolean;
  simulated: boolean;
  reason?: string;
}

/** Lanzado cuando un adaptador real no tiene credenciales configuradas -- nunca se
 *  "resuelve" silenciosamente enviando el evento a ningún lado. */
export class AnalyticsPortUnavailableError extends Error {
  readonly code = "analytics_port_unavailable";
  constructor(
    readonly provider: string,
    reason: string,
  ) {
    super(`${provider}: ${reason}`);
    this.name = "AnalyticsPortUnavailableError";
  }
}

/** Lanzado cuando `track()`/`captureException()` recibe una propiedad con PII aparente
 *  -- fail-closed: el evento NUNCA se envía (ver `containsLikelyPii`). Cubre la prueba
 *  adversarial "sin PII en eventos de analítica" (tests/adversarial/analytics-sin-pii). */
export class AnalyticsPiiError extends Error {
  readonly code = "analytics_pii_detected";
  constructor(readonly field: string) {
    super(`la propiedad "${field}" contiene un patrón de PII aparente y fue bloqueada antes de enviarse`);
    this.name = "AnalyticsPiiError";
  }
}

// Patrones representativos (no validadores oficiales) -- mismo criterio conservador que
// `packages/agent-core/src/redact.ts` ("prefiere sobre-bloquear antes que dejar pasar un
// dato personal"), duplicado aquí en una versión mínima porque agent-core es un paquete
// server-only (SDK de Anthropic, colas de aprobación) que no debe llegar al bundle web.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_MX_RE = /(?:\+?52[\s.-]?)?(?:01[\s.-]?)?\(?\d{2,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}\b/;
const S = "[ -]?";
const CURP_RE = new RegExp(`[A-Z]{4}${S}\\d{6}${S}[HM]${S}[A-Z]{2}${S}[A-Z]{3}${S}[A-Z0-9]${S}\\d`);
const RFC_RE = new RegExp(`[A-Z&Ñ]{3,4}${S}\\d{6}${S}[A-Z0-9]{3}`);
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/;

const PII_PATTERNS = [EMAIL_RE, PHONE_MX_RE, CURP_RE, RFC_RE, CARD_RE];

/** Recorre cualquier valor serializable buscando un patrón de PII aparente en alguna
 *  cadena. Usado por `track()`/`captureException()` de los adaptadores de este paquete
 *  ANTES de reenviar nada a PostHog/Sentry -- si encuentra algo, el llamador debe
 *  bloquear el envío completo (fail-closed), no solo redactar el campo. */
export function containsLikelyPii(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return PII_PATTERNS.some((re) => re.test(value));
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((v) => containsLikelyPii(v));
}

/** Nombres de propiedad que NUNCA deben aparecer en un evento de analítica, sin importar
 *  su valor -- lista blanca invertida como segunda capa (defensa en profundidad además
 *  del escaneo de contenido de `containsLikelyPii`). */
export const DENYLISTED_PROPERTY_KEYS = [
  "email",
  "correo",
  "telefono",
  "phone",
  "curp",
  "rfc",
  "nombre_completo",
  "full_name",
  "passport",
  "pasaporte",
  "tarjeta",
  "card_number",
  "direccion",
  "address",
];

export function hasDenylistedKey(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) return undefined;
  const key = Object.keys(properties).find((k) => DENYLISTED_PROPERTY_KEYS.includes(k.toLowerCase()));
  return key;
}
