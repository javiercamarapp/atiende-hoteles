// REQ-GOB-001 (GOB-001/GOB-046/GOB-049): "Selección de siguiente tarea filtra `ready`,
// sin dependencias abiertas, dentro del módulo del `FOCUS.md` vigente, por menor
// `orden` (empate→menor estimación), y la mueve a `doing`" -- verificado con backlog
// sintético de 3 tareas y el orden de selección resultante (criterio de ACEPTACION.md).
//
// El `FOCUS.md` real (qué módulos están abiertos en la fase vigente) es el archivo que
// produce/lee REQ-GOB-014 (todavía pendiente); aquí se modela como el arreglo
// `openModules` que ese flujo resolvería, sin inventar un formato de archivo que no es
// responsabilidad de esta tarea.
import { describe, expect, it } from "vitest";
import { createBacklogTask, selectNextTask, transitionBacklogTask, type BacklogTask } from "../../../packages/agent-core/src/backlog/backlogStateMachine.ts";

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

describe("selectNextTask (REQ-GOB-001): backlog sintético de 3 tareas", () => {
  it("de 3 tareas ready del mismo módulo abierto, selecciona la de menor orden y la mueve a doing", () => {
    const a = tareaReady({ id: "a", orden: 5 });
    const b = tareaReady({ id: "b", orden: 2 }); // menor orden -> debe ganar
    const c = tareaReady({ id: "c", orden: 8 });

    const seleccionada = selectNextTask([a, b, c], ["REC"]);

    expect(seleccionada).not.toBeNull();
    expect(seleccionada!.id).toBe("b");
    expect(seleccionada!.status).toBe("doing"); // "la mueve a doing", no solo la identifica
  });

  it("no muta las tareas originales del backlog (la transición devuelve una copia)", () => {
    const a = tareaReady({ id: "a", orden: 1 });
    const b = tareaReady({ id: "b", orden: 2 });

    selectNextTask([a, b], ["REC"]);

    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
  });

  it("empate en orden -> gana la de menor estimacionHoras", () => {
    const a = tareaReady({ id: "a", orden: 1, estimacionHoras: 4 });
    const b = tareaReady({ id: "b", orden: 1, estimacionHoras: 1 }); // menor estimación -> gana

    const seleccionada = selectNextTask([a, b], ["REC"]);

    expect(seleccionada!.id).toBe("b");
  });

  it("ignora tareas que no están en estado ready aunque tengan menor orden", () => {
    const draft = createBacklogTask({ id: "d", title: "x", module: "REC", orden: 0, estimacionHoras: 1, gate: "none" }); // orden mínimo, pero sigue en draft
    const doing = transitionBacklogTask(tareaReady({ id: "e", orden: 0 }), "doing");
    const ready = tareaReady({ id: "f", orden: 3 });

    const seleccionada = selectNextTask([draft, doing, ready], ["REC"]);

    expect(seleccionada!.id).toBe("f");
  });

  it("una tarea ready con una dependencia abierta (no done) queda excluida aunque tenga menor orden", () => {
    // dep-1 está "doing" (no "done" todavía) y por tanto NO es ella misma seleccionable
    // ni cuenta como dependencia resuelta.
    const dependenciaSinTerminar = transitionBacklogTask(tareaReady({ id: "dep-1", orden: 0 }), "doing");
    const conDependenciaAbierta = tareaReady({ id: "a", orden: 1, dependencies: ["dep-1"] });
    const sinDependencias = tareaReady({ id: "b", orden: 9 });

    const seleccionada = selectNextTask([dependenciaSinTerminar, conDependenciaAbierta, sinDependencias], ["REC"]);

    expect(seleccionada!.id).toBe("b"); // "a" queda fuera pese a orden=1 < orden=9
  });

  it("una tarea cuya dependencia está done SÍ es seleccionable", () => {
    let dep = tareaReady({ id: "dep-1", orden: 0 });
    dep = transitionBacklogTask(dep, "doing");
    dep = transitionBacklogTask(dep, "review");
    dep = transitionBacklogTask(dep, "done");

    const conDependenciaResuelta = tareaReady({ id: "a", orden: 1, dependencies: ["dep-1"] });

    const seleccionada = selectNextTask([dep, conDependenciaResuelta], ["REC"]);

    expect(seleccionada!.id).toBe("a");
  });

  it("una dependencia declarada que no existe en el backlog dado se trata como abierta (nunca se asume resuelta)", () => {
    const conDependenciaFantasma = tareaReady({ id: "a", orden: 1, dependencies: ["no-existe"] });
    const sinDependencias = tareaReady({ id: "b", orden: 9 });

    const seleccionada = selectNextTask([conDependenciaFantasma, sinDependencias], ["REC"]);

    expect(seleccionada!.id).toBe("b");
  });

  it("una tarea ready de un módulo fuera del FOCUS.md vigente queda excluida aunque tenga menor orden", () => {
    const fueraDeFoco = tareaReady({ id: "a", orden: 1, module: "BO" }); // BO no está en openModules
    const dentroDeFoco = tareaReady({ id: "b", orden: 9, module: "REC" });

    const seleccionada = selectNextTask([fueraDeFoco, dentroDeFoco], ["REC"]);

    expect(seleccionada!.id).toBe("b");
  });

  it("backlog sintético de 3 tareas combinando los 3 filtros: solo una sobrevive y es la seleccionada", () => {
    const dep = transitionBacklogTask(tareaReady({ id: "dep-1", orden: 0 }), "doing"); // no done -> bloquea a quien dependa de ella, y no es ella misma seleccionable
    const bloqueadaPorDependencia = tareaReady({ id: "a", orden: 1, module: "REC", dependencies: ["dep-1"] });
    const fueraDeFoco = tareaReady({ id: "b", orden: 2, module: "BO" });
    const unicaSeleccionable = tareaReady({ id: "c", orden: 3, module: "REC" });

    const seleccionada = selectNextTask([dep, bloqueadaPorDependencia, fueraDeFoco, unicaSeleccionable], ["REC"]);

    expect(seleccionada!.id).toBe("c");
    expect(seleccionada!.status).toBe("doing");
  });

  it("sin ninguna tarea que cumpla los 3 filtros, devuelve null", () => {
    const fueraDeFoco = tareaReady({ id: "a", module: "BO" });
    expect(selectNextTask([fueraDeFoco], ["REC"])).toBeNull();
    expect(selectNextTask([], ["REC"])).toBeNull();
  });
});
