// REQ-HUE-007 (docs/REQUISITOS.md/docs/ACEPTACION.md): "El sistema debe auditar
// semanalmente una muestra de conversaciones/llamadas (p. ej. 30) para detectar
// errores del bot". Unit puro (sin BD) de
// `packages/domain-hotel/src/qa/conversationAudit.ts`: (1) cálculo del lunes ISO de
// una fecha cualquiera, (2) ventana de 7 días, (3) determinismo/reproducibilidad de la
// selección de muestra (misma semilla -> misma muestra, siempre), (4) que el tamaño de
// muestra se respeta y nunca excede el universo candidato, y (5) validación de la
// revisión (categoría reconocida + nota obligatoria cuando hay un error real). El
// escenario end-to-end contra Postgres real (generar la muestra vía HTTP, revisarla)
// vive en `tests/integration/api/auditoria-conversaciones.spec.ts`.
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_AUDIT_CATEGORIES,
  ConversationAuditError,
  DEFAULT_WEEKLY_AUDIT_SAMPLE_SIZE,
  assertValidAuditReview,
  resolveAuditWindow,
  resolveIsoWeekStart,
  selectWeeklyAuditSample,
} from "@atiende-hoteles/domain-hotel";

describe("resolveIsoWeekStart (REQ-HUE-007)", () => {
  it("devuelve el mismo lunes para cualquier día de esa semana", () => {
    // Semana del lunes 2026-09-07 al domingo 2026-09-13.
    expect(resolveIsoWeekStart(new Date("2026-09-07T00:00:00.000Z"))).toBe("2026-09-07"); // lunes
    expect(resolveIsoWeekStart(new Date("2026-09-09T15:30:00.000Z"))).toBe("2026-09-07"); // miércoles
    expect(resolveIsoWeekStart(new Date("2026-09-13T23:59:59.000Z"))).toBe("2026-09-07"); // domingo
  });

  it("un domingo pertenece a la semana que YA terminó (no a la que empieza), criterio ISO", () => {
    expect(resolveIsoWeekStart(new Date("2026-09-13T00:00:00.000Z"))).toBe("2026-09-07");
    expect(resolveIsoWeekStart(new Date("2026-09-14T00:00:00.000Z"))).toBe("2026-09-14"); // el lunes siguiente
  });

  it("rechaza una fecha inválida en vez de devolver 'Invalid Date' silencioso", () => {
    expect(() => resolveIsoWeekStart(new Date("no-es-una-fecha"))).toThrow(ConversationAuditError);
  });
});

describe("resolveAuditWindow (REQ-HUE-007)", () => {
  it("devuelve una ventana de exactamente 7 días completos [inicio, fin)", () => {
    const { start, end } = resolveAuditWindow("2026-09-07");
    expect(start.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("rechaza un weekOf con formato inválido", () => {
    expect(() => resolveAuditWindow("07-09-2026")).toThrow(ConversationAuditError);
  });
});

describe("selectWeeklyAuditSample (REQ-HUE-007)", () => {
  const universo50 = Array.from({ length: 50 }, (_, i) => `conv-${String(i).padStart(2, "0")}`);

  it("respeta el tamaño de muestra por defecto (30) cuando el universo es mayor", () => {
    const muestra = selectWeeklyAuditSample(universo50, { seed: "hotel-a::2026-09-07" });
    expect(muestra).toHaveLength(DEFAULT_WEEKLY_AUDIT_SAMPLE_SIZE);
  });

  it("nunca excede el universo candidato: si hay menos conversaciones que sampleSize, devuelve todas", () => {
    const universo5 = universo50.slice(0, 5);
    const muestra = selectWeeklyAuditSample(universo5, { seed: "hotel-a::2026-09-07", sampleSize: 30 });
    expect(muestra.sort()).toEqual([...universo5].sort());
  });

  it("es determinística: misma semilla + mismo universo -> siempre la MISMA muestra (auditoría reproducible)", () => {
    const m1 = selectWeeklyAuditSample(universo50, { seed: "hotel-a::2026-09-07", sampleSize: 10 });
    const m2 = selectWeeklyAuditSample(universo50, { seed: "hotel-a::2026-09-07", sampleSize: 10 });
    expect(m2).toEqual(m1);
  });

  it("el resultado no depende del orden de llegada de los ids candidatos", () => {
    const barajado = [...universo50].reverse();
    const m1 = selectWeeklyAuditSample(universo50, { seed: "hotel-a::2026-09-07", sampleSize: 10 });
    const m2 = selectWeeklyAuditSample(barajado, { seed: "hotel-a::2026-09-07", sampleSize: 10 });
    expect(m2).toEqual(m1);
  });

  it("semillas distintas (semana distinta, u hotel distinto) producen muestras distintas", () => {
    const semanaA = selectWeeklyAuditSample(universo50, { seed: "hotel-a::2026-09-07", sampleSize: 10 });
    const semanaB = selectWeeklyAuditSample(universo50, { seed: "hotel-a::2026-09-14", sampleSize: 10 });
    const hotelB = selectWeeklyAuditSample(universo50, { seed: "hotel-b::2026-09-07", sampleSize: 10 });
    expect(semanaB).not.toEqual(semanaA);
    expect(hotelB).not.toEqual(semanaA);
  });

  it("deduplica ids repetidos en la entrada antes de sortear", () => {
    const conDuplicados = [...universo50, ...universo50.slice(0, 10)];
    const muestra = selectWeeklyAuditSample(conDuplicados, { seed: "x", sampleSize: 50 });
    expect(new Set(muestra).size).toBe(muestra.length);
  });

  it("rechaza un sampleSize inválido", () => {
    expect(() => selectWeeklyAuditSample(universo50, { seed: "x", sampleSize: 0 })).toThrow(ConversationAuditError);
    expect(() => selectWeeklyAuditSample(universo50, { seed: "x", sampleSize: -5 })).toThrow(ConversationAuditError);
  });
});

describe("assertValidAuditReview (REQ-HUE-007)", () => {
  it("acepta 'ninguno' sin necesitar nota", () => {
    expect(assertValidAuditReview({ category: "ninguno" })).toEqual({ category: "ninguno", notes: null });
  });

  it.each(CONVERSATION_AUDIT_CATEGORIES.filter((c) => c !== "ninguno"))(
    "exige una nota no vacía para la categoría de error '%s'",
    (categoria) => {
      expect(() => assertValidAuditReview({ category: categoria })).toThrow(ConversationAuditError);
      expect(() => assertValidAuditReview({ category: categoria, notes: "   " })).toThrow(ConversationAuditError);
      expect(assertValidAuditReview({ category: categoria, notes: "cotizó $500 más caro que la tarifa real" })).toEqual({
        category: categoria,
        notes: "cotizó $500 más caro que la tarifa real",
      });
    },
  );

  it("rechaza una categoría no reconocida", () => {
    expect(() => assertValidAuditReview({ category: "algo_inventado", notes: "x" })).toThrow(ConversationAuditError);
  });
});
