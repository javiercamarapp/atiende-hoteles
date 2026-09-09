// REQ-GOB-004 (GOB-005): "El agente implementa SOLO la tarea asignada; no toca archivos
// fuera del `scope` declarado de la tarea. Test de diff: el diff de la tarea contiene
// únicamente archivos dentro de los `paths`/`scope` declarados en la tarea; cualquier
// archivo fuera de scope hace fallar la revisión." Corre contra directorios temporales
// sintéticos (tareas .md reales) con un diff INYECTADO -- mismo patrón que
// tests/unit/gob/gate-por-tarea.spec.ts -- y, además, un bloque de integración con un
// repositorio git REAL (`git init` + commits reales) para ejercitar
// `obtenerArchivosCambiadosGit` contra el binario git de verdad, nunca un mock del
// diff.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archivoEnScope,
  checkScopeDeTarea,
  obtenerArchivosCambiadosGit,
  parseTaskFrontmatterConScope,
} from "../../../scripts/checks/scope-de-tarea.ts";

let dir: string | null = null;

function crearDirTemporal(): string {
  dir = mkdtempSync(join(tmpdir(), "scope-de-tarea-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function escribirTarea(root: string, nombre: string, frontmatter: Record<string, string>): void {
  const lines = ["---", ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), "---", "", "# tarea de prueba", ""];
  writeFileSync(join(root, nombre), lines.join("\n"));
}

describe("parseTaskFrontmatterConScope", () => {
  it("lee id/status/paths separados por coma", () => {
    const contenido = [
      "---",
      "id: REQ-GOB-004",
      "status: doing",
      "paths: scripts/checks/scope-de-tarea.ts, tests/unit/gob/scope-de-tarea.spec.ts",
      "---",
      "",
      "# x",
    ].join("\n");
    expect(parseTaskFrontmatterConScope(contenido)).toEqual({
      id: "REQ-GOB-004",
      status: "doing",
      paths: ["scripts/checks/scope-de-tarea.ts", "tests/unit/gob/scope-de-tarea.spec.ts"],
    });
  });

  it("un archivo sin frontmatter devuelve todo null/vacío (no lanza)", () => {
    expect(parseTaskFrontmatterConScope("# solo un título")).toEqual({ id: null, status: null, paths: [] });
  });

  it("sin campo `paths` devuelve arreglo vacío, no undefined", () => {
    const contenido = ["---", "id: x", "status: doing", "---"].join("\n");
    expect(parseTaskFrontmatterConScope(contenido).paths).toEqual([]);
  });
});

describe("archivoEnScope", () => {
  it("cubre el archivo exacto declarado", () => {
    expect(archivoEnScope("docs/ACEPTACION.md", ["docs/ACEPTACION.md"])).toBe(true);
  });

  it("cubre archivos dentro de una carpeta declarada sin barra final", () => {
    expect(archivoEnScope("scripts/checks/scope-de-tarea.ts", ["scripts/checks"])).toBe(true);
  });

  it("cubre archivos dentro de una carpeta declarada CON barra final", () => {
    expect(archivoEnScope("scripts/checks/scope-de-tarea.ts", ["scripts/checks/"])).toBe(true);
  });

  it("NO cubre por subcadena cruda -- un archivo con el mismo prefijo textual pero sin límite de segmento real", () => {
    expect(archivoEnScope("docs/ACEPTACION.md.bak", ["docs/ACEPTACION.md"])).toBe(false);
    expect(archivoEnScope("docs/ACEPTACION2.md", ["docs/ACEPTACION"])).toBe(false);
  });

  it("un archivo fuera de todos los paths declarados -> false", () => {
    expect(archivoEnScope("packages/agent-core/src/tool.ts", ["scripts/checks"])).toBe(false);
  });
});

describe("checkScopeDeTarea: escenario literal de ACEPTACION.md — 'diff con un archivo fuera de scope → hallazgo'", () => {
  it("tarea en `doing` con paths declarados, diff toca un archivo fuera de esos paths -> 1 violación (bloquea)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "REQ-GOB-004.md", {
      id: "REQ-GOB-004",
      status: "doing",
      paths: "scripts/checks/scope-de-tarea.ts",
    });

    const violations = checkScopeDeTarea(tasksDir, root, () => [
      "scripts/checks/scope-de-tarea.ts",
      "docs/algo-no-declarado.md",
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.taskId).toBe("REQ-GOB-004");
    expect(violations[0]!.file).toBe("docs/algo-no-declarado.md");
    expect(violations[0]!.message).toContain("fuera del scope declarado");
  });

  it("mismo caso, pero TODO el diff cae dentro de los paths declarados -> 0 violaciones (pasa)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "REQ-GOB-004.md", {
      id: "REQ-GOB-004",
      status: "doing",
      paths: "scripts/checks, tests/unit/gob",
    });

    const violations = checkScopeDeTarea(tasksDir, root, () => [
      "scripts/checks/scope-de-tarea.ts",
      "tests/unit/gob/scope-de-tarea.spec.ts",
    ]);

    expect(violations).toHaveLength(0);
  });
});

