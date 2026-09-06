// H12b · LAUNCH-009: prueba ESTÁTICA (sin Docker/Supabase CLI, B-002) de
// `scripts/export-supabase-migrations.ts` -- verifica que `supabase/migrations/*.sql`:
//   1. No contiene ningún objeto local prohibido (schema auth, auth.uid(), roles que
//      Supabase ya trae, contraseñas de desarrollo hardcodeadas).
//   2. Cada archivo generado conserva, en su encabezado, el hash sha256 EXACTO del
//      archivo fuente correspondiente en packages/db/migrations/ (detecta drift si
//      alguien edita la fuente sin volver a exportar).
//   3. El propio modo `--check` del script (usado en CI) da OK contra el estado actual.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExportedMigrations,
  findProhibitedObjects,
  OUTPUT_DIR,
  SOURCE_DIR,
  transformAuthMigrationForSupabase,
} from "../../scripts/export-supabase-migrations.ts";

describe("scripts/export-supabase-migrations.ts", () => {
  it("supabase/migrations/ existe y tiene exactamente un archivo por cada migración fuente", () => {
    const sourceCount = readdirSync(SOURCE_DIR).filter((f) => f.endsWith(".sql")).length;
    const outputFiles = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".sql"));
    expect(outputFiles).toHaveLength(sourceCount);
  });

  it("ningún archivo generado contiene objetos locales prohibidos (schema auth, auth.uid(), roles de Supabase, contraseñas dev)", () => {
    const files = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".sql"));
    for (const filename of files) {
      const content = readFileSync(join(OUTPUT_DIR, filename), "utf8");
      const violations = findProhibitedObjects(content);
      expect(violations, `${filename} no debería contener: ${violations.join(", ")}`).toHaveLength(0);
    }
  });

  it("cada archivo generado conserva el hash sha256 del archivo fuente en su encabezado ORIGEN", () => {
    const expected = buildExportedMigrations();
    for (const m of expected) {
      const sourceSql = readFileSync(join(SOURCE_DIR, m.filename), "utf8");
      const realHash = createHash("sha256").update(sourceSql).digest("hex");
      expect(m.sourceChecksum).toBe(realHash);

      const generated = readFileSync(join(OUTPUT_DIR, m.filename), "utf8");
      expect(generated).toContain(`-- ORIGEN: packages/db/migrations/${m.filename} sha256:${realHash}`);
    }
  });

  it("supabase/migrations/ está sincronizado con packages/db/migrations/ (--check pasa)", () => {
    expect(() =>
      execFileSync("node", ["--experimental-strip-types", "scripts/export-supabase-migrations.ts", "--check"], {
        cwd: join(import.meta.dirname, "../.."),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("transformAuthMigrationForSupabase(): no recrea schema auth ni auth.uid(), sí crea/otorga atiende_app", () => {
    const sourceSql = readFileSync(join(SOURCE_DIR, "0001_extensions_and_auth.sql"), "utf8");
    const transformado = transformAuthMigrationForSupabase(sourceSql);
    expect(findProhibitedObjects(transformado)).toHaveLength(0);
    expect(transformado).toMatch(/create role atiende_app login password/i);
    expect(transformado).toMatch(/grant authenticated to atiende_app/i);
  });

  it("la migración 0001 fuente (local) SÍ contiene la emulación (para que el contraste con la transformada sea real, no un archivo vacío)", () => {
    const sourceSql = readFileSync(join(SOURCE_DIR, "0001_extensions_and_auth.sql"), "utf8");
    expect(findProhibitedObjects(sourceSql).length).toBeGreaterThan(0);
  });
});
