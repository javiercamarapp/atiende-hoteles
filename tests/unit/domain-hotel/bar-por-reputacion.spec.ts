// REQ-REV-017 (P2/F): "recomendar un ajuste de tarifa (BAR) cuando el índice de
// reputación suba sobre un umbral en una ventana de tiempo definida" -- espejo puro de
// `packages/domain-hotel/src/revenue/barPorReputacion.ts`. Complementa (nunca
// duplica) tests/integration/revenue/bar-por-reputacion.spec.ts, que verifica el
// mismo criterio contra Postgres real (`guest_review` + `bar_reputation_recommendation`).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BAR_REPUTATION_THRESHOLD,
  PROPONE_VARIATION_PCT_MAX,
  PROPONE_VARIATION_PCT_MIN,
  calcularIndiceReputacion,
  detectarCruceDeUmbral,
  recomendarAjusteBar,
  sentimentScoreToIndice,
  type IndiceReputacionPunto,
} from "@atiende-hoteles/domain-hotel";

const DAY_MS = 24 * 60 * 60 * 1000;
const AHORA = new Date("2026-09-11T00:00:00Z");

function diasAtras(dias: number, ahora: Date = AHORA): Date {
  return new Date(ahora.getTime() - dias * DAY_MS);
}

function serie(puntos: readonly [number, number][], ahora: Date = AHORA): IndiceReputacionPunto[] {
  // [díasAtrás, valor][] con díasAtrás DECRECIENTE (el llamador lista del pasado al
  // presente) -- ya queda ascendente por fecha, mismo contrato que exige
  // `detectarCruceDeUmbral`.
  return puntos.map(([diasAtrasN, valor]) => ({ fecha: diasAtras(diasAtrasN, ahora), valor }));
}

describe("sentimentScoreToIndice", () => {
  it("remapea -1..1 a 0..100 linealmente", () => {
    expect(sentimentScoreToIndice(-1)).toBe(0);
    expect(sentimentScoreToIndice(0)).toBe(50);
    expect(sentimentScoreToIndice(1)).toBe(100);
    expect(sentimentScoreToIndice(0.5)).toBe(75);
  });

  it("rechaza un sentiment_score fuera de -1..1", () => {
    expect(() => sentimentScoreToIndice(1.5)).toThrow(RangeError);
    expect(() => sentimentScoreToIndice(-1.01)).toThrow(RangeError);
  });
});

describe("calcularIndiceReputacion", () => {
  it("promedia los sentiment_score ya remapeados a 0..100", () => {
    // -1 -> 0, 1 -> 100, 0 -> 50: promedio = 50.
    expect(calcularIndiceReputacion([-1, 1, 0])).toBe(50);
  });

  it("[] -> null (nunca inventa un índice neutro sin datos)", () => {
    expect(calcularIndiceReputacion([])).toBeNull();
  });
});

describe("detectarCruceDeUmbral (REQ-REV-017: criterio literal — serie sintética que cruza el umbral)", () => {
  it("CASO POSITIVO: detecta un cruce real de abajo del umbral hacia arriba dentro de la ventana", () => {
    // Serie diaria de 20 días: empieza en 60 (bajo el umbral 75), sube a 82 a mitad de
    // la ventana y se mantiene ahí -- el caso canónico del criterio de aceptación.
    const puntos = serie([
      [20, 60],
      [15, 62],
      [10, 65],
      [8, 68],
      [6, 74], // todavía bajo el umbral (75)
      [4, 82], // cruza aquí
      [2, 85],
      [0, 88],
    ]);
    const resultado = detectarCruceDeUmbral(puntos, DEFAULT_BAR_REPUTATION_THRESHOLD, 30, AHORA);
    expect(resultado.cruzo).toBe(true);
    expect(resultado.indiceAntesDeCruce).toBe(74);
    expect(resultado.indiceActual).toBe(88);
    expect(resultado.fechaCruce?.getTime()).toBe(diasAtras(4).getTime());
  });

  it("CASO NEGATIVO: una serie que nunca cruza el umbral no genera cruce", () => {
    const puntos = serie([
      [20, 40],
      [15, 45],
      [10, 50],
      [5, 55],
      [0, 60],
    ]);
    const resultado = detectarCruceDeUmbral(puntos, DEFAULT_BAR_REPUTATION_THRESHOLD, 30, AHORA);
    expect(resultado.cruzo).toBe(false);
    expect(resultado.fechaCruce).toBeNull();
    expect(resultado.indiceActual).toBe(60);
  });

  it("CASO NEGATIVO: ya estaba sobre el umbral desde el primer punto observado -- no es un cruce NUEVO", () => {
    const puntos = serie([
      [20, 80],
      [10, 82],
      [0, 85],
    ]);
    const resultado = detectarCruceDeUmbral(puntos, DEFAULT_BAR_REPUTATION_THRESHOLD, 30, AHORA);
    expect(resultado.cruzo).toBe(false);
  });

  it("CASO NEGATIVO: cruzó pero ya volvió a caer bajo el umbral antes del punto más reciente", () => {
    const puntos = serie([
      [20, 60],
      [10, 82], // cruzó
      [5, 70], // volvió a caer
      [0, 68], // sigue abajo hoy
    ]);
    const resultado = detectarCruceDeUmbral(puntos, DEFAULT_BAR_REPUTATION_THRESHOLD, 30, AHORA);
    expect(resultado.cruzo).toBe(false);
    expect(resultado.indiceActual).toBe(68);
  });

  it("un cruce fuera de la ventana definida no cuenta -- solo se mira [ahora - ventanaDias, ahora]", () => {
    // El cruce real ocurrió hace 60 días; con una ventana de 30 días, la serie
    // observable dentro de la ventana ya empieza arriba del umbral (sin bajo previo
    // visible) -- no es un cruce nuevo DENTRO de la ventana.
    const puntos = serie([
      [60, 50],
      [55, 82], // cruce real, pero fuera de la ventana de 30 días
      [20, 84],
      [0, 86],
    ]);
    const resultado = detectarCruceDeUmbral(puntos, DEFAULT_BAR_REPUTATION_THRESHOLD, 30, AHORA);
    expect(resultado.cruzo).toBe(false);
  });

  it("ventana vacía (sin reseñas recientes) -> sin cruce ni índice actual", () => {
    const puntos = serie([[90, 82]]);
    const resultado = detectarCruceDeUmbral(puntos, DEFAULT_BAR_REPUTATION_THRESHOLD, 30, AHORA);
    expect(resultado.cruzo).toBe(false);
    expect(resultado.indiceActual).toBeNull();
  });

  it("valida umbral y ventanaDias fuera de rango", () => {
    expect(() => detectarCruceDeUmbral([], 101, 30, AHORA)).toThrow(RangeError);
    expect(() => detectarCruceDeUmbral([], 50, 0, AHORA)).toThrow(RangeError);
    expect(() => detectarCruceDeUmbral([], 50, -5, AHORA)).toThrow(RangeError);
  });
});

