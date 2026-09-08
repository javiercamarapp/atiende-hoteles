// REQ-GOB-005: "Tarea cerrada tiene verificación en verde con evidencia guardada;
// commit siguiendo Conventional Commits (uno por tarea); estado pasa a `review`; toda
// decisión de diseño no trivial genera un ADR (verificado con una tarea de muestra
// cerrada end-to-end)." Corre contra tareas sintéticas + commits INYECTADOS (mismo
// patrón que tests/unit/gob/scope-de-tarea.spec.ts/gate-por-tarea.spec.ts) y, además, un
// bloque de integración con un repositorio git REAL (`git init` + commits reales) para
// ejercitar `obtenerCommitsGitReal` contra el binario git de verdad, nunca un mock del
// historial -- y un bloque final que verifica end-to-end la tarea de muestra REAL de
// este propio repo (REQ-GOB-004, ya cerrada) contra su commit real.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkCierreTareaConventionalCommits,
  type CommitInfo,
  commitReferenciaTarea,
  commitsDeCierre,
  esConventionalCommit,
  obtenerCommitsGitReal,
  parseTaskFrontmatterConCierre,
} from "../../../scripts/checks/cierre-tarea-conventional-commits.ts";

let dirs: string[] = [];

function crearDirTemporal(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function escribirTarea(root: string, nombre: string, frontmatter: Record<string, string>): void {
  const lines = ["---", ...Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`), "---", "", "# tarea de prueba", ""];
  writeFileSync(join(root, nombre), lines.join("\n"));
}

function commit(hash: string, subject: string, body = ""): CommitInfo {
  return { hash, subject, body };
}

describe("parseTaskFrontmatterConCierre", () => {
  it("lee id/status del frontmatter", () => {
    const contenido = ["---", "id: REQ-GOB-005", "status: review", "---", "", "# x"].join("\n");
    expect(parseTaskFrontmatterConCierre(contenido)).toEqual({ id: "REQ-GOB-005", status: "review" });
  });

  it("un archivo sin frontmatter devuelve todo null (no lanza)", () => {
    expect(parseTaskFrontmatterConCierre("# solo un título")).toEqual({ id: null, status: null });
  });
});

describe("esConventionalCommit", () => {
  it.each([
    "feat(gob): cierra REQ-GOB-004 — verificación de scope de tarea vs. diff real",
    "fix(ci): regenerar package-lock.json para incluir binarios de plataforma",
    "test(adversarial): REQ-AGT-009 — suite de red-teaming",
    "docs: merges B y C de auditoría-2 completados",
    "feat(req-agt-013): guardrail estático de aislamiento OCR",
    "feat!: cambio incompatible con scope omitido",
    "chore(deps): actualiza vitest",
  ])("acepta un asunto real/realista del repo: %s", (subject) => {
    expect(esConventionalCommit(subject)).toBe(true);
  });

  it.each([
    "cierra REQ-GOB-004 sin prefijo de tipo",
    "Feat: tipo con mayúscula no es del catálogo cerrado",
    "feat : espacio antes de los dos puntos rompe el formato",
    "feature(gob): tipo no está en el catálogo cerrado",
    "feat(): scope vacío no es válido",
    "feat:",
    "feat: ",
  ])("rechaza un asunto que no sigue Conventional Commits: %s", (subject) => {
    expect(esConventionalCommit(subject)).toBe(false);
  });
});

describe("commitReferenciaTarea", () => {
  it("empareja el id en el asunto", () => {
    expect(commitReferenciaTarea(commit("h1", "feat(gob): cierra REQ-GOB-004"), "REQ-GOB-004")).toBe(true);
  });

  it("empareja el id en el cuerpo aunque no esté en el asunto", () => {
    expect(commitReferenciaTarea(commit("h1", "feat(gob): cierre de gobierno", "Refs: REQ-GOB-004"), "REQ-GOB-004")).toBe(true);
  });

  it("insensible a mayúsculas (el historial real mezcla REQ-AGT-013/req-agt-013)", () => {
    expect(commitReferenciaTarea(commit("h1", "feat(req-agt-013): guardrail"), "REQ-AGT-013")).toBe(true);
  });

  it("NO empareja por subcadena cruda: REQ-GOB-5 no debe emparejar REQ-GOB-50", () => {
    expect(commitReferenciaTarea(commit("h1", "feat: cierra REQ-GOB-50"), "REQ-GOB-5")).toBe(false);
  });

  it("NO empareja REQ-GOB-5 dentro de REQ-GOB-5A", () => {
    expect(commitReferenciaTarea(commit("h1", "feat: cierra REQ-GOB-5A"), "REQ-GOB-5")).toBe(false);
  });

  it("un commit que no menciona el id en absoluto -> false", () => {
    expect(commitReferenciaTarea(commit("h1", "chore: limpieza general"), "REQ-GOB-004")).toBe(false);
  });
});

describe("commitsDeCierre", () => {
  it("devuelve todos los commits que referencian el id, en cualquier orden de la lista", () => {
    const commits = [
      commit("a", "chore: no relacionado"),
      commit("b", "feat(gob): cierra REQ-GOB-004"),
      commit("c", "fix(gob): sigue tocando REQ-GOB-004 después"),
    ];
    expect(commitsDeCierre("REQ-GOB-004", commits).map((c) => c.hash)).toEqual(["b", "c"]);
  });

  it("0 commits referencian el id -> arreglo vacío", () => {
    expect(commitsDeCierre("REQ-GOB-999", [commit("a", "chore: nada")])).toEqual([]);
  });
});

describe("checkCierreTareaConventionalCommits: escenario literal de ACEPTACION.md — 'un commit por tarea'", () => {
  it("tarea en `review` con EXACTAMENTE 1 commit real en formato Conventional Commits -> 0 violaciones", () => {
    const tasksDir = crearDirTemporal("cierre-tasks-");
    escribirTarea(tasksDir, "REQ-X-100.md", { id: "REQ-X-100", status: "review" });

    const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => [
      commit("aaa1111", "feat(gob): cierra REQ-X-100 — implementación real"),
    ]);

    expect(violations).toHaveLength(0);
  });

  it("tarea en `done` con 0 commits que la referencien -> 1 violación (cierre sin commit real)", () => {
    const tasksDir = crearDirTemporal("cierre-tasks-");
    escribirTarea(tasksDir, "REQ-X-101.md", { id: "REQ-X-101", status: "done" });

    const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => [commit("aaa1111", "chore: algo distinto")]);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.taskId).toBe("REQ-X-101");
    expect(violations[0]!.message).toMatch(/0 commits/);
  });

  it("tarea con 2 commits que la referencian -> 1 violación ('uno por tarea' no se cumple, ambigüedad)", () => {
    const tasksDir = crearDirTemporal("cierre-tasks-");
    escribirTarea(tasksDir, "REQ-X-102.md", { id: "REQ-X-102", status: "review" });

    const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => [
      commit("aaa1111", "feat(gob): primer intento de REQ-X-102"),
      commit("bbb2222", "fix(gob): corrige REQ-X-102"),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/2 commits/);
    expect(violations[0]!.message).toContain("aaa1111");
    expect(violations[0]!.message).toContain("bbb2222");
  });

  it("tarea con exactamente 1 commit que la referencia, pero SIN formato Conventional Commits -> 1 violación", () => {
    const tasksDir = crearDirTemporal("cierre-tasks-");
    escribirTarea(tasksDir, "REQ-X-103.md", { id: "REQ-X-103", status: "review" });

    const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => [
      commit("aaa1111", "cierra REQ-X-103 sin prefijo de tipo convencional"),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/no sigue Conventional Commits/);
    expect(violations[0]!.message).toContain("aaa1111");
  });
});

describe("checkCierreTareaConventionalCommits: tarea cerrada sin `id` declarado", () => {
  it("status `done` sin `id` -> violación explícita, no se cae en silencio", () => {
    const tasksDir = crearDirTemporal("cierre-tasks-");
    escribirTarea(tasksDir, "sin-id.md", { status: "done" });

    const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => []);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/no declara `id`/);
  });
});

describe("checkCierreTareaConventionalCommits: solo `review`/`done` exigen commit de cierre", () => {
  it.each(["draft", "ready", "doing", "blocked", "needs-human"])(
    "tarea en status `%s` sin ningún commit que la referencie -> 0 violaciones (aún no se cierra)",
    (status) => {
      const tasksDir = crearDirTemporal("cierre-tasks-");
      escribirTarea(tasksDir, "REQ-X-110.md", { id: "REQ-X-110", status });

      const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => []);

      expect(violations).toHaveLength(0);
    },
  );

  it("tarea sin `status` en absoluto -> 0 violaciones", () => {
    const tasksDir = crearDirTemporal("cierre-tasks-");
    escribirTarea(tasksDir, "REQ-X-111.md", { id: "REQ-X-111" });

    const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => []);
    expect(violations).toHaveLength(0);
  });
});

describe("checkCierreTareaConventionalCommits: comportamiento agregado y de entorno", () => {
  it("varias tareas cerradas se revisan todas, violaciones se acumulan de forma independiente", () => {
    const tasksDir = crearDirTemporal("cierre-tasks-");
    mkdirSync(join(tasksDir, "hotel"), { recursive: true });
    escribirTarea(join(tasksDir, "hotel"), "REQ-X-120.md", { id: "REQ-X-120", status: "done" });
    escribirTarea(tasksDir, "REQ-X-121.md", { id: "REQ-X-121", status: "review" });

    const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => [
      commit("aaa1111", "feat(gob): cierra REQ-X-121"),
      // REQ-X-120 no tiene ningún commit -> violación; REQ-X-121 sí y en formato válido.
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.taskId).toBe("REQ-X-120");
  });

  it("`_template.md` se ignora (es la plantilla, no una tarea real, GOB-045)", () => {
    const tasksDir = crearDirTemporal("cierre-tasks-");
    escribirTarea(tasksDir, "_template.md", { id: "PLANTILLA", status: "done" });

    const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => []);
    expect(violations).toHaveLength(0);
  });

  it("un `tasks/` inexistente (backlog de archivos aún no materializado) no lanza y devuelve 0 violaciones", () => {
    const root = crearDirTemporal("cierre-root-");
    const violations = checkCierreTareaConventionalCommits(join(root, "tasks-que-no-existe"), root, () => []);
    expect(violations).toHaveLength(0);
  });

  it("`tasks/` sin ninguna tarea en review/done -> 0 violaciones, ni siquiera invoca getCommits", () => {
    const tasksDir = crearDirTemporal("cierre-tasks-");
    escribirTarea(tasksDir, "REQ-X-130.md", { id: "REQ-X-130", status: "ready" });

    let llamado = false;
    const violations = checkCierreTareaConventionalCommits(tasksDir, tasksDir, () => {
      llamado = true;
      return [];
    });

    expect(violations).toHaveLength(0);
    // Optimización real, no solo cosmética: si no hay ninguna tarea cerrada, no tiene
    // sentido pagar el costo de invocar git -- mismo patrón que checkScopeDeTarea.
    expect(llamado).toBe(false);
  });
});

// ---------------------------------------------------------------------------------
// Integración con git REAL (nunca un mock del historial): se crea un repositorio git de
// verdad en un directorio temporal, con commits reales, y se ejercita
// `obtenerCommitsGitReal` contra el binario `git` real -- exactamente lo que usa el CLI
// (`node scripts/checks/cierre-tarea-conventional-commits.ts`) en producción cuando no
// se inyecta `getCommits`.
// ---------------------------------------------------------------------------------
function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function initRepoGitReal(root: string): void {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
}

describe("obtenerCommitsGitReal: contra un repositorio git real", () => {
  it("lee hash/asunto/cuerpo de commits reales, en orden de git log (más reciente primero)", () => {
    const root = crearDirTemporal("cierre-repo-");
    initRepoGitReal(root);
    writeFileSync(join(root, "a.txt"), "1\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "chore: primer commit"]);
    writeFileSync(join(root, "a.txt"), "2\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "feat(gob): cierra REQ-X-200", "-m", "Cuerpo con más detalle."]);

    const commits = obtenerCommitsGitReal(root);

    expect(commits).toHaveLength(2);
    expect(commits[0]!.subject).toBe("feat(gob): cierra REQ-X-200");
    expect(commits[0]!.body).toContain("Cuerpo con más detalle.");
    expect(commits[1]!.subject).toBe("chore: primer commit");
  });

  it("un repositorio git recién inicializado sin ningún commit -> arreglo vacío (no lanza)", () => {
    const root = crearDirTemporal("cierre-repo-");
    initRepoGitReal(root);
    expect(obtenerCommitsGitReal(root)).toEqual([]);
  });

  it("checkCierreTareaConventionalCommits end-to-end contra el repo git real: tarea con su commit real -> 0 violaciones", () => {
    const root = crearDirTemporal("cierre-repo-");
    initRepoGitReal(root);
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(root, "src.ts"), "// v1\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "chore: estado inicial"]);

    writeFileSync(join(root, "src.ts"), "// v2\n");
    escribirTarea(tasksDir, "REQ-X-201.md", { id: "REQ-X-201", status: "review" });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "feat(hotel): cierra REQ-X-201 — implementación real"]);

    const violations = checkCierreTareaConventionalCommits(tasksDir, root);
    expect(violations).toHaveLength(0);
  });

  it("checkCierreTareaConventionalCommits end-to-end: commit real que NO sigue Conventional Commits -> violación real", () => {
    const root = crearDirTemporal("cierre-repo-");
    initRepoGitReal(root);
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    escribirTarea(tasksDir, "REQ-X-202.md", { id: "REQ-X-202", status: "done" });
    git(root, ["add", "-A"]);
    // Mensaje deliberadamente sin tipo de Conventional Commits.
    git(root, ["commit", "-m", "arreglos varios para REQ-X-202"]);

    const violations = checkCierreTareaConventionalCommits(tasksDir, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/no sigue Conventional Commits/);
  });
});

// ---------------------------------------------------------------------------------
// Verificación end-to-end contra una tarea de MUESTRA REAL de este propio repo
// (REQ-GOB-004, ya cerrada por el commit real `ead57d3` -- ver `git log --oneline`):
// exactamente el escenario que el criterio de REQ-GOB-005 exige ("verificado con una
// tarea de muestra cerrada end-to-end"). Se inyecta SOLO el archivo de tarea (una
// fixture temporal, nunca escrita bajo `tasks/` real -- ese directorio no existe todavía
// en este repo) contra el historial REAL de git de este repositorio (sin inyectar
// commits), confirmando que el commit real de cierre de REQ-GOB-004 (a) existe, (b) es
// único, y (c) cumple Conventional Commits -- sin ningún mock del historial.
// ---------------------------------------------------------------------------------
describe("checkCierreTareaConventionalCommits: tarea de muestra REAL ya cerrada de este repo (REQ-GOB-004)", () => {
  it("REQ-GOB-004 (cerrada por el commit real ead57d3) -> 0 violaciones contra el git log real de este repo", () => {
    const tasksDir = crearDirTemporal("cierre-muestra-real-");
    escribirTarea(tasksDir, "REQ-GOB-004.md", { id: "REQ-GOB-004", status: "review" });

    // repoRoot por defecto (ROOT del script) -> lee el git log REAL de este repositorio,
    // no un repo sintético; solo el directorio de tareas es temporal.
    const violations = checkCierreTareaConventionalCommits(tasksDir);

    expect(violations).toHaveLength(0);
  });

  it("una tarea de muestra que NUNCA se cerró en este repo (id inventado) -> violación real de '0 commits'", () => {
    const tasksDir = crearDirTemporal("cierre-muestra-real-");
    escribirTarea(tasksDir, "REQ-GOB-990.md", { id: "REQ-GOB-990", status: "review" });

    const violations = checkCierreTareaConventionalCommits(tasksDir);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.taskId).toBe("REQ-GOB-990");
    expect(violations[0]!.message).toMatch(/0 commits/);
  });
});

describe("checkCierreTareaConventionalCommits: contra el repo real (sin overrides)", () => {
  it("corre contra `tasks/` real sin lanzar, y pasa en vacío honesto si `tasks/` no existe todavía", () => {
    // Sin pasar tasksDir/relativeTo/getCommits -> usa los defaults reales del repo
    // (mismo patrón que evidencia-obligatoria-cierre/gate-por-tarea). Hoy `tasks/` no
    // existe en este repo (GOB-045 aún no materializado) -- 0 violaciones aquí es
    // "vacío honesto", no "se buscó mal": la cobertura real de la lógica está en los
    // `describe` de arriba, contra fixtures sintéticas y contra el git log real.
    expect(() => checkCierreTareaConventionalCommits()).not.toThrow();
    expect(checkCierreTareaConventionalCommits()).toEqual([]);
  });
});
