/**
 * Verificación de firma HMAC de webhooks (GOB-042) + protección contra replay, compartida
 * por los adaptadores de PMS/WhatsApp/pagos/CFDI. Fail-closed: cualquier ambigüedad
 * (firma ausente, header mal formado, secreto no configurado) se trata como inválida.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface HmacSignOptions {
  /** Algoritmo hash. Default sha256 (Meta, Stripe, Cloudbeds documentan sha256). */
  algorithm?: "sha256" | "sha1";
  /** Prefijo del header, p.ej. "sha256=" (formato de Meta/GitHub). Default "sha256=". */
  prefix?: string;
}

/** Firma un payload crudo (string) con HMAC, en el mismo formato que se espera verificar. */
export function signHmac(payload: string, secret: string, options: HmacSignOptions = {}): string {
  const { algorithm = "sha256", prefix = "sha256=" } = options;
  const digest = createHmac(algorithm, secret).update(payload, "utf8").digest("hex");
  return `${prefix}${digest}`;
}

/**
 * Compara la firma HMAC de un webhook contra el payload crudo (string, ANTES de
 * `JSON.parse`) usando comparación en tiempo constante. Nunca lanza por firma
 * inválida -- retorna `false` para que el llamador decida (típicamente lanzar
 * `WebhookSignatureError`).
 */
export function verifyHmacSignature(
  payload: string,
  receivedSignature: string | undefined | null,
  secret: string,
  options: HmacSignOptions = {},
): boolean {
  if (!receivedSignature || !secret) return false;
  const expected = signHmac(payload, secret, options);
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(receivedSignature, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Guarda de replay para webhooks: recuerda los `event_id` ya procesados dentro de una
 * ventana TTL. Implementación en memoria -- una implementación respaldada por
 * `idempotency_key` de `packages/db` es trabajo de un hito posterior (mismo criterio que
 * `ApprovalQueue` en H6a).
 */
export class InMemoryReplayGuard {
  private readonly seen = new Map<string, number>();
  // H6b: campo explicito, no "parameter property" -- ese azucar de TypeScript no esta
  // soportado por el modo "strip types" de Node (`node --experimental-strip-types`, el
  // runtime real de apps/api): cargar este modulo en ejecucion tumbaba el proceso con
  // `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` en cuanto apps/api empezo a depender de un
  // adaptador de packages/mcp-servers (H6b conecta WhatsApp por primera vez).
  private readonly ttlMs: number;

  constructor(ttlMs: number = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** `true` si el evento YA fue visto (es un replay); si no, lo marca como visto. */
  seenBefore(eventId: string, now: number = Date.now()): boolean {
    this.evictExpired(now);
    if (this.seen.has(eventId)) return true;
    this.seen.set(eventId, now + this.ttlMs);
    return false;
  }

  private evictExpired(now: number): void {
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(id);
    }
  }
}
