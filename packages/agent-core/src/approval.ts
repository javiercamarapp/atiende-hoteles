// Cola de aprobacion humana (ADR-006, "Decision sobre orquestacion de aprobaciones"):
// hoy en memoria; el contrato (`ApprovalQueue`) esta pensado para que una implementacion
// futura persista en una tabla `agent_task`/`approval` de packages/db (estado
// `pendiente_aprobacion`, resuelta por un humano via API/WhatsApp/web) sin tocar el
// AgentRunner ni las tools. GOB-026: toda aprobacion registra el texto exacto que vio el
// aprobador; las de dinero exigen doble confirmacion de actores distintos.

import { randomUUID, createHash } from "node:crypto";
import { ApprovalError } from "./errors.ts";

export type ApprovalStatus = "pendiente" | "aprobada" | "rechazada" | "expirada";
export type ApprovalDecision = "aprobar" | "rechazar";

export interface ApprovalConfirmation {
  readonly actor: string;
  /** Rol declarado del aprobador (p.ej. "gerente", "director"). GOB-026 exige DOS ROLES
   * distintos para dinero, no solo dos strings de actor distintos (ver `decide()`). */
  readonly role?: string;
  readonly decidedAt: string;
  readonly decision: ApprovalDecision;
  /** GOB-026: texto exacto que vio el aprobador, para el hash encadenado de audit_log. */
  readonly textoExacto: string;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly toolName: string;
  readonly inputHash: string;
  readonly orgId: string;
  readonly hotelId: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly isMoney: boolean;
  /** 1 normalmente; 2 para dinero (doble confirmacion, GOB-026). */
  readonly requiredConfirmations: number;
  readonly textoMostrado: string;
  /** Resumen legible del input REAL que recibio la tool (monto/folio/lo que traiga
   * `parsed.data`, redactado) -- para que el aprobador no firme a ciegas (GOB-026).
   * Ver aud-1 tool-calling.md CRITICO #2. */
  readonly inputSummary: string;
  status: ApprovalStatus;
  confirmations: ApprovalConfirmation[];
  /** A4 (auditoria-2): ISO de cuando `markExecuted()` consumió esta aprobación, o
   * `undefined` si todavía no se ejecutó ninguna tool con ella. Una aprobación
   * "aprobada" es reutilizable por `request()` (misma tool+input+hotel+requestedBy
   * dentro del TTL) -- este campo es lo que impide que una SEGUNDA lectura de esa
   * misma fila "aprobada" dispare una SEGUNDA ejecución de la tool. */
  executedAt?: string;
}

export interface RequestApprovalParams {
  readonly toolName: string;
  readonly input: unknown;
  readonly orgId: string;
  readonly hotelId: string;
  readonly requestedBy: string;
  readonly isMoney: boolean;
  readonly textoMostrado: string;
  /** Resumen legible del input real (ver `ApprovalRequest.inputSummary`). Si se omite,
   * se usa `textoMostrado` como respaldo. */
  readonly inputSummary?: string;
  readonly ttlMs?: number;
}

export interface DecideApprovalParams {
  readonly approvalId: string;
  readonly actor: string;
  /** Rol declarado del aprobador. Obligatorio para decidir "aprobar" sobre una solicitud
   * de dinero (GOB-026: dos ROLES distintos, no dos alias del mismo actor). */
  readonly role?: string;
  readonly decision: ApprovalDecision;
  readonly textoExacto: string;
  readonly now?: Date;
}

