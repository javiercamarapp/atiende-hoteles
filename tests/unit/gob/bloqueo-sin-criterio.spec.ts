// REQ-GOB-003 (GOB-003): "Si falta un criterio de aceptación verificable, el agente no
// debe implementar: la tarea pasa a `blocked` con el motivo documentado." -- verificado
// con una tarea de prueba sin criterio → estado `blocked` resultante (criterio literal
// de ACEPTACION.md), incluyendo que `implement()` NUNCA se invoca en ese caso (no es
// solo el estado final: es que la implementación de verdad no ocurrió).
import { describe, expect, it, vi } from "vitest";
import {
  beginImplementation,
  createBacklogTask,
  hasVerifiableAcceptanceCriteria,
  InvalidBacklogTransitionError,
  transitionBacklogTask,
  type BacklogTask,
} from "../../../packages/agent-core/src/backlog/backlogStateMachine.ts";

function tareaEnDoing(overrides: Partial<Parameters<typeof createBacklogTask>[0]> = {}): BacklogTask {
  let t = createBacklogTask({
    id: "t-gob-003",
    title: "Tarea de prueba sin criterio",
    module: "REC",
    orden: 1,
    estimacionHoras: 2,
    gate: "none",
    ...overrides,
  });
  t = transitionBacklogTask(t, "ready");
  t = transitionBacklogTask(t, "doing");
  return t;
}

describe("hasVerifiableAcceptanceCriteria", () => {
  it("null (nunca se declaró un criterio) no es verificable", () => {
    expect(hasVerifiableAcceptanceCriteria(tareaEnDoing({ criterioAceptacion: null }))).toBe(false);
  });

  it("una cadena vacía no es verificable", () => {
    expect(hasVerifiableAcceptanceCriteria(tareaEnDoing({ criterioAceptacion: "" }))).toBe(false);
  });

  it("una cadena solo de espacios en blanco no es verificable", () => {
    expect(hasVerifiableAcceptanceCriteria(tareaEnDoing({ criterioAceptacion: "   \n\t " }))).toBe(false);
  });

  it("un criterio con texto real SÍ es verificable", () => {
    const conCriterio = tareaEnDoing({
      criterioAceptacion: "npx vitest run tests/unit/gob/bloqueo-sin-criterio.spec.ts pasa en verde",
    });
    expect(hasVerifiableAcceptanceCriteria(conCriterio)).toBe(true);
  });
});

describe("beginImplementation (REQ-GOB-003): tarea de prueba SIN criterio → blocked", () => {
  it("una tarea sin criterio de aceptación verificable pasa a `blocked`, nunca se implementa", () => {
    const sinCriterio = tareaEnDoing({ criterioAceptacion: null });
    const implement = vi.fn();

    const resultado = beginImplementation(sinCriterio, implement);

    // "la tarea pasa a blocked" -- el criterio literal de ACEPTACION.md.
    expect(resultado.status).toBe("blocked");
    // "con el motivo documentado" -- nunca un bloqueo silencioso o sin explicación.
    expect(resultado.blockedReason).not.toBeNull();
    expect(resultado.blockedReason).toMatch(/GOB-003/);
    expect(resultado.blockedReason).toMatch(/criterio de aceptaci[oó]n/i);
    expect(resultado.blockedReason).toContain("t-gob-003"); // referencia a la tarea concreta
    // "el agente no debe implementar" -- no es una promesa: implement() nunca se llamó.
    expect(implement).not.toHaveBeenCalled();
  });

  it("una cadena de solo espacios en blanco cuenta como 'sin criterio' y también bloquea", () => {
    const criterioEnBlanco = tareaEnDoing({ criterioAceptacion: "   " });
    const implement = vi.fn();

    const resultado = beginImplementation(criterioEnBlanco, implement);

    expect(resultado.status).toBe("blocked");
    expect(implement).not.toHaveBeenCalled();
  });

  it("no muta la tarea original (devuelve una copia, igual que toda transición)", () => {
    const sinCriterio = tareaEnDoing({ criterioAceptacion: null });

    beginImplementation(sinCriterio, vi.fn());

    expect(sinCriterio.status).toBe("doing");
  });
});

describe("beginImplementation: tarea CON criterio verificable → sí se implementa", () => {
  it("con criterio presente, invoca implement() y no cambia el estado de la tarea", () => {
    const conCriterio = tareaEnDoing({
      criterioAceptacion: "npx vitest run tests/unit/gob/bloqueo-sin-criterio.spec.ts",
    });
    const implement = vi.fn();

    const resultado = beginImplementation(conCriterio, implement);

    expect(implement).toHaveBeenCalledTimes(1);
    expect(resultado.status).toBe("doing"); // pasar a review es responsabilidad de REQ-GOB-005, no de esta puerta
    expect(resultado.blockedReason).toBeNull();
  });
});

describe("beginImplementation: nunca bloquea una tarea que no se había empezado a trabajar", () => {
  it("una tarea `ready` (aún no `doing`) sin criterio no se bloquea en silencio: la transición se rechaza", () => {
    let sinEmpezar = createBacklogTask({
      id: "t-gob-003-b",
      title: "Tarea aún no iniciada",
      module: "REC",
      orden: 1,
      estimacionHoras: 1,
      gate: "none",
      criterioAceptacion: null,
    });
    sinEmpezar = transitionBacklogTask(sinEmpezar, "ready");
    const implement = vi.fn();

    expect(() => beginImplementation(sinEmpezar, implement)).toThrow(InvalidBacklogTransitionError);
    expect(implement).not.toHaveBeenCalled();
  });
});