describe("recomendarAjusteBar", () => {
  it("null cuando no hubo cruce -- nunca inventa una recomendación", () => {
    const sinCruce = detectarCruceDeUmbral(serie([[10, 40], [0, 45]]), 75, 30, AHORA);
    expect(recomendarAjusteBar(sinCruce, 75)).toBeNull();
  });

  it("recomienda el MÍNIMO del rango de REQ-REV-003 justo en el momento del cruce (elevación ~0)", () => {
    const puntos = serie([
      [5, 70],
      [0, 75.5], // apenas cruza 75
    ]);
    const cruce = detectarCruceDeUmbral(puntos, 75, 30, AHORA);
    const rec = recomendarAjusteBar(cruce, 75);
    expect(rec).not.toBeNull();
    expect(rec!.ajustePorcentaje).toBeGreaterThanOrEqual(PROPONE_VARIATION_PCT_MIN);
    expect(rec!.ajustePorcentaje).toBeCloseTo(PROPONE_VARIATION_PCT_MIN, 0);
  });

  it("escala hacia el MÁXIMO del rango cuando el índice sube mucho más allá del umbral", () => {
    const puntos = serie([
      [5, 70],
      [0, 100], // el máximo posible
    ]);
    const cruce = detectarCruceDeUmbral(puntos, 75, 30, AHORA);
    const rec = recomendarAjusteBar(cruce, 75);
    expect(rec!.ajustePorcentaje).toBe(PROPONE_VARIATION_PCT_MAX);
  });

  it("el porcentaje sugerido SIEMPRE cae dentro de [PROPONE_VARIATION_PCT_MIN, PROPONE_VARIATION_PCT_MAX] (REQ-REV-003)", () => {
    for (const indiceActual of [75, 80, 90, 95, 100]) {
      const puntos = serie([
        [5, 60],
        [0, indiceActual],
      ]);
      const cruce = detectarCruceDeUmbral(puntos, 75, 30, AHORA);
      const rec = recomendarAjusteBar(cruce, 75);
      expect(rec!.ajustePorcentaje).toBeGreaterThanOrEqual(PROPONE_VARIATION_PCT_MIN);
      expect(rec!.ajustePorcentaje).toBeLessThanOrEqual(PROPONE_VARIATION_PCT_MAX);
    }
  });

  it("la razón cita el índice antes/después, el umbral y la fecha real del cruce", () => {
    const puntos = serie([
      [5, 70],
      [0, 90],
    ]);
    const cruce = detectarCruceDeUmbral(puntos, 75, 30, AHORA);
    const rec = recomendarAjusteBar(cruce, 75);
    expect(rec!.razon).toContain("70.0");
    expect(rec!.razon).toContain("90.0");
    expect(rec!.razon).toContain("75");
    expect(rec!.razon).toContain(diasAtras(0).toISOString().slice(0, 10));
  });
});
