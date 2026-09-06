// Contrato minimo compartido entre el motor PGlite (unit, ADR-003) y el motor
// embedded-postgres (integracion/concurrencia real, ADR-003), para que el runner de
// migraciones y las pruebas se escriban una sola vez y corran igual contra ambos.

export interface QueryResult<T> {
  rows: T[];
}

export interface DbClient {
  /** Ejecuta una sola sentencia parametrizada ($1, $2, ...). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Ejecuta un script con multiples sentencias separadas por `;`, sin parametros. */
  exec(sql: string): Promise<void>;
}
