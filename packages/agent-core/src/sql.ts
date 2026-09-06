// H6b · Tipo estructural minimo compartido por `PostgresApprovalQueue` y las tools de
// dominio reales de este hito (housekeeping/mantenimiento/mensajeria). Deliberadamente NO
// se importa `@atiende-hoteles/db` aqui: agent-core sigue sin depender de un motor de base
// de datos concreto (H6a), solo declara la FORMA minima que necesita (duck typing) --
// `DbClient` de packages/db ya cumple esta forma sin cambios, asi que apps/api puede pasar
// su sesion real (`DbClient`, con RLS activa via `dbSession`) directo a estas funciones.

export interface SqlQueryResult<T> {
  readonly rows: T[];
}

export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlQueryResult<T>>;
}
