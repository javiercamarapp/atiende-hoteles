// REQ-AGT-021 (BP-138): skill hotelera `revenue-backtest`. Prueba `runRevenueBacktest`
// (el envoltorio de CLI) contra el dataset sintético committeado y contra entradas
// sintéticas construidas para el caso negativo (desajuste de ventanas, backtest que no
// supera baseline) -- la lógica de negocio en sí (`evaluateWalkForwardBacktest`) ya
// tiene su propia suite en tests/unit/domain-hotel/walk-forward-backtest.spec.ts; esto
// prueba el envoltorio (armado de serie + ventanas + zip con windowRevenues).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runRevenueBacktest, DEFAULT_INPUT, type RevenueBacktestInput } from "../../../scripts/skills/revenue-backtest.ts";

describe("revenue-backtest: dataset de ejemplo committeado", () => {
  it("procesa fixtures/revenue-backtest-sample.json y produce un resultado con 8 ventanas", () => {
    const input = JSON.parse(readFileSync(DEFAULT_INPUT, "utf8")) as RevenueBacktestInput;
    const { windowCount, result } = runRevenueBacktest(input);
    expect(windowCount).toBe(8);
    expect(result.windowsEvaluated).toBe(8);
    expect(result.engineTotalRevenue).toBeGreaterThan(result.baselineTotalRevenue);
  });
});

describe("revenue-backtest: casos negativos", () => {
  const baseInput: RevenueBacktestInput = {
    series: { startDate: "2026-01-01", endDate: "2026-06-30" },
    windowSpec: { trainDays: 60, testDays: 14, stepDays: 14 },
    counterfactualMethod: "misma_tarifa_periodo_anterior",
    windowRevenues: [],
  };

  it("lanza si windowRevenues no trae la misma cantidad de entradas que ventanas produce series+windowSpec", () => {
    expect(() => runRevenueBacktest({ ...baseInput, windowRevenues: [{ engineRevenue: 100, baselineRevenue: 100 }] })).toThrow(
      /desajuste_ventanas/,
    );
  });

  it("lanza si startDate/endDate no son fechas ISO válidas", () => {
    expect(() =>
      runRevenueBacktest({ ...baseInput, series: { startDate: "no-es-fecha", endDate: "2026-06-30" }, windowRevenues: [] }),
    ).toThrow(/serie_invalida/);
  });

  it("reporta passes=false (sin lanzar) cuando el motor pierde sistemáticamente vs. baseline -- resultado de negocio, no error", () => {
    const perdiendo: RevenueBacktestInput = {
      series: { startDate: "2026-01-01", endDate: "2026-06-30" },
      windowSpec: { trainDays: 60, testDays: 14, stepDays: 14 },
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      windowRevenues: Array.from({ length: 8 }, () => ({ engineRevenue: 90000, baselineRevenue: 100000 })),
    };
    const { result } = runRevenueBacktest(perdiendo);
    expect(result.passes).toBe(false);
    expect(result.failureReasons.length).toBeGreaterThan(0);
  });
});
