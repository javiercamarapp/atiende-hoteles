// REQ-GOB-014 (GOB-049, BP-136): "Debe existir un archivo de foco (`FOCUS.md`) por
// fase/línea que fije la fase vigente y los módulos abiertos; el flujo de
// planificación solo debe abrir tareas del foco vigente" -- verificado con:
// (1) `parseFocusFile`/`renderFocusFile` (round-trip) sobre contenido sintético, y
// (2) una tarea fuera del foco vigente → no seleccionable, ejercitando el `FOCUS.md`
// REAL del repo (`docs/FOCUS.md`) contra `selectNextTask` (REQ-GOB-001), no solo un
// array de módulos inventado para la prueba.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidFocusFileError,
  createBacklogTask,
  parseFocusFile,
  renderFocusFile,
  selectNextTask,
  transitionBacklogTask,
  type BacklogTask,
} from "../../../packages/agent-core/src/backlog/backlogStateMachine.ts";

function tareaReady(overrides: Partial<Parameters<typeof createBacklogTask>[0]> = {}): BacklogTask {
  const t = createBacklogTask({
    id: "t-001",
    title: "Tarea de prueba",
    module: "REC",
    orden: 1,
    estimacionHoras: 2,
    gate: "none",
    ...overrides,
  });
  return transitionBacklogTask(t, "ready");
}

describe("parseFocusFile (REQ-GOB-014): lee phase/openModules del frontmatter", () => {
  it("parsea un FOCUS.md válido con 1 módulo abierto", () => {
    const contenido = ["---", "phase: H4", "openModules: RES", "---", "", "# Foco H4", ""].join("\n");
    expect(parseFocusFile(contenido)).toEqual({ phase: "H4", openModules: ["RES"] });
  });

  it("parsea varios módulos separados por coma, recortando espacios", () => {
    const contenido = ["---", "phase: cierre-p0", "openModules: REC,  HUE ,GOB", "---", ""].join("\n");
    expect(parseFocusFile(contenido)).toEqual({ phase: "cierre-p0", openModules: ["REC", "HUE", "GOB"] });
  });

  it("ignora el cuerpo Markdown libre bajo el frontmatter", () => {
    const contenido = ["---", "phase: H4", "openModules: RES", "---", "", "# Título", "", "Cuerpo con **markdown** libre.", ""].join(
      "\n",
    );
    expect(parseFocusFile(contenido)).toEqual({ phase: "H4", openModules: ["RES"] });
  });

  it("rechaza contenido sin frontmatter", () => {
    expect(() => parseFocusFile("# Foco sin frontmatter\n")).toThrow(InvalidFocusFileError);
  });

  it("rechaza frontmatter sin phase", () => {
    const contenido = ["---", "openModules: RES", "---", ""].join("\n");
    expect(() => parseFocusFile(contenido)).toThrow(/falta "phase"/);
  });

  it("rechaza frontmatter con phase en blanco", () => {
    const contenido = ["---", "phase:    ", "openModules: RES", "---", ""].join("\n");
    expect(() => parseFocusFile(contenido)).toThrow(/falta "phase"/);
  });

  it("rechaza frontmatter sin openModules", () => {
    const contenido = ["---", "phase: H4", "---", ""].join("\n");
    expect(() => parseFocusFile(contenido)).toThrow(/openModules.*vacío/);
  });

  it("rechaza openModules vacío tras quitar comas/espacios (ej. \"openModules: , ,\")", () => {
    const contenido = ["---", "phase: H4", "openModules: , ,", "---", ""].join("\n");
    expect(() => parseFocusFile(contenido)).toThrow(/openModules.*vacío/);
  });
});

describe("renderFocusFile (REQ-GOB-014): round-trip con parseFocusFile", () => {
  it("genera un frontmatter que parseFocusFile vuelve a leer idéntico", () => {
    const original = { phase: "cierre-p0", openModules: ["REC", "GOB", "SEG"] };
    const renderizado = renderFocusFile(original);
    expect(parseFocusFile(renderizado)).toEqual(original);
  });

  it("conserva un body explícito y sigue siendo parseable", () => {
    const original = { phase: "H4", openModules: ["RES"] };
    const renderizado = renderFocusFile(original, "# Foco H4\n\nJustificación de prueba.");
    expect(renderizado).toContain("Justificación de prueba.");
    expect(parseFocusFile(renderizado)).toEqual(original);
  });

  it("sin body explícito, genera un encabezado por defecto y sigue siendo parseable", () => {
    const original = { phase: "H4", openModules: ["RES"] };
    const renderizado = renderFocusFile(original);
    expect(renderizado).toContain("# Foco vigente: H4");
    expect(parseFocusFile(renderizado)).toEqual(original);
  });
});

