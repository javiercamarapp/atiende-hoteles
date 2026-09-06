// H2 · ADR-004: rate limiting por IP y por usuario. Ventana fija ("fixed window") en
// memoria local ahora, detrás de una interfaz `RateLimitStore` para poder sustituirla
// por Redis (u otro store compartido entre instancias) sin tocar el middleware — mismo
// principio de puerto/adaptador que ADR-007.

export interface RateLimitStore {
  /** Incrementa el contador de `key` y devuelve el conteo resultante. Si la clave no
   *  existe o su ventana expiró, la reinicia en 1 con un nuevo `windowMs`. */
  increment(key: string, windowMs: number): { count: number; resetAt: number };
  reset(key: string): void;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  increment(key: string, windowMs: number): { count: number; resetAt: number } {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      return fresh;
    }
    bucket.count += 1;
    return bucket;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Solo para pruebas: número de claves activas actualmente. */
  get size(): number {
    return this.buckets.size;
  }
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  store?: RateLimitStore;
}

export class RateLimiter {
  private limit: number;
  private windowMs: number;
  private store: RateLimitStore;

  constructor(opts: RateLimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.store = opts.store ?? new MemoryRateLimitStore();
  }

  /** Devuelve `{allowed:false}` cuando `key` superó el límite en la ventana actual. */
  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const { count, resetAt } = this.store.increment(key, this.windowMs);
    return { allowed: count <= this.limit, remaining: Math.max(0, this.limit - count), resetAt };
  }
}
