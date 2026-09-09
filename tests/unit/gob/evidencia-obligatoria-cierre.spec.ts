// REQ-OBS-010 (GOB-006, GOB-047): "Cada tarea del backlog se cierra solo con evidencia
// de verificación en verde guardada en `docs/logs/<tarea>/`; intento de marcar una tarea
// `done` sin ese directorio de evidencia es rechazado por el propio flujo de cierre
// (verificado con un caso sin evidencia → cierre bloqueado)." Corre contra directorios
// temporales sintéticos (tareas .md reales + un `docs/logs/` sintético real) -- mismo
// patrón que tests/unit/gob/gate-por-tarea.spec.ts / scope-de-tarea.spec.ts -- nunca
// contra el repo real (que hoy no tiene `tasks/`, ver el propio script).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkEvidenciaObligatoriaCierre,
  parseTaskFrontmatterConEstado,
  tieneEvidenciaNoVacia,
} from "../../../scripts/checks/evidencia-obligatoria-cierre.ts";

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

describe("parseTaskFrontmatterConEstado", () => {
  it("lee id/status del frontmatter", () => {
    const contenido = ["---", "id: REQ-OBS-010", "status: done", "---", "", "# x"].join("\n");
    expect(parseTaskFrontmatterConEstado(contenido)).toEqual({ id: "REQ-OBS-010", status: "done" });
  });

  it("un archivo sin frontmatter devuelve todo null (no lanza)", () => {
    expect(parseTaskFrontmatterConEstado("# solo un título")).toEqual({ id: null, status: null });
  });

  it("sin campo `status` devuelve null, no undefined ni excepción", () => {
    const contenido = ["---", "id: x", "---"].join("\n");
    expect(parseTaskFrontmatterConEstado(contenido).status).toBeNull();
  });
});

describe("tieneEvidenciaNoVacia", () => {
  it("directorio de evidencia inexistente -> false", () => {
    const logsDir = crearDirTemporal("evidencia-logs-");
    expect(tieneEvidenciaNoVacia("REQ-X-001", logsDir)).toBe(false);
  });

  it("directorio de evidencia existe pero está vacío -> false (no cuenta como evidencia)", () => {
    const logsDir = crearDirTemporal("evidencia-logs-");
    mkdirSync(join(logsDir, "REQ-X-002"));
    expect(tieneEvidenciaNoVacia("REQ-X-002", logsDir)).toBe(false);
  });

  it("directorio con un archivo real -> true", () => {
    const logsDir = crearDirTemporal("evidencia-logs-");
    mkdirSync(join(logsDir, "REQ-X-003"));
    writeFileSync(join(logsDir, "REQ-X-003", "vitest-20260908.log"), "1/1 verde\n");
    expect(tieneEvidenciaNoVacia("REQ-X-003", logsDir)).toBe(true);
  });

  it("archivo real solo en una subcarpeta anidada -> true (evidencia en cualquier profundidad)", () => {
    const logsDir = crearDirTemporal("evidencia-logs-");
    mkdirSync(join(logsDir, "REQ-X-004", "sub"), { recursive: true });
    writeFileSync(join(logsDir, "REQ-X-004", "sub", "salida.log"), "ok\n");
    expect(tieneEvidenciaNoVacia("REQ-X-004", logsDir)).toBe(true);
  });

  it("solo subcarpetas vacías anidadas, ningún archivo -> false", () => {
    const logsDir = crearDirTemporal("evidencia-logs-");
    mkdirSync(join(logsDir, "REQ-X-005", "sub-vacia"), { recursive: true });
    expect(tieneEvidenciaNoVacia("REQ-X-005", logsDir)).toBe(false);
  });
});