export interface ApprovalQueue {
  /** Idempotente por (toolName, hash(input), hotelId): reusa una solicitud pendiente
   * identica en vez de duplicarla. */
  request(params: RequestApprovalParams): Promise<ApprovalRequest>;
  decide(params: DecideApprovalParams): Promise<ApprovalRequest>;
  get(id: string): Promise<ApprovalRequest | undefined>;
  /** Barre pendientes vencidas -> "expirada". Devuelve cuantas se expiraron. */
  expirePending(now?: Date): Promise<number>;
  /** A4 (auditoria-2): reclama ATOMICAMENTE la ejecucion de una aprobacion "aprobada"
   * -- devuelve `true` SOLO la primera vez que se llama para un `id` dado (la llamada
   * que de verdad debe ejecutar la tool); `false` en cualquier llamada posterior
   * (incluida una concurrente que pierde la carrera), para que el llamador la trate
   * como ya ejecutada y NUNCA vuelva a correr la tool. No cambia `status`. */
  markExecuted(id: string, now?: Date): Promise<boolean>;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysDeep(record[key])]),
    );
  }
  return value;
}

/** Hash canonico del input de una tool, usado como parte de la llave de idempotencia. */
export function hashApprovalInput(input: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(input ?? null));
  return createHash("sha256").update(canonical).digest("hex");
}

// aud-1 tool-calling.md CRITICO #1: la llave de idempotencia DEBE incluir el ambito de
// conversacion/actor (`requestedBy`) ademas de hotel+tool+hash(input). Sin esto, dos
// conversaciones distintas (dos huespedes/folios) que llaman la misma tool con el mismo
// input (tipico en el patron Likida `properties: {}`, donde el input real siempre es
// `{}`) comparten la MISMA solicitud de aprobacion -- aprobar la de un huesped aprueba,
// sin que nadie lo note, la del otro.
function idempotencyKey(toolName: string, inputHash: string, hotelId: string, requestedBy: string): string {
  return `${hotelId}::${toolName}::${inputHash}::${requestedBy}`;
}

export interface InMemoryApprovalQueueOptions {
  /** Default 15 minutos. */
  readonly defaultTtlMs?: number;
  /** Confirmaciones requeridas para aprobar una accion de dinero. Default 2 (GOB-026). */
  readonly moneyRequiredConfirmations?: number;
  readonly now?: () => Date;
}

/** Implementacion en memoria; sirve como fixture de pruebas y como referencia del
 * contrato que una implementacion respaldada por Postgres debe cumplir. */
export class InMemoryApprovalQueue implements ApprovalQueue {
  private readonly byId = new Map<string, ApprovalRequest>();
  private readonly pendingIndex = new Map<string, string>();
  private readonly defaultTtlMs: number;
  private readonly moneyRequiredConfirmations: number;
  private readonly now: () => Date;

  constructor(options: InMemoryApprovalQueueOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 15 * 60 * 1000;
    this.moneyRequiredConfirmations = options.moneyRequiredConfirmations ?? 2;
    this.now = options.now ?? ((): Date => new Date());
  }

