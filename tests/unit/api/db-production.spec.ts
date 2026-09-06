// H12b · LAUNCH-009/D-006: `readProductionDbConfig()` decide si apps/api arranca contra
// un Postgres gestionado (Supabase) o cae a `bootstrapDevEngine` (embedded-postgres,
// exclusivo de desarrollo). Prueba pura, sin red ni Postgres real.
import { describe, expect, it } from "vitest";
import { readProductionDbConfig } from "../../../apps/api/src/dbProduction.ts";

describe("readProductionDbConfig", () => {
  it("undefined si falta SUPABASE_DB_HOST o SUPABASE_DB_PASSWORD_APP", () => {
    expect(readProductionDbConfig({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(readProductionDbConfig({ SUPABASE_DB_HOST: "db.x.supabase.co" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(readProductionDbConfig({ SUPABASE_DB_PASSWORD_APP: "secreto" } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("devuelve la config con ambas variables presentes, puerto 5432 por default", () => {
    const config = readProductionDbConfig({
      SUPABASE_DB_HOST: "db.x.supabase.co",
      SUPABASE_DB_PASSWORD_APP: "secreto",
    } as NodeJS.ProcessEnv);
    expect(config).toEqual({ host: "db.x.supabase.co", password: "secreto", port: undefined });
  });

  it("respeta SUPABASE_DB_PORT si se define", () => {
    const config = readProductionDbConfig({
      SUPABASE_DB_HOST: "db.x.supabase.co",
      SUPABASE_DB_PASSWORD_APP: "secreto",
      SUPABASE_DB_PORT: "6543",
    } as NodeJS.ProcessEnv);
    expect(config?.port).toBe(6543);
  });
});
