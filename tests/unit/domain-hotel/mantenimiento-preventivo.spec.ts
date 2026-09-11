// REQ-HK-015 (docs/ACEPTACION.md): "Calendario de mantenimiento preventivo por activo
// crítico ajustado a ocupación y temporada; historial y costo por activo permite
// calcular recomendación reparar vs. reemplazar (verificado con 2 activos de costo
// distinto)." Unit puro (sin BD) de
// `packages/domain-hotel/src/mantenimiento/preventivo.ts`. El escenario de integración
// real contra embedded-postgres (activos + calendario + recomendación vía la API real)
// vive en `tests/integration/mantenimiento/preventivo.spec.ts`.
import { describe, expect, it } from "vitest";
import {
  RECURRING_FAILURE_COST_RATIO_THRESHOLD,
  RECURRING_FAILURE_MIN_COUNT,
  REPLACEMENT_COST_RATIO_THRESHOLD,
  adjustDueDateForRoomOccupancy,
  computeNextPreventiveDueDate,
  isMonthDayInSeasonWindow,
  recommendRepairOrReplace,
  type SeasonWindow,
} from "@atiende-hoteles/domain-hotel";

describe("isMonthDayInSeasonWindow", () => {
  it("detecta una fecha dentro de una ventana normal (no cruza fin de año)", () => {
    const window = { startMonthDay: "05-01", endMonthDay: "11-30" };
    expect(isMonthDayInSeasonWindow(new Date("2026-06-15T00:00:00.000Z"), window)).toBe(true);
    expect(isMonthDayInSeasonWindow(new Date("2026-05-01T00:00:00.000Z"), window)).toBe(true); // borde inicial inclusive
    expect(isMonthDayInSeasonWindow(new Date("2026-11-30T00:00:00.000Z"), window)).toBe(true); // borde final inclusive
    expect(isMonthDayInSeasonWindow(new Date("2026-12-01T00:00:00.000Z"), window)).toBe(false);
    expect(isMonthDayInSeasonWindow(new Date("2026-04-30T00:00:00.000Z"), window)).toBe(false);
  });

  it("soporta una ventana que cruza fin de año", () => {
    const window = { startMonthDay: "12-15", endMonthDay: "01-15" };
    expect(isMonthDayInSeasonWindow(new Date("2026-12-20T00:00:00.000Z"), window)).toBe(true);
    expect(isMonthDayInSeasonWindow(new Date("2027-01-10T00:00:00.000Z"), window)).toBe(true);
    expect(isMonthDayInSeasonWindow(new Date("2026-06-01T00:00:00.000Z"), window)).toBe(false);
  });
});

