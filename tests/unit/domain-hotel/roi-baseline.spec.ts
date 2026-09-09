// REQ-REV-018 (P0/OBS-GOB, BP-015/BP-131): espejo puro de la máquina de estados real de
// `packages/db/migrations/0120_roi_baseline_cobro_resultado.sql` (ver
// tests/adversarial/roi-sin-linea-base.spec.ts para la verificación contra Postgres
// real) -- mismo criterio que tests/unit/domain-hotel/revenue-engine-gate.spec.ts frente
// a su contraparte de integración.
import { describe, expect, it } from "vitest";
import {
  BASELINE_SIGNING_WINDOW_DAYS,
  RoiBaselineError,
  assertBaselineSignableWithinWeek1,
  daysBetweenRoiBaseline,
  evaluateCobroPorResultadoActivation,
  isRoiBaselineWithinWeek1,
} from "@atiende-hoteles/domain-hotel";

const activadoEn = new Date("2026-01-01T00:00:00Z");

function daysAfter(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

describe("REQ-REV-018: ventana de 'semana 1' para firmar una línea base", () => {
  it("BASELINE_SIGNING_WINDOW_DAYS es 7 (BP-015/BP-131: 'semana 1')", () => {
    expect(BASELINE_SIGNING_WINDOW_DAYS).toBe(7);
  });

  it("daysBetween calcula días con fracción, incluso negativos", () => {
    expect(daysBetweenRoiBaseline(activadoEn, daysAfter(activadoEn, 3))).toBeCloseTo(3, 6);
    expect(daysBetweenRoiBaseline(activadoEn, daysAfter(activadoEn, -1))).toBeCloseTo(-1, 6);
  });

  it("firmar el mismo día de la activación (día 0) está dentro de la semana 1", () => {
    expect(isRoiBaselineWithinWeek1(activadoEn, activadoEn)).toBe(true);
    expect(() => assertBaselineSignableWithinWeek1(activadoEn, activadoEn)).not.toThrow();
  });

  it("firmar exactamente a los 7 días está dentro de la semana 1 (límite inclusivo)", () => {
    const firmadoEn = daysAfter(activadoEn, 7);
    expect(isRoiBaselineWithinWeek1(activadoEn, firmadoEn)).toBe(true);
    expect(() => assertBaselineSignableWithinWeek1(activadoEn, firmadoEn)).not.toThrow();
  });

  it("firmar a los 7.5 días (fuera de la semana 1) se rechaza con el código estable", () => {
    const firmadoEn = daysAfter(activadoEn, 7.5);
    expect(isRoiBaselineWithinWeek1(activadoEn, firmadoEn)).toBe(false);
    expect(() => assertBaselineSignableWithinWeek1(activadoEn, firmadoEn)).toThrow(RoiBaselineError);
    expect(() => assertBaselineSignableWithinWeek1(activadoEn, firmadoEn)).toThrow(/linea_base_fuera_de_semana_1/);
  });

  it("firmar ANTES de la activación se rechaza con su propio código estable", () => {
    const firmadoEn = daysAfter(activadoEn, -0.1);
    expect(isRoiBaselineWithinWeek1(activadoEn, firmadoEn)).toBe(false);
    expect(() => assertBaselineSignableWithinWeek1(activadoEn, firmadoEn)).toThrow(/firma_anterior_a_activacion/);
  });
});

describe("REQ-REV-018: 'ningún cobro por resultado se activa sin línea base firmada'", () => {
  const params = { hotelId: "hotel-1", agentName: "motor_revenue" };

  it("sin ninguna línea base registrada: bloqueado (linea_base_no_encontrada)", () => {
    const result = evaluateCobroPorResultadoActivation(null, params);
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(";")).toMatch(/linea_base_no_encontrada/);
  });

  it("con una línea base EN BORRADOR (sin firmar): bloqueado (linea_base_no_firmada)", () => {
    const result = evaluateCobroPorResultadoActivation(
      { hotelId: "hotel-1", agentName: "motor_revenue", firmadoEn: null },
      params,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(";")).toMatch(/linea_base_no_firmada/);
  });

  it("con una línea base de OTRO agente/hotel: bloqueado (linea_base_no_corresponde), nunca se cuela por coincidencia", () => {
    const result = evaluateCobroPorResultadoActivation(
      { hotelId: "hotel-2", agentName: "motor_revenue", firmadoEn: new Date() },
      params,
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(";")).toMatch(/linea_base_no_corresponde/);

    const otroAgente = evaluateCobroPorResultadoActivation(
      { hotelId: "hotel-1", agentName: "otro_agente", firmadoEn: new Date() },
      params,
    );
    expect(otroAgente.allowed).toBe(false);
  });

  it("con línea base FIRMADA del mismo hotel/agente: permitido -- el gate discrimina de verdad, no solo deniega siempre", () => {
    const result = evaluateCobroPorResultadoActivation(
      { hotelId: "hotel-1", agentName: "motor_revenue", firmadoEn: new Date() },
      params,
    );
    expect(result.allowed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });
});
