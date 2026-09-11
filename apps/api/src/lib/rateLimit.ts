// H2 · ADR-004: rate limiting por IP y por usuario. Ventana fija ("fixed window") en
// memoria local ahora, detrás de una interfaz `RateLimitStore` para poder sustituirla
// por Redis (u otro store compartido entre instancias) sin tocar el middleware — mismo
// principio de puerto/adaptador que ADR-007.
//
// Patrón Likida/atiende.ai #3 ("rate limiting distribuido fail-open/closed explícito",
// LAUNCH-022): `MemoryRateLimitStore` guarda el conteo en un `Map` del proceso -- en
// despliegue serverless multi-instancia (Vercel) o multi-máquina (Fly escalado a >1) el
// límite deja de ser efectivo entre instancias concurrentes, documentado en
// `deploy/README.md`/`deploy/api/vercel/api/[[...route]].ts`. Por instrucción del audit
// que originó este módulo NO se aprovisiona Redis nuevo -- `PostgresRateLimitStore` (más
// abajo) usa el store compartido real que este repo YA tiene entre instancias: el mismo
// Postgres. Es un store REAL (no un esqueleto/fake sin probar): ver
// tests/unit/api/postgres-rate-limit-store.spec.ts, corrido de extremo a extremo contra
// PGlite. NO se sustituye por default en `server.ts`/`deploy/api/vercel/api/
// [[...route]].ts` -- wire-earlo ahí es una decisión de despliegue explícita (agrega un
// round-trip a Postgres en cada request) que corresponde a quien decide desplegar
// multi-instancia, no a este cambio.

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

// ─────────────────────────────────────────────────────────────────────────────
// Patrón Likida/atiende.ai #3: store distribuido real (Postgres), async por naturaleza
// (I/O de red) -- interfaz SEPARADA de `RateLimitStore` (nunca se fuerza `Store` a ser
// async solo para acomodar un backend nuevo: `RateLimiter`/`MemoryRateLimitStore`
// siguen síncronos, sin tocar ninguno de sus ~7 call sites reales en apps/api/src).
// ─────────────────────────────────────────────────────────────────────────────

/** Contrato mínimo de `DbClient` que este módulo necesita -- se declara localmente (en
 *  vez de importar `DbClient` de `@atiende-hoteles/db`) para no acoplar `rateLimit.ts` a
 *  la forma completa de ese paquete; cualquier objeto con `query()` compatible sirve
 *  (incluida una implementación Fake en pruebas). */
export interface RateLimitDbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface AsyncRateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

/**
 * Decisión explícita ante una falla del store compartido (timeout, conexión caída,
 * Postgres abajo) -- el hallazgo central del patrón: HOY (`MemoryRateLimitStore`) esta
 * decisión ni siquiera existe por escrito porque el store nunca falla (es local).
 *  - "fail-open": el request se PERMITE (nunca se bloquea tráfico legítimo por una
 *    falla de infraestructura ajena al usuario) -- el límite queda temporalmente sin
 *    aplicar mientras dure la falla. Recomendado para el límite general por IP (H2
 *    default 300/min): el costo de "temporalmente sin límite" es menor que negar
 *    servicio a todo el mundo por un blip de Postgres.
 *  - "fail-closed": el request se BLOQUEA (se prefiere negar servicio antes que dejar
 *    pasar tráfico sin límite) -- recomendado para límites que protegen contra abuso
 *    activo/costoso (p.ej. `registro.ts`/`correo.ts`, RATE_LIMIT_REGISTRO_POR_IP_POR_HORA:
 *    dejar pasar sin límite mientras Postgres está caído podría inundar de altas/correos).
 */
export type RateLimitFailurePolicy = "fail-open" | "fail-closed";

export interface PostgresRateLimitStoreOptions {
  db: RateLimitDbClient;
  onFailure: RateLimitFailurePolicy;
  /** Se invoca (nunca lanza) cuando la escritura a Postgres falla -- para que el
   *  llamador pueda registrar la degradación (logger estructurado) sin que este store
   *  dependa de una implementación de logger concreta. */
  onFailureLogged?: (err: unknown) => void;
}

/**
 * Store de rate limit respaldado por `public.rate_limit_bucket` (migración 0131) --
 * COMPARTIDO entre todas las instancias del backend porque todas hablan al mismo
 * Postgres, a diferencia de `MemoryRateLimitStore`. Un único UPSERT atómico
 * (`on conflict ... do update`) resuelve tanto el caso "clave nueva"/"ventana expirada"
 * (reinicia en 1) como "dentro de la ventana" (incrementa) sin necesitar un lock
 * explícito: Postgres serializa las escrituras concurrentes sobre la MISMA fila.
 *
 * Nunca lanza: cualquier error de la escritura real se atrapa y se resuelve según
 * `onFailure` (ver `RateLimitFailurePolicy`) -- mismo contrato que `MemoryRateLimitStore`
 * (que estructuralmente no puede fallar), para que `RateLimiter`/el middleware no
 * necesiten saber qué store tienen detrás.
 */
export class PostgresRateLimitStore implements AsyncRateLimitStore {
  private readonly db: RateLimitDbClient;
  private readonly onFailure: RateLimitFailurePolicy;
  private readonly onFailureLogged?: (err: unknown) => void;

  constructor(options: PostgresRateLimitStoreOptions) {
    this.db = options.db;
    this.onFailure = options.onFailure;
    this.onFailureLogged = options.onFailureLogged;
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const resetAtIfNew = new Date(Date.now() + windowMs);
    try {
      const { rows } = await this.db.query<{ count: number; reset_at: Date | string }>(
        `insert into public.rate_limit_bucket (key, count, reset_at, updated_at)
         values ($1, 1, $2, now())
         on conflict (key) do update set
           count = case when public.rate_limit_bucket.reset_at <= now() then 1
                        else public.rate_limit_bucket.count + 1 end,
           reset_at = case when public.rate_limit_bucket.reset_at <= now() then excluded.reset_at
                           else public.rate_limit_bucket.reset_at end,
           updated_at = now()
         returning count, reset_at;`,
        [key, resetAtIfNew.toISOString()],
      );
      const row = rows[0]!;
      const resetAt = row.reset_at instanceof Date ? row.reset_at.getTime() : new Date(row.reset_at).getTime();
      return { count: row.count, resetAt };
    } catch (err) {
      this.onFailureLogged?.(err);
      if (this.onFailure === "fail-open") {
        // Se reporta count=0 (siempre <= cualquier límite configurado, allowed=true) --
        // el llamador nunca ve una excepción, solo un resultado que nunca bloquea.
        return { count: 0, resetAt: resetAtIfNew.getTime() };
      }
      // "fail-closed": Number.MAX_SAFE_INTEGER garantiza allowed=false sin importar el
      // límite configurado, sin necesitar que RateLimiter/el store sepan ese límite aquí.
      return { count: Number.MAX_SAFE_INTEGER, resetAt: resetAtIfNew.getTime() };
    }
  }
}

export interface AsyncRateLimiterOptions {
  limit: number;
  windowMs: number;
  store: AsyncRateLimitStore;
}

/** Misma forma que `RateLimiter`, async porque su store lo es (I/O de red real). */
export class AsyncRateLimiter {
  private limit: number;
  private windowMs: number;
  private store: AsyncRateLimitStore;

  constructor(opts: AsyncRateLimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.store = opts.store;
  }

  async check(key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const { count, resetAt } = await this.store.increment(key, this.windowMs);
    return { allowed: count <= this.limit, remaining: Math.max(0, this.limit - count), resetAt };
  }
}