describe("selectNextTask + FOCUS.md (REQ-GOB-014 x REQ-GOB-001): solo abre tareas del foco vigente", () => {
  it("una tarea de un módulo fuera de un FOCUS.md sintético queda excluida aunque tenga menor orden", () => {
    const focus = parseFocusFile(["---", "phase: H4", "openModules: RES", "---", ""].join("\n"));

    const fueraDeFoco = tareaReady({ id: "a", orden: 1, module: "BO" }); // BO no está en el foco
    const dentroDeFoco = tareaReady({ id: "b", orden: 9, module: "RES" });

    const seleccionada = selectNextTask([fueraDeFoco, dentroDeFoco], focus.openModules);

    expect(seleccionada!.id).toBe("b");
    expect(seleccionada!.status).toBe("doing");
  });

  it("con foco de varios módulos, una tarea de un módulo no listado sigue excluida", () => {
    const focus = parseFocusFile(["---", "phase: cierre-p0", "openModules: REC, GOB", "---", ""].join("\n"));

    const fueraDeFoco = tareaReady({ id: "a", orden: 0, module: "HK" }); // HK no está en el foco
    const dentroDeFoco1 = tareaReady({ id: "b", orden: 5, module: "REC" });
    const dentroDeFoco2 = tareaReady({ id: "c", orden: 6, module: "GOB" });

    const seleccionada = selectNextTask([fueraDeFoco, dentroDeFoco1, dentroDeFoco2], focus.openModules);

    expect(seleccionada!.id).toBe("b"); // menor orden entre las 2 SÍ dentro del foco
  });

  it("si ningún módulo del backlog está en el foco vigente, no selecciona nada", () => {
    const focus = parseFocusFile(["---", "phase: H4", "openModules: RES", "---", ""].join("\n"));
    const fueraDeFoco = tareaReady({ id: "a", module: "BO" });

    expect(selectNextTask([fueraDeFoco], focus.openModules)).toBeNull();
  });
});

describe("docs/FOCUS.md real del repo (REQ-GOB-014): existe y parsea sin overrides", () => {
  const rutaFocus = join(import.meta.dirname, "..", "..", "..", "docs", "FOCUS.md");

  it("el archivo existe y parseFocusFile lo lee sin lanzar", () => {
    const contenido = readFileSync(rutaFocus, "utf8");
    const focus = parseFocusFile(contenido);

    expect(focus.phase.length).toBeGreaterThan(0);
    expect(focus.openModules.length).toBeGreaterThan(0);
  });

  it("cada módulo abierto es uno de los 16 códigos canónicos de docs/REQUISITOS.md (§3.1-3.16)", () => {
    const MODULOS_CANONICOS = [
      "TEN",
      "RES",
      "HUE",
      "REC",
      "HK",
      "AB",
      "REV",
      "CRM",
      "BO",
      "AGT",
      "INT",
      "SEG",
      "OBS",
      "UX",
      "QA",
      "GOB",
    ];
    const focus = parseFocusFile(readFileSync(rutaFocus, "utf8"));

    for (const modulo of focus.openModules) {
      expect(MODULOS_CANONICOS).toContain(modulo);
    }
  });

  it("una tarea de un módulo inventado (fuera del catálogo, y por tanto fuera de cualquier foco real) queda excluida por selectNextTask", () => {
    const focus = parseFocusFile(readFileSync(rutaFocus, "utf8"));

    const moduloInventado = "ZZZ-NO-EXISTE";
    expect(focus.openModules).not.toContain(moduloInventado);

    const fueraDeFoco = tareaReady({ id: "a", orden: 0, module: moduloInventado });
    const dentroDeFoco = tareaReady({ id: "b", orden: 99, module: focus.openModules[0]! });

    const seleccionada = selectNextTask([fueraDeFoco, dentroDeFoco], focus.openModules);

    expect(seleccionada!.id).toBe("b");
  });
});
