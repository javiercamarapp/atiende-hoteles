/**
 * Reintentos con backoff exponencial + jitter, compartido por todos los adaptadores
 * reales de packages/mcp-servers/* (Cloudbeds, Meta, Stripe/Conekta, PAC, Home
 * Assistant, Seam). Ver docs/ARQUITECTURA.md ADR-007: "manejo de Retry-After, HMAC de
 * webhooks, rate limiting" es parte obligatoria del esqueleto del adaptador real, aunque
 * no pueda ejecutarse sin credenciales.
 */

export interface BackoffOptions {
  /** Número máximo de intentos (incluye el primero). Default 3. */
  maxAttempts?: number;
  /** Retardo base en ms para el primer reintento. Default 200. */
  baseDelayMs?: number;
  /** Techo del retardo en ms. Default 5000. */
  maxDelayMs?: number;
  /** Generador de aleatoriedad inyectable para pruebas deterministas. Default Math.random. */
  random?: () => number;
  /** Reloj inyectable para pruebas deterministas (retorna ms a esperar realmente). */
  sleep?: (ms: number) => Promise<void>;
  /** Decide si un error es reintentable. Default: siempre true. */
  isRetryable?: (error: unknown) => boolean;
  /**
   * Si el error trae un `retryAfterMs` explícito (p.ej. header `Retry-After` del
   * proveedor), se usa ese valor en vez del backoff calculado.
   */
  retryAfterMs?: (error: unknown) => number | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Calcula el retardo exponencial con jitter completo (AWS "full jitter"). */
export function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * exp);
}

/**
 * Ejecuta `fn` reintentando con backoff exponencial + jitter. Nunca traga el último
 * error: si se agotan los intentos, se relanza tal cual para que el llamador decida
 * (p.ej. mapearlo a `PortRateLimitError`).
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: BackoffOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 200,
    maxDelayMs = 5000,
    random = Math.random,
    sleep = defaultSleep,
    isRetryable = () => true,
    retryAfterMs,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt || !isRetryable(error)) {
        throw error;
      }
      const explicitDelay = retryAfterMs?.(error);
      const delay =
        explicitDelay ?? computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      await sleep(delay);
    }
  }
  // Inalcanzable: el bucle anterior siempre retorna o lanza.
  throw lastError;
}
