// H12b · LAUNCH-009/D-001/D-006: arranque de base de datos para PRODUCCIÓN (Supabase u
// otro Postgres gestionado, ADR-003 "producción sigue siendo Supabase") -- espejo de
// `db.ts` (`bootstrapDevEngine`, exclusivo de desarrollo/embedded-postgres), en un
// archivo NUEVO en vez de modificar ese para no tocar su contrato existente (usado por
// `server.ts` hoy). A diferencia de `bootstrapDevEngine`:
//   - NUNCA arranca un servidor Postgres propio (`openManagedPostgres` solo abre un
//     `pg.Pool` contra un host ya existente).
//   - NUNCA aplica migraciones ni siembra datos (`supabase db push`/seed de datos reales
//     son operación del USUARIO, GOB-058, ver docs/runbooks/migracion-a-supabase.md) --
//     a diferencia de dev, donde aplicar migraciones automáticamente contra el Postgres
//     embebido local es seguro y esperado.
//   - Se conecta como `atiende_app` (mínimo privilegio), nunca como superusuario.
import { openManagedPostgres, type ManagedPostgresEngine } from "@atiende-hoteles/db";

export interface ProductionDbConfig {
  host: string;
  port?: number;
  password: string;
}

/** `undefined` si las variables de producción no están configuradas -- el llamador
 *  decide entonces si cae a `bootstrapDevEngine` (solo fuera de producción, nunca en
 *  `NODE_ENV=production`, ver `server.ts`). */
export function readProductionDbConfig(source: NodeJS.ProcessEnv = process.env): ProductionDbConfig | undefined {
  const host = source.SUPABASE_DB_HOST;
  const password = source.SUPABASE_DB_PASSWORD_APP;
  if (!host || !password) return undefined;
  return {
    host,
    port: source.SUPABASE_DB_PORT ? Number(source.SUPABASE_DB_PORT) : undefined,
    password,
  };
}

export function bootstrapProductionEngine(config: ProductionDbConfig): ManagedPostgresEngine {
  return openManagedPostgres({
    host: config.host,
    port: config.port ?? 5432,
    user: "atiende_app",
    password: config.password,
  });
}
