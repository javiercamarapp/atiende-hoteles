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
  // H12c · LAUNCH-015: 402 explícito (nunca un bloqueo silencioso, REQ-UX-002) cuando
  // una acción excedería el límite del plan de la organización -- ver
  // apps/api/src/lib/entitlement.ts y public.check_entitlement() (0111).
  entitlementExceeded: (message: string) => new ApiError(402, "entitlement_exceeded", message),
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

  // auditoria-2/seguridad (S2/S3/S4, migraciones 0062/0063/0065): funciones
  // SECURITY DEFINER que ahora validan la membresia real del actor contra el recurso
  // (nunca contra un parametro que el llamador podria inventar) levantan estos
  // errcodes 42501 con un mensaje propio -- se mapean a 403 igual que la RLS nativa,
  // sin filtrar detalle interno.
  if (/tenant_no_autorizado|hotel_no_autorizado|rol_no_autorizado|acceso_boveda_no_autorizado/.test(message)) {
    return {
      status: 403,
      body: { code: "forbidden", message: "No tienes permiso para realizar esta acción.", request_id: requestId },
    };
  }
  // auditoria-2/datos (D3, migracion 0066): un folio cerrado no admite nuevos cargos, y
  // un cierre 'saldo_cero' se rechaza si el saldo recalculado en el momento del cierre
  // ya no es cero (carrera cargo-vs-cierre resuelta con lock de fila en la base).
  // auditoria-2/seguridad (S3, migracion 0063): una corrida de night audit ya
  // 'completado' nunca se re-termina/reemplaza.
  // auditoria-2/legal (ALTO, migracion 0067): retencion de bóveda de identidad mayor a
  // 30 días sin motivo justificado.
  if (/motivo_retencion_requerido/.test(message)) {
    return {
      status: 400,
      body: { code: "validation_error", message: "Una retención mayor a 30 días requiere justificar el motivo.", request_id: requestId },
    };
  }
  if (/folio_cerrado_no_admite_cargos|cierre_balance_invalido|night_audit_run_ya_completado/.test(message)) {
    return {
      status: 409,
      body: { code: "conflict", message: "La operación entró en conflicto con el estado actual del recurso.", request_id: requestId },
    };
  }
  // H12c · public.check_entitlement() (0111) lanza `entitlement_exceeded:<recurso>` o
  // `entitlement_exceeded:suscripcion_inactiva`/`entitlement_exceeded:sin_suscripcion` --
  // se traduce a 402 con el detalle real (hint de la excepción), nunca a un 500 genérico.
  const entitlementMatch = /entitlement_exceeded:(\w+)/.exec(message);
  if (entitlementMatch) {
    return {
      status: 402,
      body: {
        code: "entitlement_exceeded",
        message: `Se alcanzó el límite del plan (${entitlementMatch[1]}). Mejora tu plan en /suscripcion para continuar.`,
        request_id: requestId,
      },
    };
  }

  return { status: 500, body: { code: "internal_error", message: "Ocurrió un error interno.", request_id: requestId } };
}
