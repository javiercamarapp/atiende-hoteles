// auditoria-2/arquitectura [ALTO]: "la documentación-en-código declara
// --experimental-strip-types como el runtime real de apps/api pero el código ya usa
// --experimental-transform-types". Esta prueba fija el contrato de
// scripts/check-runtime-flags.ts contra directorios temporales sintéticos -- nunca
// contra el repo real, para poder simular libremente el caso "divergió" sin depender
// de que el estado real del repo lo esté (o deje de estarlo).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRuntimeFlags } from "../../scripts/check-runtime-flags.ts";

let dir: string | null = null;

function crearRepoSintetico(devScriptFlag: "strip" | "transform"): string {
  dir = mkdtempSync(join(tmpdir(), "check-runtime-flags-"));
  mkdirSync(join(dir, "apps/api"), { recursive: true });
  const flag = devScriptFlag === "strip" ? "--experimental-strip-types" : "--experimental-transform-types";
  writeFileSync(
    join(dir, "apps/api/package.json"),
    JSON.stringify({ scripts: { dev: `node ${flag} src/server.ts`, start: `node ${flag} src/server.ts` } }),
  );
  return dir;
}

function escribir(root: string, relPath: string, content: string) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("checkRuntimeFlags", () => {
  it("todos los archivos mencionan el flag real (transform): OK", () => {
    const root = crearRepoSintetico("transform");
    escribir(root, "apps/api/README.md", "el runtime real de apps/api usa --experimental-transform-types");
    const result = checkRuntimeFlags(root, ["apps/api/README.md"]);
    expect(result.ok).toBe(true);
    expect(result.actualFlag).toBe("transform");
  });

  it("un archivo sigue declarando strip-types como el flag vigente cuando el real es transform: FALLA (regresión exacta del hallazgo real)", () => {
    const root = crearRepoSintetico("transform");
    escribir(
      root,
      "apps/api/README.md",
      "el servidor corre con el type stripping nativo de Node (`node --experimental-strip-types`)",
    );
    const result = checkRuntimeFlags(root, ["apps/api/README.md"]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/documentación desactualizada/);
  });

  it("un archivo menciona el flag viejo PERO también aclara el flag real actual: OK (comentario explicando la diferencia, no una afirmación desactualizada)", () => {
    const root = crearRepoSintetico("transform");
    escribir(
      root,
      "apps/api/README.md",
      "ya NO usa --experimental-strip-types -- el flag real es --experimental-transform-types desde H5",
    );
    const result = checkRuntimeFlags(root, ["apps/api/README.md"]);
    expect(result.ok).toBe(true);
  });

  it("si apps/api/package.json vuelve a --experimental-strip-types, el check exige que los archivos lo reflejen", () => {
    const root = crearRepoSintetico("strip");
    escribir(root, "apps/api/README.md", "runtime real: --experimental-transform-types (desactualizado)");
    const result = checkRuntimeFlags(root, ["apps/api/README.md"]);
    expect(result.ok).toBe(false);
    expect(result.actualFlag).toBe("strip");
  });

  it("un archivo listado que no existe: falla con un mensaje claro, no una excepción sin manejar", () => {
    const root = crearRepoSintetico("transform");
    const result = checkRuntimeFlags(root, ["apps/api/README.md"]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/no se pudo leer/);
  });

  it("archivo sin ninguna mención de flag: falla (comentario relevante removido sin querer)", () => {
    const root = crearRepoSintetico("transform");
    escribir(root, "apps/api/README.md", "este archivo no dice nada sobre node ni tipos.");
    const result = checkRuntimeFlags(root, ["apps/api/README.md"]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/no menciona ningún flag/);
  });

  it("contra el repo real: los archivos que este lote corrigió pasan (regresión de integración)", () => {
    const result = checkRuntimeFlags();
    expect(result.ok).toBe(true);
    expect(result.actualFlag).toBe("transform");
  });
});
