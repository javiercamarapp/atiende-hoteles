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
  /** F1/REQ-BO-001: el impuesto de un cargo SIEMPRE lo calcula el motor determinista
   *  (`computeChargeAmounts`) desde `hotel_tax_config` -- un cliente jamás puede
   *  fijarlo. Si el cliente manda `impuesto` de todos modos (compatibilidad con
   *  integraciones que ya lo calcularon aguas arriba), se exige que coincida EXACTO
   *  (tolerancia de un centavo) con lo que el motor calculó; si no coincide, 422 --
   *  nunca se usa en silencio el valor del cliente. */
  impuestoNoCoincide: (esperado: number, recibido: number) =>
    new ApiError(
      422,
      "impuesto_no_coincide",
      `El impuesto enviado (${recibido}) no coincide con el calculado por el motor fiscal (${esperado}). El impuesto siempre lo calcula el sistema, nunca el cliente.`,
    ),
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
  // H12b · LAUNCH-007: `admin_negocio()`/`admin_reintentar_outbox()` (0100) levantan
  // `no_autorizado` cuando `is_platform_admin()` es falso -- backstop de la función SQL
  // detrás del 403 explícito que ya pone `requirePlatformAdmin` en routes/admin.ts.
  if (/tenant_no_autorizado|hotel_no_autorizado|rol_no_autorizado|acceso_boveda_no_autorizado|no_autorizado/.test(message)) {
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
  // REQ-HUE-021/REQ-SEG-007 (packages/agent-core `MarketingOptInRequiredError`): una
  // plantilla de marketing sin opt-in registrado se bloquea en `tool.run()` -- este
  // mapeo cubre TANTO el rechazo inmediato en routes/mensajeria.ts como la ejecución
  // diferida de una aprobación ya "aprobada" por un humano que no sabía que faltaba el
  // opt-in (apps/api/src/lib/aprobacionEjecutor.ts también llama a esta misma tool).
  if (/opt_in_marketing_requerido/.test(message)) {
    return {
      status: 409,
      body: {
        code: "opt_in_marketing_requerido",
        message: "No existe opt-in de marketing registrado para este huésped; el envío fue bloqueado.",
        request_id: requestId,
      },
    };
  }
  // REQ-GOB-012 (migración 0081): `require_founder_decision_approval()` levanta
  // `aprobacion_fundador_requerida: la categoria "<cat>" ...` cuando el intento cae en
  // una de las 24 categorías reservadas al fundador (ej. `agent_config` subiendo
  // `auditor_nocturno` -- el agente de revenue/cierre -- a "autopilot" sin una
  // `founder_decision_approval` vigente). Antes de este mapeo caía al 500 genérico del
  // final de esta función: un owner/gm que intentaba la transición vía
  // `PATCH /hoteles/:hotelId/agentes/:agente/config` (apps/api/src/routes/agentes.ts)
  // no tenía forma de saber, desde la respuesta HTTP, que el bloqueo era "falta
  // aprobación del fundador" y no un error interno del servidor.
  const founderApprovalMatch = /aprobacion_fundador_requerida: la categoria "([^"]+)"/.exec(message);
  if (founderApprovalMatch) {
    return {
      status: 409,
      body: {
        code: "aprobacion_fundador_requerida",
        message: `Esta acción ("${founderApprovalMatch[1]}") es una decisión reservada al fundador (REQ-GOB-012) y no tiene una aprobación registrada y vigente; no se puede aplicar todavía.`,
        request_id: requestId,
      },
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