describe("checkScopeDeTarea: tarea activa sin `paths` declarado", () => {
  it("status doing sin `paths` -> 1 violación explícita, sin archivo puntual (no se cae en silencio)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0099.md", { id: "H-0099", status: "doing" });

    const violations = checkScopeDeTarea(tasksDir, root, () => ["src/lo-que-sea.ts"]);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.file).toBeNull();
    expect(violations[0]!.message).toMatch(/no declara `paths`/);
  });
});

describe("checkScopeDeTarea: solo `doing`/`review` son revisables", () => {
  it.each(["draft", "ready", "done", "blocked", "needs-human"])(
    "una tarea en status `%s` con diff fuera de scope NO se revisa (fuera de alcance de este check)",
    (status) => {
      const root = crearDirTemporal();
      const tasksDir = join(root, "tasks");
      mkdirSync(tasksDir, { recursive: true });
      escribirTarea(tasksDir, "H-0100.md", { id: "H-0100", status, paths: "src/permitido.ts" });

      const violations = checkScopeDeTarea(tasksDir, root, () => ["src/completamente-fuera-de-scope.ts"]);

      expect(violations).toHaveLength(0);
    },
  );

  it("tarea en `review` SÍ se revisa (el cierre puede seguir sin commitear en el momento del check)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0101.md", { id: "H-0101", status: "review", paths: "src/permitido.ts" });

    const violations = checkScopeDeTarea(tasksDir, root, () => ["src/fuera-de-scope.ts"]);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.taskId).toBe("H-0101");
  });
});

describe("checkScopeDeTarea: la propia tarea no se exime del scope", () => {
  it("la tarea modifica su propio archivo de frontmatter sin declararlo en `paths` -> violación", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0102.md", { id: "H-0102", status: "doing", paths: "src/permitido.ts" });

    const violations = checkScopeDeTarea(tasksDir, root, () => ["tasks/H-0102.md"]);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.file).toBe("tasks/H-0102.md");
  });

  it("declarando explícitamente `tasks/H-0103.md` en `paths` sí lo permite", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0103.md", { id: "H-0103", status: "doing", paths: "src/permitido.ts, tasks/H-0103.md" });

    const violations = checkScopeDeTarea(tasksDir, root, () => ["tasks/H-0103.md"]);

    expect(violations).toHaveLength(0);
  });
});