  async request(params: RequestApprovalParams): Promise<ApprovalRequest> {
    const inputHash = hashApprovalInput(params.input);
    const idemKey = idempotencyKey(params.toolName, inputHash, params.hotelId, params.requestedBy);
    // Idempotencia por (tool, hash(input), hotel, requestedBy=ambito de conversacion/actor):
    // si YA existe una solicitud vigente (pendiente, aprobada o rechazada) para exactamente
    // el mismo (tool,input,hotel,requestedBy), se reusa en vez de abrir una segunda decision
    // en paralelo -- incluida una ya rechazada: es la MISMA decision humana, no debe borrarse
    // ni reabrirse en silencio con un simple reintento identico del modelo. `AgentRunner`
    // (runner.ts) es responsable de reportar un "rechazada" como estado TERMINAL explicito,
    // nunca como "pendiente" (aud-1 tool-calling.md ALTO #4). Solo una solicitud vencida
    // (expirada) permite crear una nueva.
    const existingId = this.pendingIndex.get(idemKey);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing && !this.isExpired(existing)) {
        return existing;
      }
    }

    const now = this.now();
    const request: ApprovalRequest = {
      id: randomUUID(),
      toolName: params.toolName,
      inputHash,
      orgId: params.orgId,
      hotelId: params.hotelId,
      requestedBy: params.requestedBy,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (params.ttlMs ?? this.defaultTtlMs)).toISOString(),
      isMoney: params.isMoney,
      requiredConfirmations: params.isMoney ? this.moneyRequiredConfirmations : 1,
      textoMostrado: params.textoMostrado,
      inputSummary: params.inputSummary ?? params.textoMostrado,
      status: "pendiente",
      confirmations: [],
    };
    this.byId.set(request.id, request);
    this.pendingIndex.set(idemKey, request.id);
    return request;
  }

  async decide(params: DecideApprovalParams): Promise<ApprovalRequest> {
    const request = this.byId.get(params.approvalId);
    if (!request) {
      throw new ApprovalError(`solicitud de aprobacion inexistente: ${params.approvalId}`);
    }
    const now = params.now ?? this.now();
    if (request.status === "pendiente" && this.isExpired(request, now)) {
      request.status = "expirada";
    }
    if (request.status !== "pendiente") {
      throw new ApprovalError(
        `solicitud de aprobacion "${params.approvalId}" ya no esta pendiente (estado actual: ${request.status})`,
      );
    }

    if (params.decision === "rechazar") {
      request.status = "rechazada";
      request.confirmations.push({
        actor: params.actor,
        role: params.role,
        decidedAt: now.toISOString(),
        decision: "rechazar",
        textoExacto: params.textoExacto,
      });
      return request;
    }

    // aud-1 agentico.md MEDIO #6: GOB-026 exige DOS ROLES distintos ("1/2 licitador, 2/2
    // director"), no solo dos strings de actor distintos -- dos alias/sesiones del MISMO
    // humano (mismo rol) no deben poder satisfacer la doble confirmacion de dinero. El rol
    // es obligatorio al aprobar una solicitud de dinero.
    if (request.isMoney && !params.role) {
      throw new ApprovalError(
        `aprobar la solicitud de dinero "${params.approvalId}" requiere declarar el rol del ` +
          `aprobador (GOB-026: se exigen dos ROLES distintos, no solo dos actores)`,
      );
    }

    const yaConfirmoEsteActor = request.confirmations.some(
      (c) => c.actor === params.actor && c.decision === "aprobar",
    );
    const yaConfirmoEsteRol =
      request.isMoney &&
      params.role !== undefined &&
      request.confirmations.some((c) => c.decision === "aprobar" && c.role === params.role);
    if (yaConfirmoEsteActor || yaConfirmoEsteRol) {
      throw new ApprovalError(
        `el actor "${params.actor}"${params.role ? ` (rol "${params.role}")` : ""} ya confirmo esta ` +
          `aprobacion; se requiere un segundo actor con un ROL distinto para la doble confirmacion de ` +
          `dinero (GOB-026)`,
      );
    }

    request.confirmations.push({
      actor: params.actor,
      role: params.role,
      decidedAt: now.toISOString(),
      decision: "aprobar",
      textoExacto: params.textoExacto,
    });
    const aprobaciones = request.confirmations.filter((c) => c.decision === "aprobar").length;
    if (aprobaciones >= request.requiredConfirmations) {
      request.status = "aprobada";
    }
    return request;
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    return this.byId.get(id);
  }

  async markExecuted(id: string, now: Date = this.now()): Promise<boolean> {
    const request = this.byId.get(id);
    if (!request || request.executedAt) return false;
    request.executedAt = now.toISOString();
    return true;
  }

  async expirePending(now: Date = this.now()): Promise<number> {
    let count = 0;
    for (const request of this.byId.values()) {
      if (request.status === "pendiente" && this.isExpired(request, now)) {
        request.status = "expirada";
        count += 1;
      }
    }
    return count;
  }

  private isExpired(request: ApprovalRequest, now: Date = this.now()): boolean {
    return new Date(request.expiresAt).getTime() <= now.getTime();
  }
}
