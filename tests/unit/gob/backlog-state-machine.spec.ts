// REQ-GOB-007: "El backlog de tareas debe modelarse como máquina de estados
// draft→ready→doing→review→done con laterales blocked/needs-human, una tarea = un
// archivo desde plantilla, con contador de intentos y un gate declarado (none/
// connector/money/physical)" -- verificado con una transición inválida rechazada por
// la máquina de estados (criterio de ACEPTACION.md).
import { describe, expect, it } from "vitest";
import {
  createBacklogTask,
  InvalidBacklogTransitionError,
  parseTaskFile,
  recordFailedAttempt,
  renderTaskFile,
  selectNextReadyTask,
  transitionBacklogTask,
  type BacklogTask,
} from "../../../packages/agent-core/src/backlog/backlogStateMachine.ts";

function tareaBase(overrides: Partial<Parameters<typeof createBacklogTask>[0]> = {}) {
  return createBacklogTask({
    id: "t-001",
    title: "Crear endpoint X",
    module: "REC",
    orden: 1,
    estimacionHoras: 2,
    gate: "none",
    ...overrides,
  });
}

describe("createBacklogTask", () => {
  it("nace en draft con 0 intentos y sin razones de bloqueo", () => {
    const t = tareaBase();
    expect(t.status).toBe("draft");
    expect(t.attempts).toBe(0);
    expect(t.blockedReason).toBeNull();
    expect(t.needsHumanReason).toBeNull();
  });

  it("rechaza un gate fuera del catálogo cerrado", () => {
    // @ts-expect-error -- gate inválido a propósito
    expect(() => tareaBase({ gate: "otro" })).toThrow(/gate_invalido/);
  });
});

describe("transitionBacklogTask: camino principal", () => {
  it("draft→ready→doing→review→done es válido paso a paso", () => {
    let t = tareaBase();
    t = transitionBacklogTask(t, "ready");
    expect(t.status).toBe("ready");
    t = transitionBacklogTask(t, "doing");
    expect(t.status).toBe("doing");
    t = transitionBacklogTask(t, "review");
    expect(t.status).toBe("review");
    t = transitionBacklogTask(t, "done");
    expect(t.status).toBe("done");
  });

  it("review→doing permite retrabajo tras cambios solicitados", () => {
    let t = tareaBase();
    t = transitionBacklogTask(t, "ready");
    t = transitionBacklogTask(t, "doing");
    t = transitionBacklogTask(t, "review");
    t = transitionBacklogTask(t, "doing");
    expect(t.status).toBe("doing");
  });
});

describe("transitionBacklogTask: transiciones inválidas SIEMPRE rechazadas", () => {
  it("draft→doing (saltarse ready) es rechazada", () => {
    const t = tareaBase();
    expect(() => transitionBacklogTask(t, "doing")).toThrow(InvalidBacklogTransitionError);
  });

  it("draft→done (saltarse todo el flujo) es rechazada", () => {
    const t = tareaBase();
    expect(() => transitionBacklogTask(t, "done")).toThrow(/transicion_invalida_backlog/);
  });

  it("done→cualquier otro estado es rechazada (done es terminal)", () => {
    let t = tareaBase();
    t = transitionBacklogTask(t, "ready");
    t = transitionBacklogTask(t, "doing");
    t = transitionBacklogTask(t, "review");
    t = transitionBacklogTask(t, "done");
    expect(() => transitionBacklogTask(t, "doing")).toThrow(InvalidBacklogTransitionError);
    expect(() => transitionBacklogTask(t, "ready")).toThrow(InvalidBacklogTransitionError);
  });

  it("ready→blocked (bloquear sin haber empezado a trabajar) es rechazada", () => {
    let t = tareaBase();
    t = transitionBacklogTask(t, "ready");
    expect(() => transitionBacklogTask(t, "blocked", { blockedReason: "x" })).toThrow(InvalidBacklogTransitionError);
  });
});