describe("checkEvidenciaObligatoriaCierre: escenario literal de ACEPTACION.md — 'caso sin evidencia → cierre bloqueado'", () => {
  it("tarea en `done` sin docs/logs/<id>/ -> 1 violación (cierre bloqueado)", () => {
    const tasksDir = crearDirTemporal("evidencia-tasks-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    escribirTarea(tasksDir, "REQ-X-010.md", { id: "REQ-X-010", status: "done" });
    // Deliberadamente NO se crea docs/logs/REQ-X-010/ -- el escenario exacto que
    // REQ-OBS-010 exige que el flujo de cierre bloquee.

    const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.taskId).toBe("REQ-X-010");
    expect(violations[0]!.message).toMatch(/no existe/);
    expect(violations[0]!.message).toContain("docs/logs/REQ-X-010");
  });

  it("mismo caso, pero docs/logs/<id>/ SÍ existe con evidencia real -> 0 violaciones (cierre permitido)", () => {
    const tasksDir = crearDirTemporal("evidencia-tasks-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    escribirTarea(tasksDir, "REQ-X-010.md", { id: "REQ-X-010", status: "done" });
    mkdirSync(join(logsDir, "REQ-X-010"));
    writeFileSync(join(logsDir, "REQ-X-010", "vitest-20260908.log"), "3/3 verde\n");

    const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
    expect(violations).toHaveLength(0);
  });
});

describe("checkEvidenciaObligatoriaCierre: estado `review` también exige evidencia", () => {
  it("tarea en `review` sin evidencia -> violación (el cierre ya se presenta como hecho antes de `done`)", () => {
    const tasksDir = crearDirTemporal("evidencia-tasks-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    escribirTarea(tasksDir, "REQ-X-011.md", { id: "REQ-X-011", status: "review" });

    const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
    expect(violations).toHaveLength(1);
  });

  it("tarea en `review` con directorio de evidencia VACÍO -> violación distinta (existe pero vacío, no cuenta)", () => {
    const tasksDir = crearDirTemporal("evidencia-tasks-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    escribirTarea(tasksDir, "REQ-X-012.md", { id: "REQ-X-012", status: "review" });
    mkdirSync(join(logsDir, "REQ-X-012"));

    const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/VACÍO/);
  });
});

describe("checkEvidenciaObligatoriaCierre: estados que todavía no se están cerrando no exigen evidencia", () => {
  for (const status of ["draft", "ready", "doing", "blocked", "needs-human"]) {
    it(`tarea en \`${status}\` sin docs/logs/ -> 0 violaciones (aún no se cierra)`, () => {
      const tasksDir = crearDirTemporal("evidencia-tasks-");
      const logsDir = crearDirTemporal("evidencia-logs-");
      escribirTarea(tasksDir, "REQ-X-020.md", { id: "REQ-X-020", status });

      const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
      expect(violations).toHaveLength(0);
    });
  }

  it("tarea sin `status` en absoluto -> 0 violaciones (no se puede exigir cierre de lo que no tiene estado)", () => {
    const tasksDir = crearDirTemporal("evidencia-tasks-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    escribirTarea(tasksDir, "REQ-X-021.md", { id: "REQ-X-021" });

    const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
    expect(violations).toHaveLength(0);
  });
});

describe("checkEvidenciaObligatoriaCierre: tarea cerrada sin `id` declarado", () => {
  it("status `done` sin `id` -> violación explícita (no se cae en silencio, no hay dir que resolver)", () => {
    const tasksDir = crearDirTemporal("evidencia-tasks-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    escribirTarea(tasksDir, "sin-id.md", { status: "done" });

    const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toMatch(/no declara `id`/);
  });
});

describe("checkEvidenciaObligatoriaCierre: comportamiento agregado y de entorno", () => {
  it("varias tareas en subcarpetas (tasks/hotel/**) se revisan todas, violaciones se acumulan", () => {
    const tasksDir = crearDirTemporal("evidencia-tasks-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    mkdirSync(join(tasksDir, "hotel"), { recursive: true });
    escribirTarea(join(tasksDir, "hotel"), "REQ-X-030.md", { id: "REQ-X-030", status: "done" });
    escribirTarea(tasksDir, "REQ-X-031.md", { id: "REQ-X-031", status: "review" });
    mkdirSync(join(logsDir, "REQ-X-031"));
    writeFileSync(join(logsDir, "REQ-X-031", "ok.log"), "ok\n");

    const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.taskId).toBe("REQ-X-030");
  });

  it("ignora `_template.md`", () => {
    const tasksDir = crearDirTemporal("evidencia-tasks-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    escribirTarea(tasksDir, "_template.md", { id: "PLANTILLA", status: "done" });

    const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
    expect(violations).toHaveLength(0);
  });

  it("`tasks/` inexistente -> 0 violaciones (nada que verificar, no falla)", () => {
    const root = crearDirTemporal("evidencia-root-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    const violations = checkEvidenciaObligatoriaCierre(join(root, "tasks-que-no-existe"), root, logsDir);
    expect(violations).toHaveLength(0);
  });

  it("`tasks/` existe pero sin ninguna tarea `done`/`review` -> 0 violaciones", () => {
    const tasksDir = crearDirTemporal("evidencia-tasks-");
    const logsDir = crearDirTemporal("evidencia-logs-");
    escribirTarea(tasksDir, "REQ-X-040.md", { id: "REQ-X-040", status: "ready" });

    const violations = checkEvidenciaObligatoriaCierre(tasksDir, tasksDir, logsDir);
    expect(violations).toHaveLength(0);
  });
});

describe("checkEvidenciaObligatoriaCierre: contra el repo real (sin overrides)", () => {
  it("corre contra `tasks/`/`docs/logs/` reales del repo sin lanzar, y pasa en vacío honesto si `tasks/` no existe todavía", () => {
    // Sin pasar tasksDir/relativeTo/logsDir -> usa los defaults reales del repo (mismo
    // patrón que la prueba equivalente de REQ-AGT-018/registro-unico-conectores). Hoy
    // `tasks/` no existe en este repo (GOB-045 aún no materializado) -- por eso 0
    // violaciones aquí es "vacío honesto", no "se buscó mal": la cobertura real de la
    // lógica está en los `describe` de arriba, contra fixtures sintéticas.
    expect(() => checkEvidenciaObligatoriaCierre()).not.toThrow();
    expect(checkEvidenciaObligatoriaCierre()).toEqual([]);
  });
});
