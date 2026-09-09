// REQ-BO-010 (P0/BP): espejo puro (sin DB) de `packages/domain-hotel/src/pl/usaliPL.ts`
// -- complementa (nunca duplica) tests/integration/bo/pl-usali.spec.ts, que verifica
// que la agregación SQL real alimenta estas mismas fórmulas con los números correctos
// (mismo criterio que tests/unit/domain-hotel/revenue-engine-gate.spec.ts frente a su
// contraparte de integración).
import { describe, expect, it } from "vitest";
import {
  buildCashFlow13Weeks,
  buildDepartmentalStatements,
  buildOwnersReport,
  buildUsaliPL,
  computeDynamicBreakeven,
  forecastDailyRevenue90Days,
  CASH_PROJECTION_WEEKS,
} from "@atiende-hoteles/domain-hotel";

describe("buildDepartmentalStatements", () => {
  it("calcula utilidad departamental y margen a partir de ingresos/gastos reales", () => {
    const statements = buildDepartmentalStatements(
      [
        { department: "rooms", revenue: 10000 },
        { department: "food_beverage", revenue: 2000 },
      ],
      [
        { department: "rooms", category: "nomina", amount: 3000 },
        { department: "rooms", category: "otros_gastos", amount: 1000 },
        { department: "food_beverage", category: "costo_ventas", amount: 800 },
      ],
    );

    const rooms = statements.find((s) => s.department === "rooms")!;
    expect(rooms.totalExpenses).toBe(4000);
    expect(rooms.departmentalProfit).toBe(6000);
    expect(rooms.profitMarginPct).toBeCloseTo(60, 6);

    const ood = statements.find((s) => s.department === "otros_departamentos")!;
    expect(ood.revenue).toBe(0);
    expect(ood.profitMarginPct).toBeNull(); // sin ingreso: nunca se fabrica un 0%
  });
});

describe("buildUsaliPL", () => {
  it("ensambla la jerarquía completa Ingresos -> GOP -> EBITDA -> Utilidad neta", () => {
    const pl = buildUsaliPL({
      departmentRevenue: [
        { department: "rooms", revenue: 10000 },
        { department: "food_beverage", revenue: 2000 },
      ],
      departmentExpenses: [
        { department: "rooms", category: "nomina", amount: 3000 },
        { department: "food_beverage", category: "costo_ventas", amount: 500 },
      ],
      undistributedExpenses: [
        { department: "admin_general", amount: 1000 },
        { department: "utilities", amount: 500 },
      ],
      managementFeeAmount: 400,
      nonOperatingExpenseAmount: 200,
    });

    expect(pl.ingresosTotales).toBe(12000);
    expect(pl.utilidadDepartamentalTotal).toBe(7000 + 1500);
    expect(pl.totalGastosNoDistribuidos).toBe(1500);
    expect(pl.gop).toBe(7000);
    expect(pl.ebitda).toBe(6600);
    expect(pl.utilidadNeta).toBe(6400);
    expect(pl.gopMarginPct).toBeCloseTo((7000 / 12000) * 100, 6);
  });

  it("con ingreso cero no fabrica un margen: gopMarginPct es null", () => {
    const pl = buildUsaliPL({
      departmentRevenue: [],
      departmentExpenses: [],
      undistributedExpenses: [],
      managementFeeAmount: 0,
      nonOperatingExpenseAmount: 0,
    });
    expect(pl.ingresosTotales).toBe(0);
    expect(pl.gopMarginPct).toBeNull();
  });
});

