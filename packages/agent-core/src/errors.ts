// Errores tipados del nucleo de agentes. Cada uno lleva un `code` estable para que un
// llamador (API, panel, worker de aprobacion) pueda distinguir el motivo sin parsear el
// mensaje humano. Ninguno de estos mensajes debe llevar PII cruda (ver redact.ts).

export class AgentCoreError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Una tool se definio violando una invariante de autorizacion (ADR-006/GOB-026). */
export class ToolDefinitionError extends AgentCoreError {
  constructor(message: string) {
    super(message, "tool_definition_invalid");
  }
}

/**
 * REQ-AGT-022 / GOB-025: un fragmento de contexto de OTRO tenant intento entrar al
 * prompt de este hotel y fue rechazado (fail-closed, nunca se filtra en silencio).
 */
export class CrossTenantContextError extends AgentCoreError {
  readonly fragmentTenantId: string;
  readonly currentHotelId: string;
  readonly label: string;

  constructor(fragmentTenantId: string, currentHotelId: string, label: string) {
    super(
      `fragmento de contexto rechazado: "${label}" pertenece al tenant "${fragmentTenantId}", ` +
        `distinto del hotel en curso "${currentHotelId}" (REQ-AGT-022/GOB-025)`,
      "cross_tenant_context_rejected",
    );
    this.fragmentTenantId = fragmentTenantId;
    this.currentHotelId = currentHotelId;
    this.label = label;
  }
}

/** El loop-guard del AgentRunner corto la corrida antes de gastar una ronda adicional. */
export class LoopGuardError extends AgentCoreError {
  constructor(message: string) {
    super(message, "loop_guard_triggered");
  }
}

export type BudgetDimension = "tokens" | "time" | "cost";

/** El presupuesto (tokens/tiempo/costo) de la corrida se agoto. */
export class BudgetExceededError extends AgentCoreError {
  readonly dimension: BudgetDimension;

  constructor(message: string, dimension: BudgetDimension) {
    super(message, "budget_exceeded");
    this.dimension = dimension;
  }
}

/** La respuesta del proveedor llego truncada: se trata como error, nunca como respuesta valida. */
export class TruncatedCompletionError extends AgentCoreError {
  constructor(message: string) {
    super(message, "completion_truncated");
  }
}

/** No hay credenciales configuradas para este proveedor: estado honesto, no simulado. */
export class ProviderUnavailableError extends AgentCoreError {
  readonly providerId: string;

  constructor(providerId: string, message: string) {
    super(message, "provider_unavailable");
    this.providerId = providerId;
  }
}

/** Hay credenciales, pero la llamada real al proveedor no esta implementada en este hito. */
export class ProviderNotImplementedError extends AgentCoreError {
  readonly providerId: string;

  constructor(providerId: string, message: string) {
    super(message, "provider_not_implemented");
    this.providerId = providerId;
  }
}

/** Operacion invalida sobre la cola de aprobacion (expirada, ya resuelta, doble voto, etc.). */
export class ApprovalError extends AgentCoreError {
  constructor(message: string) {
    super(message, "approval_invalid");
  }
}
