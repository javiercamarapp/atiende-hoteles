/**
 * Limitador de tasa tipo token-bucket, compartido por los adaptadores reales
 * (límites de tasa no publicados/variables de Cloudbeds, tiers de mensajería de WhatsApp
 * Cloud API, límites de Stripe/Conekta) -- ver docs/referencia/03-investigacion-H12-H21.md
 * §5 "Riesgos y mitigaciones": "límites de tasa no publicados (mitigación: rate limiter +
 * backfill nocturno + webhooks-first)".
 */

export interface TokenBucketOptions {
  /** Capacidad máxima de tokens (ráfaga permitida). */
  capacity: number;
  /** Tokens que se reponen por segundo. */
  refillPerSecond: number;
  /** Reloj inyectable para pruebas deterministas. Default `Date.now`. */
  now?: () => number;
}

/** `true`/`false` de si se puede consumir, o el tiempo de espera indicado si no se puede. */
export interface ConsumeResult {
  allowed: boolean;
  waitMs: number;
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillAt: number;
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.now = options.now ?? Date.now;
    this.tokens = options.capacity;
    this.lastRefillAt = this.now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedSeconds = Math.max(0, (nowMs - this.lastRefillAt) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillAt = nowMs;
  }

  /** Intenta consumir `count` tokens (default 1). No espera: informa cuánto habría que esperar. */
  tryConsume(count = 1): ConsumeResult {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return { allowed: true, waitMs: 0 };
    }
    const missing = count - this.tokens;
    const waitMs = Math.ceil((missing / this.refillPerSecond) * 1000);
    return { allowed: false, waitMs };
  }

  /** Tokens disponibles ahora mismo (solo para diagnóstico/pruebas). */
  available(): number {
    this.refill();
    return this.tokens;
  }
}
