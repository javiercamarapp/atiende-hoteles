// REQ-GOB-009 (GOB-058): "Nunca se ejecutan comandos destructivos/productivos por el
// agente (`supabase db push`, `git push --force`); esas acciones son exclusivas de CI
// o del fundador." Corre contra directorios temporales sintéticos -- nunca contra el
// repo real (mismo patrón que tests/unit/check-migraciones.spec.ts), para no depender
// de ni poder romper el estado real del repo.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkNoComandosDestructivos } from "../../../scripts/checks/no-comandos-destructivos-agente.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "no-comandos-destructivos-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("checkNoComandosDestructivos", () => {
  it("detecta 'supabase db push' fuera de comentario", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "deploy.sh"), "#!/bin/sh\nsupabase db push\n");
    const violations = checkNoComandosDestructivos([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.pattern).toBe("supabase db push");
  });

  it("detecta 'git push --force' y 'git push -f' fuera de comentario", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "a.sh"), "git push origin main --force\n");
    writeFileSync(join(root, "b.sh"), "git push origin main -f\n");
    const violations = checkNoComandosDestructivos([root], root);
    expect(violations.map((v) => v.file).sort()).toEqual(["a.sh", "b.sh"]);
  });

  it("detecta 'git push --force-with-lease' como su propio patrón (no lo cuenta dos veces)", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "a.sh"), "git push origin main --force-with-lease\n");
    const violations = checkNoComandosDestructivos([root], root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.pattern).toBe("git push --force-with-lease");
  });

  it("NO marca una línea de comentario que solo discute la regla", () => {
    const root = crearDirTemporal();
    writeFileSync(
      root + "/README-ish.ts",
      "// nunca ejecutar `supabase db push` ni `git push --force` desde el agente\n" +
        "# tampoco desde un script de shell comentado: git push --force\n",
    );
    const violations = checkNoComandosDestructivos([root], root);
    expect(violations).toHaveLength(0);
  });

  it("ignora .github/workflows (dominio exclusivo de CI)", () => {
    const root = crearDirTemporal();
    const workflowsDir = join(root, ".github", "workflows");
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, "release.yml"), "run: git push --force origin gh-pages\n");
    const violations = checkNoComandosDestructivos([root], root);
    expect(violations).toHaveLength(0);
  });

  it("NO produce falsos positivos con banderas '-f' de otros comandos (no son 'git push')", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "curl.sh"), "curl -f https://example.com\ndocker build -f Dockerfile .\n");
    const violations = checkNoComandosDestructivos([root], root);
    expect(violations).toHaveLength(0);
  });

  it("un repo limpio (sin comandos prohibidos) no produce violaciones", () => {
    const root = crearDirTemporal();
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }));
    const violations = checkNoComandosDestructivos([root], root);
    expect(violations).toHaveLength(0);
  });
});
