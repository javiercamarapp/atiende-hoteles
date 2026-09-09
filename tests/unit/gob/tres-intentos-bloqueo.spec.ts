// REQ-GOB-006 (GOB-008/GOB-045/GOB-012): "Tres intentos fallidos por la misma causa
// deben pasar la tarea a `blocked` con diagnóstico; si la tarea toca el catálogo de
// decisiones reservadas al fundador, pasa a `needs-human`." -- la primera mitad
// (3 fallos -> `blocked`) ya estaba cubierta en `tests/unit/gob/backlog-state-machine.spec.ts`
// (REQ-GOB-007). Este archivo verifica la mitad que faltaba: el CRUCE real entre
// `recordFailedAttempt` y el catálogo cerrado de 24 categorías reservadas al fundador
// (`founder_reserved_category`, migración `packages/db/migrations/0081_decisiones_reservadas_fundador.sql`),
// con 3 fallas simuladas consecutivas para cada camino (criterio literal de
// ACEPTACION.md), y una verificación contra Postgres REAL (PGlite, ADR-003) de que el
// catálogo que usa `backlogStateMachine.ts` no es una copia que pueda haberse
// desincronizado del enum real de la base de datos.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, openPglite, type PgliteEngine } from "@atiende-hoteles/db";
import {
  createBacklogTask,
  FOUNDER_RESERVED_CATEGORIES,
  isFounderReservedCategory,
  recordFailedAttempt,
  transitionBacklogTask,
  type BacklogTask,
} from "../../../packages/agent-core/src/backlog/backlogStateMachine.ts";

function tareaEnDoing(overrides: Partial<Parameters<typeof createBacklogTask>[0]> = {}): BacklogTask {
  let t = createBacklogTask({
    id: "t-gob-006",
    title: "Tarea de prueba de 3 intentos",
    module: "GOB",
    orden: 1,
    estimacionHoras: 2,
    gate: "none",
    ...overrides,
  });
  t = transitionBacklogTask(t, "ready");
  t = transitionBacklogTask(t, "doing");
  return t;
}

describe("recordFailedAttempt: tarea SIN categoría reservada -- 3 fallos -> blocked (comportamiento previo, sin regresión)", () => {
  it("intentos 1 y 2 no transicionan, el 3ro pasa a blocked con diagnóstico", () => {
    let t = tareaEnDoing({ founderReservedCategory: null });

    t = recordFailedAttempt(t, "sandbox PMS sigue caído");
    expect(t.attempts).toBe(1);
    expect(t.status).toBe("doing");

    t = recordFailedAttempt(t, "sandbox PMS sigue caído");
    expect(t.attempts).toBe(2);
    expect(t.status).toBe("doing");

    t = recordFailedAttempt(t, "sandbox PMS sigue caído");
    expect(t.attempts).toBe(3);
    expect(t.status).toBe("blocked");
    expect(t.blockedReason).toMatch(/3 intentos fallidos/);
    expect(t.blockedReason).toMatch(/sandbox PMS sigue caído/);
    expect(t.needsHumanReason).toBeNull();
  });
});

