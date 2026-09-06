/**
 * Errores tipados compartidos por todos los puertos de packages/mcp-servers/*.
 *
 * Ver docs/ARQUITECTURA.md ADR-007/ADR-011: un adaptador real sin credenciales/hardware
 * nunca devuelve datos inventados -- se declara `unavailable` lanzando
 * `PortUnavailableError` con la razón explícita. Estos tipos permiten que las pruebas
 * de contrato distingan "el adaptador no puede responder honestamente" de "el proveedor
 * respondió con un error de negocio".
 *
 * H6b: todos los constructores usan campos explícitos, NUNCA el azúcar de TypeScript
 * "parameter properties" (`constructor(readonly x: T)`) -- ese azúcar no está soportado
 * por el modo de solo "strip types" de Node (`node --experimental-strip-types`, que
 * BORRA la sintaxis de tipos sin transformarla): con el azúcar, cargar este módulo en
 * tiempo de ejecución tumbaba el proceso completo con
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` en cuanto apps/api empezó a depender de un
 * adaptador de packages/mcp-servers (H6b conecta WhatsApp por primera vez a runtime).
 *
 * auditoria-2/arquitectura [ALTO], corregido: este comentario decía que el runtime real
 * de apps/api ERA `--experimental-strip-types` -- desde H5, `apps/api/package.json`
 * ("dev"/"start") usa `--experimental-transform-types` (SÍ transforma *parameter
 * properties*, no solo las borra). La regla de "campos explícitos, nunca *parameter
 * properties*" sigue siendo la disciplina correcta para ESTE paquete (mantiene el
 * código válido bajo el modo más estricto, `--experimental-strip-types`, que sigue
 * siendo el usado por `packages/db/src/cli.ts`/scripts que no dependen de este
 * paquete) -- pero ya no es lo único que evita el crash: `scripts/check-runtime-flags.ts`
 * (`npm run check:runtime-flags`) falla en CI si `apps/api/package.json` alguna vez
 * vuelve a `--experimental-strip-types` sin que este paquete (y `whatsapp`) también se
 * hayan limpiado de *parameter properties* primero.
 */

/** Clase base de todos los errores de un puerto de integración. */
export abstract class PortError extends Error {
  abstract readonly code: string;
}

/**
 * El adaptador real no tiene credenciales/hardware configurado en este entorno.
 * NUNCA se lanza en el adaptador Fake/Simulated (ese siempre puede responder).
 */
export class PortUnavailableError extends PortError {
  readonly code = "port_unavailable";
  readonly integration: string;
  readonly reason: string;

  constructor(integration: string, reason: string) {
    super(`[PENDIENTE DE CREDENCIALES] ${integration}: ${reason}`);
    this.name = "PortUnavailableError";
    this.integration = integration;
    this.reason = reason;
  }
}

/** La entrada o la respuesta del proveedor no pasó el esquema Zod del puerto. */
export class PortValidationError extends PortError {
  readonly code = "port_validation_error";
  readonly integration: string;
  readonly details: string;

  constructor(integration: string, details: string) {
    super(`${integration}: entrada/salida inválida: ${details}`);
    this.name = "PortValidationError";
    this.integration = integration;
    this.details = details;
  }
}

/** El proveedor devolvió 404 / recurso no encontrado. */
export class PortNotFoundError extends PortError {
  readonly code = "port_not_found";
  readonly integration: string;
  readonly resource: string;

  constructor(integration: string, resource: string) {
    super(`${integration}: no encontrado: ${resource}`);
    this.name = "PortNotFoundError";
    this.integration = integration;
    this.resource = resource;
  }
}

/** Límite de tasa del proveedor agotado (incluye `retryAfterMs` cuando el proveedor lo indica). */
export class PortRateLimitError extends PortError {
  readonly code = "port_rate_limited";
  readonly integration: string;
  readonly retryAfterMs: number | undefined;

  constructor(integration: string, retryAfterMs: number | undefined) {
    super(`${integration}: límite de tasa excedido`);
    this.name = "PortRateLimitError";
    this.integration = integration;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Firma HMAC de un webhook inválida o ausente. Fail-closed: nunca se procesa el payload. */
export class WebhookSignatureError extends PortError {
  readonly code = "webhook_signature_invalid";
  readonly integration: string;

  constructor(integration: string) {
    super(`${integration}: firma HMAC de webhook inválida`);
    this.name = "WebhookSignatureError";
    this.integration = integration;
  }
}

/** El `event_id`/`idempotency_key` del webhook ya fue procesado (replay). */
export class WebhookReplayError extends PortError {
  readonly code = "webhook_replay";
  readonly integration: string;
  readonly eventId: string;

  constructor(integration: string, eventId: string) {
    super(`${integration}: evento repetido (replay), ya procesado: ${eventId}`);
    this.name = "WebhookReplayError";
    this.integration = integration;
    this.eventId = eventId;
  }
}

/**
 * Una acción exige aprobación humana previa (`needsApproval`, patrón ADR-006) y no la
 * tiene, o la tiene incompleta (p.ej. una sola confirmación cuando se exigen dos).
 * Ninguna acción física (HVAC fuera de guarda, llave digital) ocurre sin este chequeo.
 */
export class ApprovalRequiredError extends PortError {
  readonly code = "approval_required";
  readonly integration: string;
  readonly action: string;
  readonly detail: string;

  constructor(integration: string, action: string, detail: string) {
    super(`${integration}: acción '${action}' requiere aprobación: ${detail}`);
    this.name = "ApprovalRequiredError";
    this.integration = integration;
    this.action = action;
    this.detail = detail;
  }
}
