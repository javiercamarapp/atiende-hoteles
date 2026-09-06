/**
 * Idempotencia por clave externa para mutaciones contra proveedores (crear cargo,
 * timbrar CFDI, cobrar, emitir llave). Mismo espíritu que `idempotency_key` de
 * `packages/db` (H1) y `ApprovalQueue.request()` de `packages/agent-core` (H6a): una
 * segunda solicitud con la misma clave reusa la respuesta ya obtenida en vez de mutar
 * dos veces contra el proveedor real.
 */

export interface IdempotencyStore<T> {
  /** Retorna la respuesta ya guardada para `key`, o `undefined` si es la primera vez. */
  get(key: string): T | undefined;
  /** Guarda la respuesta asociada a `key`. Sobrescribe solo si no existía (ver `withIdempotency`). */
  set(key: string, value: T): void;
}

/** Implementación en memoria. Basta para pruebas de contrato y para el adaptador Fake/Simulated. */
export class InMemoryIdempotencyStore<T> implements IdempotencyStore<T> {
  private readonly store = new Map<string, T>();

  get(key: string): T | undefined {
    return this.store.get(key);
  }

  set(key: string, value: T): void {
    if (!this.store.has(key)) this.store.set(key, value);
  }

  /** Solo para pruebas: cuántas claves distintas se han registrado. */
  get size(): number {
    return this.store.size;
  }
}

/**
 * Ejecuta `fn` solo si `key` no se ha visto antes en `store`; si ya existe, retorna la
 * respuesta guardada sin volver a llamar al proveedor. Retorna también si la llamada fue
 * `replayed` (para que las pruebas de contrato puedan afirmar "el proveedor solo se
 * llamó una vez").
 */
export async function withIdempotency<T>(
  store: IdempotencyStore<T>,
  key: string,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const existing = store.get(key);
  if (existing !== undefined) {
    return { result: existing, replayed: true };
  }
  const result = await fn();
  store.set(key, result);
  return { result, replayed: false };
}