describe("computeDynamicBreakeven", () => {
  it("recalcula el punto de equilibrio con ADR/costos reales del periodo (margen positivo)", () => {
    const result = computeDynamicBreakeven({
      fixedCosts: 9500,
      otherDepartmentsProfit: 250,
      realAdr: 1000,
      roomsVariableCostPerOccupiedRoom: 9000 / 69,
      availableRoomNights: 140,
      actualOccupiedRoomNights: 69,
    });

    const expectedBreakevenRoomNights = 9250 / (1000 - 9000 / 69);
    expect(result.fixedCostsNetOfOtherDepartments).toBeCloseTo(9250, 6);
    expect(result.breakevenOccupiedRoomNights).toBeCloseTo(expectedBreakevenRoomNights, 6);
    expect(result.breakevenOccupancyPct).toBeCloseTo((expectedBreakevenRoomNights / 140) * 100, 6);
    expect(result.occupancyGapPct!).toBeGreaterThan(0); // 69 noches reales muy por encima del equilibrio
  });

  it("nunca fabrica un punto de equilibrio cuando el margen de contribución no es positivo", () => {
    const result = computeDynamicBreakeven({
      fixedCosts: 9500,
      otherDepartmentsProfit: 0,
      realAdr: 500,
      roomsVariableCostPerOccupiedRoom: 600, // el costo real supera el ADR real
      availableRoomNights: 140,
      actualOccupiedRoomNights: 69,
    });
    expect(result.contributionMarginPerRoom).toBeLessThan(0);
    expect(result.breakevenOccupiedRoomNights).toBeNull();
    expect(result.breakevenOccupancyPct).toBeNull();
    expect(result.occupancyGapPct).toBeNull();
  });
});

describe("forecastDailyRevenue90Days", () => {
  it("con menos de 2 puntos devuelve null (nunca un pronóstico fabricado)", () => {
    expect(forecastDailyRevenue90Days([])).toBeNull();
    expect(forecastDailyRevenue90Days([{ date: "2026-01-01", value: 100 }])).toBeNull();
  });

  it("con historia suficiente devuelve exactamente 90 puntos consecutivos", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ date: `d${i}`, value: 1000 + i * 10 }));
    const points = forecastDailyRevenue90Days(history);
    expect(points).toHaveLength(90);
    expect(points!.map((p) => p.stepsAhead)).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));
  });
});

describe("buildCashFlow13Weeks", () => {
  it("exige exactamente 13 semanas", () => {
    expect(() => buildCashFlow13Weeks(0, [])).toThrow(/semanas_invalidas/);
  });

  it("acumula el saldo semana a semana", () => {
    const weeks = Array.from({ length: CASH_PROJECTION_WEEKS }, (_, i) => ({
      weekStart: `w${i}-start`,
      weekEnd: `w${i}-end`,
      onBooksInflow: i === 0 ? 1000 : 0,
      expenseRunRate: 100,
    }));
    const result = buildCashFlow13Weeks(500, weeks);
    expect(result[0]!.netChange).toBe(900);
    expect(result[0]!.endingBalance).toBe(1400);
    expect(result.at(-1)!.endingBalance).toBe(500 + 900 + 12 * -100);
  });
});

describe("buildOwnersReport", () => {
  it("alerta cuando la ocupación real está por debajo del punto de equilibrio", () => {
    const breakeven = computeDynamicBreakeven({
      fixedCosts: 20000,
      otherDepartmentsProfit: 0,
      realAdr: 1000,
      roomsVariableCostPerOccupiedRoom: 200,
      availableRoomNights: 140,
      actualOccupiedRoomNights: 10, // muy por debajo
    });
    const report = buildOwnersReport({
      periodo: { desde: "2026-01-01", hasta: "2026-01-14" },
      pl: buildUsaliPL({
        departmentRevenue: [{ department: "rooms", revenue: 10000 }],
        departmentExpenses: [],
        undistributedExpenses: [],
        managementFeeAmount: 0,
        nonOperatingExpenseAmount: 0,
      }),
      kpis: { adr: 1000, revpar: 71, occupancyPct: breakeven.actualOccupancyPct },
      breakeven,
      forecastSummary: null,
      cashSummary: { saldoInicial: 0, saldoFinal13Semanas: 0, cambioNetoTotal: 0, semanasConFlujoNegativo: 0 },
    });

    expect(report.porEncimaDePuntoDeEquilibrio).toBe(false);
    expect(report.alertas.some((a) => a.includes("por debajo del punto de equilibrio"))).toBe(true);
  });
});