describe("recordFailedAttempt: tarea que TOCA el catálogo de decisiones reservadas al fundador -- 3 fallos -> needs-human, nunca blocked (REQ-GOB-006)", () => {
  it("escala DIRECTO a needs-human al 3er fallo, saltándose blocked, con la categoría y el diagnóstico documentados", () => {
    let t = tareaEnDoing({ founderReservedCategory: "precios_de_lista" });

    t = recordFailedAttempt(t, "el agente no puede resolver el nuevo precio de lista sin definición humana");
    expect(t.attempts).toBe(1);
    expect(t.status).toBe("doing"); // los 2 primeros fallos no distinguen: solo cuentan intentos.

    t = recordFailedAttempt(t, "el agente no puede resolver el nuevo precio de lista sin definición humana");
    expect(t.attempts).toBe(2);
    expect(t.status).toBe("doing");

    t = recordFailedAttempt(t, "el agente no puede resolver el nuevo precio de lista sin definición humana");
    expect(t.attempts).toBe(3);
    // "pasa a needs-human" -- el criterio literal de ACEPTACION.md, nunca blocked.
    expect(t.status).toBe("needs-human");
    expect(t.blockedReason).toBeNull();
    expect(t.needsHumanReason).not.toBeNull();
    expect(t.needsHumanReason).toMatch(/GOB-006/);
    expect(t.needsHumanReason).toMatch(/precios_de_lista/);
    expect(t.needsHumanReason).toMatch(/el agente no puede resolver el nuevo precio de lista sin definición humana/);
  });

  it.each(FOUNDER_RESERVED_CATEGORIES)(
    "categoría reservada \"%s\": 3 fallos consecutivos también escalan a needs-human (barrido de las 24 categorías del catálogo cerrado)",
    (categoria) => {
      let t = tareaEnDoing({ id: `t-gob-006-${categoria}`, founderReservedCategory: categoria });
      t = recordFailedAttempt(t, "fallo 1");
      t = recordFailedAttempt(t, "fallo 2");
      t = recordFailedAttempt(t, "fallo 3, misma causa");

      expect(t.status).toBe("needs-human");
      expect(t.needsHumanReason).toMatch(new RegExp(categoria));
    },
  );

  it("no muta la tarea original en ningún paso (devuelve copias, igual que toda transición)", () => {
    const original = tareaEnDoing({ founderReservedCategory: "borrado_destructivo_o_force_push" });
    recordFailedAttempt(recordFailedAttempt(recordFailedAttempt(original, "a"), "b"), "c");
    expect(original.attempts).toBe(0);
    expect(original.status).toBe("doing");
  });
});

describe("createBacklogTask rechaza una founderReservedCategory fuera del catálogo cerrado (mismo criterio que `gate`)", () => {
  it("una categoría inventada es rechazada al crear la tarea, no solo al fallar 3 veces", () => {
    expect(() =>
      createBacklogTask({
        id: "t-gob-006-invalida",
        title: "x",
        module: "GOB",
        orden: 1,
        estimacionHoras: 1,
        gate: "none",
        // @ts-expect-error -- categoría inválida a propósito
        founderReservedCategory: "categoria_inventada_fuera_del_catalogo",
      }),
    ).toThrow(/founder_reserved_category_invalida/);
  });
});

describe("isFounderReservedCategory: guarda de runtime consistente con el tipo estático", () => {
  it("acepta las 24 categorías reales y rechaza una inventada", () => {
    for (const categoria of FOUNDER_RESERVED_CATEGORIES) {
      expect(isFounderReservedCategory(categoria)).toBe(true);
    }
    expect(isFounderReservedCategory("categoria_inventada_fuera_del_catalogo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Verificación contra Postgres REAL (PGlite, ADR-003): `FOUNDER_RESERVED_CATEGORIES` en
// `backlogStateMachine.ts` es una copia literal del enum `public.founder_reserved_category`
// de la migración 0081 -- este módulo es de dominio PURO (sin I/O, ver cabecera del
// archivo) y por eso no puede leer el catálogo de la base de datos en tiempo de
// ejecución. Esta prueba es lo que hace real (no una promesa de comentario) que las dos
// copias nunca diverjan: aplica la migración real contra Postgres real y compara el
// enum vivo, campo por campo, contra la constante que usa `recordFailedAttempt`.
// ---------------------------------------------------------------------------------------
describe("FOUNDER_RESERVED_CATEGORIES coincide EXACTAMENTE con el enum real de Postgres (migración 0081, PGlite real)", () => {
  let engine: PgliteEngine;

  beforeAll(async () => {
    engine = await openPglite();
    await applyMigrations(engine.admin);
  });

  afterAll(async () => {
    await engine.close();
  });

  it("mismas 24 categorías, sin faltantes ni sobrantes de ningún lado", async () => {
    const { rows } = await engine.admin.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'founder_reserved_category'
       order by e.enumsortorder`,
    );
    const enumReal = rows.map((r) => r.enumlabel).sort();
    const enumEnCodigo = [...FOUNDER_RESERVED_CATEGORIES].sort();

    expect(enumEnCodigo).toHaveLength(24);
    expect(enumReal).toEqual(enumEnCodigo);
  });
});