describe("blocked/needs-human exigen motivo documentado (GOB-003/GOB-006/GOB-008)", () => {
  function tareaEnDoing(): BacklogTask {
    let t = tareaBase();
    t = transitionBacklogTask(t, "ready");
    t = transitionBacklogTask(t, "doing");
    return t;
  }

  it("doing→blocked sin blockedReason es rechazada", () => {
    const t = tareaEnDoing();
    expect(() => transitionBacklogTask(t, "blocked")).toThrow(/blocked_sin_motivo/);
  });

  it("doing→blocked con motivo queda registrado", () => {
    const t = transitionBacklogTask(tareaEnDoing(), "blocked", { blockedReason: "sandbox PMS no disponible" });
    expect(t.status).toBe("blocked");
    expect(t.blockedReason).toBe("sandbox PMS no disponible");
  });

  it("doing→needs-human sin needsHumanReason es rechazada", () => {
    const t = tareaEnDoing();
    expect(() => transitionBacklogTask(t, "needs-human")).toThrow(/needs_human_sin_motivo/);
  });

  it("blocked→needs-human escala el bloqueo a decisión reservada al fundador", () => {
    let t = transitionBacklogTask(tareaEnDoing(), "blocked", { blockedReason: "toca precios de lista" });
    t = transitionBacklogTask(t, "needs-human", { needsHumanReason: "cambio de precios de lista, catálogo GOB-012" });
    expect(t.status).toBe("needs-human");
    expect(t.blockedReason).toBeNull();
    expect(t.needsHumanReason).toMatch(/GOB-012/);
  });

  it("needs-human→doing reanuda tras aprobación del fundador, limpiando la razón", () => {
    let t = transitionBacklogTask(tareaEnDoing(), "needs-human", { needsHumanReason: "x" });
    t = transitionBacklogTask(t, "doing");
    expect(t.status).toBe("doing");
    expect(t.needsHumanReason).toBeNull();
  });
});

describe("recordFailedAttempt: 3 intentos por la misma causa → blocked automático (GOB-008)", () => {
  it("intentos 1 y 2 no bloquean, incrementan el contador", () => {
    let t = tareaBase();
    t = transitionBacklogTask(t, "ready");
    t = transitionBacklogTask(t, "doing");
    t = recordFailedAttempt(t, "test X sigue en rojo");
    expect(t.attempts).toBe(1);
    expect(t.status).toBe("doing");
    t = recordFailedAttempt(t, "test X sigue en rojo");
    expect(t.attempts).toBe(2);
    expect(t.status).toBe("doing");
  });

  it("el 3er intento fallido transiciona automáticamente a blocked con diagnóstico", () => {
    let t = tareaBase();
    t = transitionBacklogTask(t, "ready");
    t = transitionBacklogTask(t, "doing");
    t = recordFailedAttempt(t, "misma causa");
    t = recordFailedAttempt(t, "misma causa");
    t = recordFailedAttempt(t, "misma causa");
    expect(t.attempts).toBe(3);
    expect(t.status).toBe("blocked");
    expect(t.blockedReason).toMatch(/3 intentos fallidos/);
  });
});

describe("selectNextReadyTask (GOB-001/GOB-046/GOB-049)", () => {
  it("selecciona la de menor orden entre las ready, ignorando otros estados", () => {
    const a = transitionBacklogTask(tareaBase({ id: "a", orden: 5 }), "ready");
    const b = transitionBacklogTask(tareaBase({ id: "b", orden: 2 }), "ready");
    const cDraft = tareaBase({ id: "c", orden: 1 }); // no está ready: nunca se selecciona
    expect(selectNextReadyTask([a, b, cDraft])!.id).toBe("b");
  });

  it("empate en orden → menor estimacionHoras", () => {
    const a = transitionBacklogTask(tareaBase({ id: "a", orden: 1, estimacionHoras: 4 }), "ready");
    const b = transitionBacklogTask(tareaBase({ id: "b", orden: 1, estimacionHoras: 1 }), "ready");
    expect(selectNextReadyTask([a, b])!.id).toBe("b");
  });

  it("sin ninguna tarea ready devuelve null", () => {
    expect(selectNextReadyTask([tareaBase()])).toBeNull();
  });
});

describe("una tarea = un archivo desde plantilla (round-trip render/parse, GOB-045)", () => {
  it("renderTaskFile → parseTaskFile reproduce la misma tarea", () => {
    let t = tareaBase({ id: "t-042", title: "Emitir CFDI de hospedaje", module: "BO", gate: "money" });
    t = transitionBacklogTask(t, "ready");
    t = transitionBacklogTask(t, "doing");
    t = recordFailedAttempt(t, "timbrado rechazado por el PAC de prueba");

    const contenido = renderTaskFile(t);
    expect(contenido).toContain("---");
    expect(contenido).toContain("# Emitir CFDI de hospedaje");

    const parsed = parseTaskFile(contenido);
    expect(parsed).toEqual(t);
  });

  it("parseTaskFile rechaza un archivo sin frontmatter", () => {
    expect(() => parseTaskFile("# solo un título, sin frontmatter")).toThrow(/plantilla_invalida/);
  });

  it("parseTaskFile rechaza un gate fuera del catálogo cerrado", () => {
    const t = tareaBase();
    const contenido = renderTaskFile(t).replace("gate: none", "gate: inventado");
    expect(() => parseTaskFile(contenido)).toThrow(/gate_invalido/);
  });
});
