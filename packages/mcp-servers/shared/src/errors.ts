/**
 * Errores tipados compartidos por todos los puertos de packages/mcp-servers/*.
 *
 * Ver docs/ARQUITECTURA.md ADR-007/ADR-011: un adaptador real sin credenciales/hardware
 * nunca devuelve datos inventados -- se declara `unavailable` lanzando
 * `PortUnavailableError` con la razón explícita. Estos tipos permiten que las pruebas
 * de contrato distingan "el adaptador no puede responder honestamente" de "el proveedor
 * respondió con un error de negocio".
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
  constructor(
    readonly integration: string,
    readonly reason: string,
  ) {
    super(`[PENDIENTE DE CREDENCIALES] ${integration}: ${reason}`);
    this.name = "PortUnavailableError";
  }
}

/** La entrada o la respuesta del proveedor no pasó el esquema Zod del puerto. */
export class PortValidationError extends PortError {
  readonly code = "port_validation_error";
  constructor(
    readonly integration: string,
    readonly details: string,
  ) {
    super(`${integration}: entrada/salida inválida: ${details}`);
    this.name = "PortValidationError";
  }
}

/** El proveedor devolvió 404 / recurso no encontrado. */
export class PortNotFoundError extends PortError {
  readonly code = "port_not_found";
  constructor(
    readonly integration: string,
    readonly resource: string,
  ) {
    super(`${integration}: no encontrado: ${resource}`);
    this.name = "PortNotFoundError";
  }
}

/** Límite de tasa del proveedor agotado (incluye `retryAfterMs` cuando el proveedor lo indica). */
export class PortRateLimitError extends PortError {
  readonly code = "port_rate_limited";
  constructor(
    readonly integration: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`${integration}: límite de tasa excedido`);
    this.name = "PortRateLimitError";
  }
}

/** Firma HMAC de un webhook inválida o ausente. Fail-closed: nunca se procesa el payload. */
export class WebhookSignatureError extends PortError {
  readonly code = "webhook_signature_invalid";
  constructor(readonly integration: string) {
    super(`${integration}: firma HMAC de webhook inválida`);
    this.name = "WebhookSignatureError";
  }
}

/** El `event_id`/`idempotency_key` del webhook ya fue procesado (replay). */
export class WebhookReplayError extends PortError {
  readonly code = "webhook_replay";
  constructor(
    readonly integration: string,
    readonly eventId: string,
  ) {
    super(`${integration}: evento repetido (replay), ya procesado: ${eventId}`);
    this.name = "WebhookReplayError";
  }
}

/**
 * Una acción exige aprobación humana previa (`needsApproval`, patrón ADR-006) y no la
 * tiene, o la tiene incompleta (p.ej. una sola confirmación cuando se exigen dos).
 * Ninguna acción física (HVAC fuera de guarda, llave digital) ocurre sin este chequeo.
 */
export class ApprovalRequiredError extends PortError {
  readonly code = "approval_required";
  constructor(
    readonly integration: string,
    readonly action: string,
    readonly detail: string,
  ) {
    super(`${integration}: acción '${action}' requiere aprobación: ${detail}`);
    this.name = "ApprovalRequiredError";
  }
}
