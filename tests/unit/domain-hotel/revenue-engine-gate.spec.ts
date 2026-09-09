// REQ-REV-003 (P0/GOB): el motor de revenue opera en shadow un mínimo de 90 días, con
// backtest walk-forward obligatorio + aprobación del fundador antes de habilitar
// autopilot, y pasa entretanto por "propone" con límite de variación ±10-15%. Espejo de
// aplicación de la máquina de estados real de
// `packages/db/migrations/0082_revenue_engine_gate.sql` (ver
// tests/unit/schema/revenue-engine-gate.spec.ts para la verificación contra Postgres
// real vía PGlite) — mismo criterio que estado-maquina.spec.ts frente a la reserva.
import { describe, expect, it } from "vitest";
import {
  MIN_SHADOW_DAYS,
  PROPONE_VARIATION_PCT_MAX,
  PROPONE_VARIATION_PCT_MIN,
  RevenueGateError,
  REVENUE_GATE_STATES,
  assertValidProponeVariationPct,
  daysElapsed,
  evaluateGateTransition,
  evaluateRevenueProposal,
  hasMetMinimumShadowPeriod,
  isDemotion,
  isPriceChangeWithinProponeLimit,
  isPromotion,
} from "@atiende-hoteles/domain-hotel";
import { evaluateWalkForwardBacktest, type WalkForwardBacktestResult } from "@atiende-hoteles/domain-hotel";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number, now: Date = new Date("2026-09-08T00:00:00Z")): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

function passingBacktest(overrides: Partial<WalkForwardBacktestResult> = {}): WalkForwardBacktestResult {
  return evaluateWalkForwardBacktest({
    counterfactualMethod: "misma_tarifa_periodo_anterior",
    evaluations: [
      { window: { trainStart: "a", trainEnd: "b", testStart: "c", testEnd: "d" }, engineRevenue: 1200, baselineRevenue: 1000 },
      { window: { trainStart: "a", trainEnd: "b", testStart: "c", testEnd: "d" }, engineRevenue: 1100, baselineRevenue: 1000 },
      { window: { trainStart: "a", trainEnd: "b", testStart: "c", testEnd: "d" }, engineRevenue: 1300, baselineRevenue: 1000 },
    ],
    ...overrides,
  });
}

describe("REVENUE_GATE_STATES / constantes (REQ-REV-003)", () => {
  it("expone exactamente los 3 gates en orden", () => {
    expect(REVENUE_GATE_STATES).toEqual(["shadow", "propone", "autopilot"]);
  });

  it("el mínimo de shadow es 90 días", () => {
    expect(MIN_SHADOW_DAYS).toBe(90);
  });

  it("la banda de variación en propone es ±10-15%", () => {
    expect(PROPONE_VARIATION_PCT_MIN).toBe(10);
    expect(PROPONE_VARIATION_PCT_MAX).toBe(15);
  });
});

describe("daysElapsed / hasMetMinimumShadowPeriod", () => {
  it("cuenta días completos, sin redondear hacia arriba", () => {
    const now = new Date("2026-09-08T00:00:00Z");
    expect(daysElapsed(new Date("2026-09-07T12:00:00Z"), now)).toBe(0); // 12h, no 1 día
    expect(daysElapsed(new Date("2026-09-07T00:00:00Z"), now)).toBe(1);
    expect(daysElapsed(daysAgo(90, now), now)).toBe(90);
    expect(daysElapsed(daysAgo(89, now), now)).toBe(89);
  });

  it("89 días NO cumple el mínimo; 90 sí", () => {
    const now = new Date("2026-09-08T00:00:00Z");
    expect(hasMetMinimumShadowPeriod(daysAgo(89, now), now)).toBe(false);
    expect(hasMetMinimumShadowPeriod(daysAgo(90, now), now)).toBe(true);
    expect(hasMetMinimumShadowPeriod(daysAgo(91, now), now)).toBe(true);
  });
});

