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
  status: ApprovalStatus;
  confirmations: ApprovalConfirmation[];
}

export interface RequestApprovalParams {
  readonly toolName: string;
  readonly input: unknown;
  readonly orgId: string;
  readonly hotelId: string;
  readonly requestedBy: string;
  readonly isMoney: boolean;
  readonly textoMostrado: string;
  readonly ttlMs?: number;
}

export interface DecideApprovalParams {
  readonly approvalId: string;
  readonly actor: string;
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

function idempotencyKey(toolName: string, inputHash: string, hotelId: string): string {
  return `${hotelId}::${toolName}::${inputHash}`;
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
    const idemKey = idempotencyKey(params.toolName, inputHash, params.hotelId);
    // Idempotencia por (tool, hash(input), hotel): si YA existe una solicitud vigente
    // (pendiente, aprobada o rechazada) para exactamente el mismo (tool,input,hotel), se
    // reusa en vez de abrir una segunda decision en paralelo. Solo una solicitud vencida
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
        decidedAt: now.toISOString(),
        decision: "rechazar",
        textoExacto: params.textoExacto,
      });
      return request;
    }

    const yaConfirmoEsteActor = request.confirmations.some(
      (c) => c.actor === params.actor && c.decision === "aprobar",
    );
    if (yaConfirmoEsteActor) {
      throw new ApprovalError(
        `el actor "${params.actor}" ya confirmo esta aprobacion; se requiere un segundo actor ` +
          `distinto para la doble confirmacion de dinero (GOB-026)`,
      );
    }

    request.confirmations.push({
      actor: params.actor,
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