describe("checkScopeDeTarea: comportamiento agregado y de entorno", () => {
  it("varias tareas activas en subcarpetas se revisan todas, violaciones se acumulan", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(join(tasksDir, "hotel"), { recursive: true });
    escribirTarea(join(tasksDir, "hotel"), "H-0007.md", { id: "H-0007", status: "doing", paths: "src/a.ts" });
    escribirTarea(join(tasksDir, "hotel"), "H-0008.md", { id: "H-0008", status: "review", paths: "src/b.ts" });

    const violations = checkScopeDeTarea(tasksDir, root, () => ["src/a.ts", "src/b.ts", "src/c-fuera-de-ambas.ts"]);

    // Cada tarea activa se revisa de forma independiente contra el diff COMPLETO
    // (el check no puede saber, sin más información, a cuál de las dos tareas
    // "pertenece" cada archivo cuando hay más de una tarea activa a la vez): para
    // H-0007 (paths: src/a.ts) están fuera de scope src/b.ts y src/c-fuera-de-ambas.ts;
    // para H-0008 (paths: src/b.ts) están fuera de scope src/a.ts y
    // src/c-fuera-de-ambas.ts -- 4 hallazgos en total, ninguno se deja pasar en
    // silencio.
    expect(violations).toHaveLength(4);
    expect(violations.filter((v) => v.taskId === "H-0007").map((v) => v.file).sort()).toEqual([
      "src/b.ts",
      "src/c-fuera-de-ambas.ts",
    ]);
    expect(violations.filter((v) => v.taskId === "H-0008").map((v) => v.file).sort()).toEqual([
      "src/a.ts",
      "src/c-fuera-de-ambas.ts",
    ]);
  });

  it("`_template.md` se ignora (es la plantilla, no una tarea real, GOB-045)", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "_template.md", { id: "PLANTILLA", status: "doing" });

    const violations = checkScopeDeTarea(tasksDir, root, () => ["src/lo-que-sea.ts"]);
    expect(violations).toHaveLength(0);
  });

  it("un `tasks/` inexistente (backlog de archivos aún no materializado) no lanza y devuelve 0 violaciones", () => {
    const root = crearDirTemporal();
    const violations = checkScopeDeTarea(join(root, "tasks-que-no-existe"), root, () => ["src/lo-que-sea.ts"]);
    expect(violations).toHaveLength(0);
  });

  it("`tasks/` sin ninguna tarea en doing/review (todas draft/ready/done) -> 0 violaciones, ni siquiera llama a getChangedFiles", () => {
    const root = crearDirTemporal();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "H-0200.md", { id: "H-0200", status: "ready", paths: "src/x.ts" });

    let llamado = false;
    const violations = checkScopeDeTarea(tasksDir, root, () => {
      llamado = true;
      return ["src/fuera-de-cualquier-cosa.ts"];
    });

    expect(violations).toHaveLength(0);
    // Optimización real, no solo cosmética: si no hay ninguna tarea activa, no tiene
    // sentido pagar el costo de invocar git -- ver checkScopeDeTarea.
    expect(llamado).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// Integración con git REAL (nunca un mock del diff): se crea un repositorio git de
// verdad en un directorio temporal, con un commit real, y se ejercita
// `obtenerArchivosCambiadosGit` contra el binario `git` real -- exactamente lo que usa
// el CLI (`node scripts/checks/scope-de-tarea.ts`) en producción cuando no se inyecta
// `getChangedFiles`.
// ---------------------------------------------------------------------------------
function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function initRepoGitReal(root: string): void {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
}

describe("obtenerArchivosCambiadosGit: contra un repositorio git real", () => {
  it("detecta un archivo trackeado modificado y un archivo nuevo sin trackear, ninguno más", () => {
    const root = crearDirTemporal();
    initRepoGitReal(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "// version inicial\n");
    writeFileSync(join(root, "src", "sin-tocar.ts"), "// nunca se modifica\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "chore: commit inicial de la prueba"]);

    // Modifica un archivo trackeado y crea uno nuevo sin trackear.
    writeFileSync(join(root, "src", "a.ts"), "// version modificada\n");
    writeFileSync(join(root, "src", "b-nuevo.ts"), "// archivo nuevo, sin trackear\n");

    const cambiados = obtenerArchivosCambiadosGit(root);

    expect(cambiados).toEqual(["src/a.ts", "src/b-nuevo.ts"]);
  });

  it("un working tree limpio (sin cambios desde HEAD) devuelve arreglo vacío", () => {
    const root = crearDirTemporal();
    initRepoGitReal(root);
    writeFileSync(join(root, "README.md"), "# nada que cambie\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "chore: commit inicial"]);

    expect(obtenerArchivosCambiadosGit(root)).toEqual([]);
  });

  it("checkScopeDeTarea end-to-end contra el repo git real: archivo fuera de scope real -> violación real", () => {
    const root = crearDirTemporal();
    initRepoGitReal(root);
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    escribirTarea(tasksDir, "REQ-X.md", { id: "REQ-X", status: "doing", paths: "src/permitido.ts" });
    writeFileSync(join(root, "src", "permitido.ts"), "// v1\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "chore: estado inicial"]);

    // El agente toca el archivo permitido Y uno fuera de scope.
    writeFileSync(join(root, "src", "permitido.ts"), "// v2, dentro de scope\n");
    writeFileSync(join(root, "src", "no-declarado.ts"), "// fuera de scope\n");

    const violations = checkScopeDeTarea(tasksDir, root);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.file).toBe("src/no-declarado.ts");
    expect(violations[0]!.taskId).toBe("REQ-X");
  });
});