describe("isPromotion / isDemotion", () => {
  it("solo shadow->propone y propone->autopilot son promociones (un escalón)", () => {
    expect(isPromotion("shadow", "propone")).toBe(true);
    expect(isPromotion("propone", "autopilot")).toBe(true);
    expect(isPromotion("shadow", "autopilot")).toBe(false); // saltar un escalón NO es promoción válida
    expect(isPromotion("propone", "shadow")).toBe(false);
    expect(isPromotion("shadow", "shadow")).toBe(false);
  });

  it("cualquier retroceso es una democión", () => {
    expect(isDemotion("autopilot", "shadow")).toBe(true);
    expect(isDemotion("autopilot", "propone")).toBe(true);
    expect(isDemotion("propone", "shadow")).toBe(true);
    expect(isDemotion("shadow", "propone")).toBe(false);
    expect(isDemotion("shadow", "shadow")).toBe(false);
  });
});

describe("evaluateGateTransition — shadow -> propone", () => {
  const now = new Date("2026-09-08T00:00:00Z");

  it("bloquea con menos de 90 días en shadow, con el motivo exacto", () => {
    const result = evaluateGateTransition("shadow", "propone", { shadowStartedAt: daysAgo(45, now), now });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain("shadow_insuficiente");
    expect(result.reasons[0]).toContain("45");
  });

  it("permite la transición con exactamente 90 días", () => {
    const result = evaluateGateTransition("shadow", "propone", { shadowStartedAt: daysAgo(90, now), now });
    expect(result).toEqual({ allowed: true, reasons: [] });
  });

  it("bloquea si no se aporta shadowStartedAt", () => {
    const result = evaluateGateTransition("shadow", "propone", { now });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain("shadow_started_at_faltante");
  });
});

describe("evaluateGateTransition — propone -> autopilot", () => {
  const now = new Date("2026-09-08T00:00:00Z");
  const proponeStartedAt = daysAgo(30, now);

  it("bloquea sin backtest", () => {
    const result = evaluateGateTransition("propone", "autopilot", {
      now,
      proponeStartedAt,
      founderApprovalGranted: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("backtest_faltante"))).toBe(true);
  });

  it("bloquea con un backtest que no supera el baseline", () => {
    const failingBacktest = evaluateWalkForwardBacktest({
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      evaluations: [{ window: { trainStart: "a", trainEnd: "b", testStart: "c", testEnd: "d" }, engineRevenue: 900, baselineRevenue: 1000 }],
    });
    const result = evaluateGateTransition("propone", "autopilot", {
      now,
      proponeStartedAt,
      backtest: failingBacktest,
      backtestRanAt: daysAgo(1, now),
      founderApprovalGranted: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("backtest_no_supera_baseline"))).toBe(true);
  });

  it("bloquea un backtest que pasa pero es anterior a que el hotel entrara en propone (obsoleto)", () => {
    const result = evaluateGateTransition("propone", "autopilot", {
      now,
      proponeStartedAt,
      backtest: passingBacktest(),
      backtestRanAt: daysAgo(60, now), // antes de proponeStartedAt (30 días atrás)
      founderApprovalGranted: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("backtest_obsoleto"))).toBe(true);
  });

  it("bloquea sin aprobación del fundador aunque el backtest pase (REQ-GOB-012)", () => {
    const result = evaluateGateTransition("propone", "autopilot", {
      now,
      proponeStartedAt,
      backtest: passingBacktest(),
      backtestRanAt: daysAgo(1, now),
      founderApprovalGranted: false,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("aprobacion_fundador_requerida"))).toBe(true);
  });

  it("permite la transición con backtest vigente que pasa + aprobación del fundador", () => {
    const result = evaluateGateTransition("propone", "autopilot", {
      now,
      proponeStartedAt,
      backtest: passingBacktest(),
      backtestRanAt: daysAgo(1, now),
      founderApprovalGranted: true,
    });
    expect(result).toEqual({ allowed: true, reasons: [] });
  });

  it("acumula TODAS las razones de bloqueo a la vez (backtest y aprobación faltantes simultáneamente)", () => {
    const result = evaluateGateTransition("propone", "autopilot", { now, proponeStartedAt });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });
});

