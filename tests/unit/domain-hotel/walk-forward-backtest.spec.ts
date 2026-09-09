// REQ-REV-003: "backtesting walk-forward obligatorio que exija mejora vs. baseline
// antes de habilitar autopilot". Cubre las dos responsabilidades puras del módulo:
// construir ventanas walk-forward sin fuga de datos futuros
// (`buildWalkForwardWindows`) y adjudicar pass/fail de forma determinista sobre
// resultados ya calculados (`evaluateWalkForwardBacktest`).
import { describe, expect, it } from "vitest";
import {
  buildWalkForwardWindows,
  evaluateWalkForwardBacktest,
  type DailyPricingRecord,
  type WindowEvaluation,
} from "@atiende-hoteles/domain-hotel";

function dailySeries(startIso: string, days: number): DailyPricingRecord[] {
  const start = new Date(`${startIso}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(start.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  }));
}

describe("buildWalkForwardWindows", () => {
  it("arma ventanas deslizantes sin solape cuando stepDays === testDays", () => {
    const series = dailySeries("2026-01-01", 120); // ~4 meses de historia diaria
    const windows = buildWalkForwardWindows(series, { trainDays: 60, testDays: 30, stepDays: 30 });

    expect(windows.length).toBeGreaterThanOrEqual(1);
    const first = windows[0]!;
    expect(first.trainStart).toBe("2026-01-01");
    expect(first.trainEnd).toBe("2026-03-01"); // 60 días después de train_start (día 0..59)
    expect(first.testStart).toBe("2026-03-02");
    expect(first.testEnd).toBe("2026-03-31"); // 30 días de prueba
  });

  it("cada ventana de prueba usa SOLO datos anteriores a sí misma (sin fuga de datos futuros)", () => {
    const series = dailySeries("2026-01-01", 200);
    const windows = buildWalkForwardWindows(series, { trainDays: 30, testDays: 15, stepDays: 15 });

    for (const w of windows) {
      expect(new Date(w.trainEnd).getTime()).toBeLessThan(new Date(w.testStart).getTime());
      expect(new Date(w.trainStart).getTime()).toBeLessThanOrEqual(new Date(w.trainEnd).getTime());
      expect(new Date(w.testStart).getTime()).toBeLessThanOrEqual(new Date(w.testEnd).getTime());
    }
  });

  it("nunca genera una ventana de prueba que se pase del final de la serie", () => {
    const series = dailySeries("2026-01-01", 95); // justo insuficiente para una segunda ventana completa
    const windows = buildWalkForwardWindows(series, { trainDays: 60, testDays: 30, stepDays: 30 });
    expect(windows).toHaveLength(1); // train 60 + test 30 = 90 <= 95; una segunda ventana necesitaría 120
    expect(new Date(windows[0]!.testEnd).getTime()).toBeLessThanOrEqual(new Date(series[series.length - 1]!.date).getTime());
  });

  it("serie vacía produce cero ventanas", () => {
    expect(buildWalkForwardWindows([], { trainDays: 30, testDays: 15, stepDays: 15 })).toEqual([]);
  });

  it("rechaza specs con días no positivos", () => {
    const series = dailySeries("2026-01-01", 10);
    expect(() => buildWalkForwardWindows(series, { trainDays: 0, testDays: 5, stepDays: 5 })).toThrow(RangeError);
    expect(() => buildWalkForwardWindows(series, { trainDays: 5, testDays: -1, stepDays: 5 })).toThrow(RangeError);
    expect(() => buildWalkForwardWindows(series, { trainDays: 5, testDays: 5, stepDays: 0 })).toThrow(RangeError);
  });

  it("rechaza una serie no ordenada o con fechas duplicadas", () => {
    expect(() =>
      buildWalkForwardWindows([{ date: "2026-01-02" }, { date: "2026-01-01" }], { trainDays: 1, testDays: 1, stepDays: 1 }),
    ).toThrow(/serie_no_ordenada/);
    expect(() =>
      buildWalkForwardWindows([{ date: "2026-01-01" }, { date: "2026-01-01" }], { trainDays: 1, testDays: 1, stepDays: 1 }),
    ).toThrow(/serie_no_ordenada/);
  });

  it("stepDays menor que testDays produce ventanas de prueba solapadas", () => {
    const series = dailySeries("2026-01-01", 150);
    const windows = buildWalkForwardWindows(series, { trainDays: 30, testDays: 30, stepDays: 15 });
    expect(windows.length).toBeGreaterThan(1);
    // La segunda ventana de prueba empieza 15 días después de la primera, dentro del
    // rango de la primera (solape real, no una coincidencia de conteo).
    const overlap =
      new Date(windows[1]!.testStart).getTime() <= new Date(windows[0]!.testEnd).getTime() &&
      new Date(windows[1]!.testStart).getTime() >= new Date(windows[0]!.testStart).getTime();
    expect(overlap).toBe(true);
  });
});

function evalsOf(pairs: Array<[number, number]>): WindowEvaluation[] {
  return pairs.map(([engineRevenue, baselineRevenue]) => ({
    window: { trainStart: "t0", trainEnd: "t1", testStart: "t2", testEnd: "t3" },
    engineRevenue,
    baselineRevenue,
  }));
}

describe("evaluateWalkForwardBacktest", () => {
  it("pasa cuando el motor mejora el total agregado y gana la mayoría de ventanas", () => {
    const result = evaluateWalkForwardBacktest({
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      evaluations: evalsOf([
        [1200, 1000],
        [1100, 1000],
        [900, 1000], // pierde esta, pero gana 2/3
      ]),
    });
    expect(result.passes).toBe(true);
    expect(result.failureReasons).toEqual([]);
    expect(result.engineTotalRevenue).toBe(3200);
    expect(result.baselineTotalRevenue).toBe(3000);
    expect(result.improvementPct).toBeCloseTo((200 / 3000) * 100, 6);
    expect(result.windowsEngineWon).toBe(2);
    expect(result.windowWinRatio).toBeCloseTo(2 / 3, 6);
  });

  it("falla por ventanas insuficientes aunque el total mejore (un solo mes no basta)", () => {
    const result = evaluateWalkForwardBacktest({
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      evaluations: evalsOf([[1500, 1000]]),
    });
    expect(result.passes).toBe(false);
    expect(result.failureReasons.some((r) => r.startsWith("ventanas_insuficientes"))).toBe(true);
  });

  it("falla si el motor no mejora el total vs. baseline", () => {
    const result = evaluateWalkForwardBacktest({
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      evaluations: evalsOf([
        [900, 1000],
        [950, 1000],
        [980, 1000],
      ]),
    });
    expect(result.passes).toBe(false);
    expect(result.failureReasons.some((r) => r.startsWith("no_supera_baseline"))).toBe(true);
  });

  it("falla si mejora el total pero pierde en la mayoría de las ventanas (outlier oculta pérdida sistemática)", () => {
    const result = evaluateWalkForwardBacktest({
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      evaluations: evalsOf([
        [5000, 1000], // una ventana excelente...
        [800, 1000], // ...pero pierde en las otras 3
        [800, 1000],
        [800, 1000],
      ]),
    });
    // total: engine 7400 vs baseline 4000 -> "mejora" agregada positiva, pero solo 1/4 ventanas ganadas.
    expect(result.improvementPct).toBeGreaterThan(0);
    expect(result.passes).toBe(false);
    expect(result.failureReasons.some((r) => r.startsWith("mayoria_de_ventanas_no_mejora"))).toBe(true);
  });

  it("falla con baseline agregado no positivo en vez de dividir entre cero", () => {
    const result = evaluateWalkForwardBacktest({
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      evaluations: evalsOf([
        [100, 0],
        [100, 0],
        [100, 0],
      ]),
    });
    expect(result.passes).toBe(false);
    expect(result.failureReasons.some((r) => r.startsWith("baseline_invalido"))).toBe(true);
    expect(Number.isFinite(result.improvementPct)).toBe(true); // nunca NaN/Infinity
  });

  it("respeta thresholds configurables (minWindows/minImprovementPct/minWindowWinRatio)", () => {
    const result = evaluateWalkForwardBacktest({
      counterfactualMethod: "tarifa_estatica_pre_motor",
      evaluations: evalsOf([
        [1010, 1000],
        [1010, 1000],
      ]),
      minWindows: 2,
      minImprovementPct: 0.5,
      minWindowWinRatio: 1,
    });
    expect(result.passes).toBe(true);
  });

  it("propaga el counterfactualMethod declarado en el resultado (auditable, nunca silencioso)", () => {
    const result = evaluateWalkForwardBacktest({
      counterfactualMethod: "modelo_elasticidad_declarado",
      evaluations: evalsOf([
        [1100, 1000],
        [1100, 1000],
        [1100, 1000],
      ]),
    });
    expect(result.counterfactualMethod).toBe("modelo_elasticidad_declarado");
  });

  it("cero ventanas evaluadas nunca pasa y no explota (windowWinRatio 0, no NaN)", () => {
    const result = evaluateWalkForwardBacktest({ counterfactualMethod: "misma_tarifa_periodo_anterior", evaluations: [] });
    expect(result.passes).toBe(false);
    expect(result.windowWinRatio).toBe(0);
    expect(result.failureReasons.some((r) => r.startsWith("ventanas_insuficientes"))).toBe(true);
  });
});