describe("computeNextPreventiveDueDate — calendario ajustado a temporada (REQ-HK-015)", () => {
  it("sin ventanas de temporada, el vencimiento es exactamente anchor + baseFrequencyDays", () => {
    const result = computeNextPreventiveDueDate({
      baseFrequencyDays: 90,
      lastCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
      installDate: new Date("2025-01-01T00:00:00.000Z"),
    });
    expect(result.dueDate.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(result.effectiveFrequencyDays).toBe(90);
    expect(result.appliedSeasonWindow).toBeNull();
  });

  it("usa installDate como ancla cuando nunca hubo una MP registrada (lastCompletedAt null)", () => {
    const result = computeNextPreventiveDueDate({
      baseFrequencyDays: 30,
      lastCompletedAt: null,
      installDate: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.dueDate.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  it("aprieta la frecuencia cuando el vencimiento base cae en una ventana de temporada (pre-huracanes)", () => {
    const preHuracanes: SeasonWindow = { label: "pre-huracanes", startMonthDay: "05-01", endMonthDay: "11-30", frequencyDays: 30 };
    // anchor 2026-03-01 + 90 días base = 2026-05-30, dentro de la ventana pre-huracanes.
    const result = computeNextPreventiveDueDate({
      baseFrequencyDays: 90,
      lastCompletedAt: new Date("2026-03-01T00:00:00.000Z"),
      installDate: new Date("2025-01-01T00:00:00.000Z"),
      seasonWindows: [preHuracanes],
    });
    expect(result.effectiveFrequencyDays).toBe(30);
    expect(result.appliedSeasonWindow?.label).toBe("pre-huracanes");
    expect(result.dueDate.toISOString()).toBe(
      new Date(new Date("2026-03-01T00:00:00.000Z").getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("NUNCA afloja el calendario: una ventana con frecuencia mayor a la base se ignora", () => {
    const ventanaFloja: SeasonWindow = { label: "temporada baja", startMonthDay: "01-01", endMonthDay: "12-31", frequencyDays: 365 };
    const result = computeNextPreventiveDueDate({
      baseFrequencyDays: 30,
      lastCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
      installDate: new Date("2025-01-01T00:00:00.000Z"),
      seasonWindows: [ventanaFloja],
    });
    expect(result.effectiveFrequencyDays).toBe(30);
    expect(result.appliedSeasonWindow).toBeNull();
  });

  it("con dos ventanas aplicables al mismo tiempo, usa la MÁS apretada de las dos", () => {
    const preHuracanes: SeasonWindow = { label: "pre-huracanes", startMonthDay: "01-01", endMonthDay: "12-31", frequencyDays: 30 };
    const postSargazo: SeasonWindow = { label: "post-sargazo", startMonthDay: "01-01", endMonthDay: "12-31", frequencyDays: 15 };
    const result = computeNextPreventiveDueDate({
      baseFrequencyDays: 90,
      lastCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
      installDate: new Date("2025-01-01T00:00:00.000Z"),
      seasonWindows: [preHuracanes, postSargazo],
    });
    expect(result.effectiveFrequencyDays).toBe(15);
    expect(result.appliedSeasonWindow?.label).toBe("post-sargazo");
  });

  it("rechaza baseFrequencyDays <= 0", () => {
    expect(() =>
      computeNextPreventiveDueDate({ baseFrequencyDays: 0, lastCompletedAt: null, installDate: new Date() }),
    ).toThrow(RangeError);
  });
});

describe("adjustDueDateForRoomOccupancy — REQ-HK-015 'MP en habitaciones vacías'", () => {
  it("no pospone si la habitación ya está vacía en la fecha de vencimiento", () => {
    const dueDate = new Date("2026-06-01T00:00:00.000Z");
    const result = adjustDueDateForRoomOccupancy(dueDate, () => false);
    expect(result.adjustedDate.toISOString()).toBe(dueDate.toISOString());
    expect(result.postponedDays).toBe(0);
    expect(result.forcedDespiteOccupancy).toBe(false);
  });

  it("pospone día por día hasta encontrar la habitación vacía", () => {
    const dueDate = new Date("2026-06-01T00:00:00.000Z");
    // Ocupada los primeros 3 días desde dueDate, libre al cuarto.
    const ocupadaHasta = new Date(dueDate.getTime() + 3 * 24 * 60 * 60 * 1000).getTime();
    const result = adjustDueDateForRoomOccupancy(dueDate, (d) => d.getTime() <= ocupadaHasta);
    expect(result.postponedDays).toBe(4);
    expect(result.forcedDespiteOccupancy).toBe(false);
    expect(result.adjustedDate.toISOString()).toBe(new Date(dueDate.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString());
  });

  it("si nunca se libera dentro de maxLookaheadDays, se fuerza en la fecha original (nunca posponer indefinidamente un activo crítico)", () => {
    const dueDate = new Date("2026-06-01T00:00:00.000Z");
    const result = adjustDueDateForRoomOccupancy(dueDate, () => true, 5);
    expect(result.forcedDespiteOccupancy).toBe(true);
    expect(result.adjustedDate.toISOString()).toBe(dueDate.toISOString());
    expect(result.postponedDays).toBe(0);
  });

  it("un activo sin habitación (isRoomOccupied siempre false) nunca se pospone", () => {
    const dueDate = new Date("2026-06-01T00:00:00.000Z");
    const result = adjustDueDateForRoomOccupancy(dueDate, () => false);
    expect(result.postponedDays).toBe(0);
  });
});

describe("recommendRepairOrReplace — REQ-HK-015 'verificado con 2 activos de costo distinto'", () => {
  it("sin historial de costo, siempre recomienda reparar", () => {
    const result = recommendRepairOrReplace({ replacementCost: 10_000, trailingRepairCosts: [] });
    expect(result.recommendation).toBe("reparar");
    expect(result.repairCount).toBe(0);
    expect(result.costRatio).toBe(0);
  });

  it("REPLACEMENT_COST_RATIO_THRESHOLD es 0.5 (regla del 50%)", () => {
    expect(REPLACEMENT_COST_RATIO_THRESHOLD).toBe(0.5);
  });

  // El caso central del criterio de aceptación: dos activos con el MISMO costo
  // acumulado de reparaciones ($6,000) pero costo de REEMPLAZO distinto producen
  // recomendaciones DIFERENTES -- el activo barato cruza el 50%, el caro no.
  it("dos activos de costo distinto con el mismo historial de reparación producen recomendaciones distintas", () => {
    const historialReparaciones = [2000, 2500, 1500]; // $6,000 acumulados

    const activoBarato = recommendRepairOrReplace({ replacementCost: 8_000, trailingRepairCosts: historialReparaciones });
    expect(activoBarato.costRatio).toBeCloseTo(0.75, 5);
    expect(activoBarato.recommendation).toBe("reemplazar");

    const activoCaro = recommendRepairOrReplace({ replacementCost: 60_000, trailingRepairCosts: historialReparaciones });
    expect(activoCaro.costRatio).toBeCloseTo(0.1, 5);
    expect(activoCaro.recommendation).toBe("reparar");
  });

  it("reincidencia (>=3 reparaciones) con costo acumulado >= 20% del reemplazo recomienda reemplazar aunque no llegue al 50%", () => {
    expect(RECURRING_FAILURE_MIN_COUNT).toBe(3);
    expect(RECURRING_FAILURE_COST_RATIO_THRESHOLD).toBe(0.2);
    const result = recommendRepairOrReplace({ replacementCost: 10_000, trailingRepairCosts: [800, 700, 900] }); // 3 eventos, 24%
    expect(result.repairCount).toBe(3);
    expect(result.costRatio).toBeCloseTo(0.24, 5);
    expect(result.recommendation).toBe("reemplazar");
  });

  it("2 reparaciones baratas (sin reincidencia suficiente ni 50%) siguen recomendando reparar", () => {
    const result = recommendRepairOrReplace({ replacementCost: 10_000, trailingRepairCosts: [500, 500] }); // 2 eventos, 10%
    expect(result.recommendation).toBe("reparar");
  });

  it("rechaza replacementCost <= 0", () => {
    expect(() => recommendRepairOrReplace({ replacementCost: 0, trailingRepairCosts: [] })).toThrow(RangeError);
  });
});