describe("evaluateGateTransition — reglas de la máquina de estados", () => {
  it("no-op (from === to) siempre se permite", () => {
    expect(evaluateGateTransition("shadow", "shadow")).toEqual({ allowed: true, reasons: [] });
    expect(evaluateGateTransition("autopilot", "autopilot")).toEqual({ allowed: true, reasons: [] });
  });

  it("nunca permite saltar directo de shadow a autopilot", () => {
    const result = evaluateGateTransition("shadow", "autopilot", {
      shadowStartedAt: daysAgo(200),
      backtest: passingBacktest(),
      founderApprovalGranted: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toContain("transicion_no_permitida");
  });

  it("cualquier democión se permite sin condiciones (freno de emergencia)", () => {
    expect(evaluateGateTransition("autopilot", "shadow")).toEqual({ allowed: true, reasons: [] });
    expect(evaluateGateTransition("autopilot", "propone")).toEqual({ allowed: true, reasons: [] });
    expect(evaluateGateTransition("propone", "shadow")).toEqual({ allowed: true, reasons: [] });
  });
});

describe("assertValidProponeVariationPct / isPriceChangeWithinProponeLimit", () => {
  it("rechaza un límite fuera de la banda ±10-15%", () => {
    expect(() => assertValidProponeVariationPct(5)).toThrow(RevenueGateError);
    expect(() => assertValidProponeVariationPct(20)).toThrow(RevenueGateError);
    expect(() => assertValidProponeVariationPct(9.9)).toThrow(RevenueGateError);
    expect(() => assertValidProponeVariationPct(15.1)).toThrow(RevenueGateError);
  });

  it("acepta los bordes exactos de la banda", () => {
    expect(() => assertValidProponeVariationPct(10)).not.toThrow();
    expect(() => assertValidProponeVariationPct(15)).not.toThrow();
  });

  it("un cambio dentro del límite se acepta, uno fuera se rechaza", () => {
    expect(isPriceChangeWithinProponeLimit(1000, 1100, 10)).toBe(true); // +10% exacto
    expect(isPriceChangeWithinProponeLimit(1000, 1101, 10)).toBe(false); // +10.1%
    expect(isPriceChangeWithinProponeLimit(1000, 900, 10)).toBe(true); // -10% (baja de precio también cuenta)
    expect(isPriceChangeWithinProponeLimit(1000, 850, 15)).toBe(true); // -15% exacto con banda ampliada
  });

  it("rechaza un baseline no positivo", () => {
    expect(() => isPriceChangeWithinProponeLimit(0, 100, 10)).toThrow(RevenueGateError);
    expect(() => isPriceChangeWithinProponeLimit(-5, 100, 10)).toThrow(RevenueGateError);
  });

  it("rechaza un precio propuesto negativo", () => {
    expect(() => isPriceChangeWithinProponeLimit(1000, -1, 10)).toThrow(RevenueGateError);
  });
});

describe("evaluateRevenueProposal (REQ-REV-003: shadow nunca ejecuta, propone limita y exige aprobación, autopilot pleno libre)", () => {
  it("en shadow, NUNCA se permite ejecutar aunque el cambio sea mínimo", () => {
    const result = evaluateRevenueProposal("shadow", { baselinePrice: 1000, proposedPrice: 1001, maxVariationPct: 15 });
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
    expect(result.reasons[0]).toContain("modo_shadow");
  });

  it("en propone, un cambio dentro del límite requiere aprobación pero es elegible", () => {
    const result = evaluateRevenueProposal("propone", { baselinePrice: 1000, proposedPrice: 1100, maxVariationPct: 10 });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.withinVariationLimit).toBe(true);
  });

  it("en propone, un cambio que excede el límite se rechaza aunque hubiera aprobación", () => {
    const result = evaluateRevenueProposal("propone", { baselinePrice: 1000, proposedPrice: 1200, maxVariationPct: 10 });
    expect(result.allowed).toBe(false);
    expect(result.withinVariationLimit).toBe(false);
    expect(result.reasons[0]).toContain("variacion_excede_limite");
  });

  it("en autopilot pleno, no hay límite de variación ni aprobación requerida", () => {
    const result = evaluateRevenueProposal("autopilot", { baselinePrice: 1000, proposedPrice: 5000, maxVariationPct: 15 });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.withinVariationLimit).toBe(true);
  });
});
