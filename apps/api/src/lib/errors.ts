// H2 · Formato de error uniforme exigido por el encargo: {code, message, request_id},
// nunca un stack trace hacia el cliente. `ApiError` es la única forma soportada de
// devolver un error de negocio con código HTTP explícito; cualquier excepción no
// reconocida se mapea a 500 genérico sin detalle interno.

export class ApiError extends Error {
  status: number;
  code: string;
  /** Cabeceras adicionales que `app.onError` debe copiar a la respuesta (ej.
   *  `Retry-After` en 429, ADR-008/REQ-SEG rate limit). */
  headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, headers?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const Errors = {
  unauthorized: (message = "Credenciales inválidas o token ausente/expirado.") =>
    new ApiError(401, "unauthorized", message),
  forbidden: (message = "No tienes permiso para realizar esta acción.") =>
    new ApiError(403, "forbidden", message),
  notFound: (message = "Recurso no encontrado.") => new ApiError(404, "not_found", message),
  conflict: (message: string) => new ApiError(409, "conflict", message),
  validation: (message: string) => new ApiError(400, "validation_error", message),
  idempotencyConflict: (message = "El mismo Idempotency-Key ya se usó con un cuerpo distinto.") =>
    new ApiError(422, "idempotency_key_conflict", message),
  idempotencyRequired: () =>
    new ApiError(400, "idempotency_key_required", "El header Idempotency-Key es obligatorio para esta operación."),
  rateLimited: (retryAfterSeconds: number, message = "Límite de solicitudes excedido. Intenta de nuevo en unos segundos.") =>
    new ApiError(429, "rate_limited", message, { "Retry-After": String(Math.max(0, Math.ceil(retryAfterSeconds))) }),
  internal: (message = "Ocurrió un error interno.") => new ApiError(500, "internal_error", message),
};

export interface ErrorBody {
  code: string;
  message: string;
  request_id: string;
}

export function toErrorBody(err: unknown, requestId: string): { status: number; body: ErrorBody } {
  if (err instanceof ApiError) {
    return { status: err.status, body: { code: err.code, message: err.message, request_id: requestId } };
  }

  // Errores de dominio de packages/db (RAISE EXCEPTION con errcode P0001, ver
  // migrations/0004/0006): se detectan por el prefijo del mensaje SQL, nunca se filtra
  // el stack/detalle interno de Postgres al cliente.
  const message = err instanceof Error ? err.message : String(err);
  if (/sin_disponibilidad/.test(message)) {
    return {
      status: 409,
      body: { code: "sin_disponibilidad", message: "No hay disponibilidad para la fecha/tipo de habitación solicitada.", request_id: requestId },
    };
  }
  if (/transicion_invalida/.test(message)) {
    return {
      status: 409,
      body: { code: "transicion_invalida", message: "La transición de estado solicitada no es válida.", request_id: requestId },
    };
  }
  if (/row-level security/i.test(message)) {
    return {
      status: 403,
      body: { code: "forbidden", message: "No tienes permiso para realizar esta acción.", request_id: requestId },
    };
  }

  return { status: 500, body: { code: "internal_error", message: "Ocurrió un error interno.", request_id: requestId } };
}
