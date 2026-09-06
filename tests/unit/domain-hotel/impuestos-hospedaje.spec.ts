// REQ-BO-007: ISH QRoo (5% excl. alimentos), DSA (MXN 20/cuarto-noche), ISN 4%, IVA,
// ISR provisional, DIOT y retención de plataformas digitales (reforma 2026) -- un caso
// por impuesto (7 casos), cada uno un cálculo puro y parametrizado (H16-009/010/011/012).
import { describe, expect, it } from "vitest";
import {
  computeIva,
  computeIsh,
  computeDsa,
  computeIsn,
  computeIsrProvisional,
  computeDiotTotal,
  computeRetencionPlataformasDigitales,
} from "@atiende-hoteles/domain-hotel";

describe("REQ-BO-007 · impuestos/retenciones del hotel (7 casos)", () => {
  it("1) IVA: 16% sobre la base gravable", () => {
    expect(computeIva(1000, 0.16)).toBe(160);
  });

  it("2) ISH Quintana Roo: 5% sobre la contraprestación de hospedaje EXCLUYENDO alimentos", () => {
    // Base ya excluye A&B: 800 de hospedaje + 200 de A&B -> la base del ISH es 800.
    expect(computeIsh(800, 0.05)).toBe(40);
  });

  it("3) DSA: MXN 20/cuarto-noche ocupado, monto fijo (no porcentual)", () => {
    expect(computeDsa(3, 20)).toBe(60);
  });

  it("4) ISN: 4% sobre la base de nómina del periodo", () => {
    expect(computeIsn(50000, 0.04)).toBe(2000);
  });

  it("5) ISR provisional: tasa efectiva sobre la base gravable del periodo", () => {
    expect(computeIsrProvisional(20000, 0.1)).toBe(2000);
  });

  it("6) DIOT: suma de operaciones con terceros del periodo sin perder/duplicar ninguna", () => {
    const total = computeDiotTotal([{ amount: 1500 }, { amount: 2300.5 }, { amount: 0 }]);
    expect(total).toBe(3800.5);
  });

  it("7) Retención de plataformas digitales (reforma 2026): PF con ISR 4% + IVA 8% sobre el monto pagado por la plataforma", () => {
    const r = computeRetencionPlataformasDigitales(10000, "PF", { isrRate: 0.04, ivaRate: 0.08 });
    expect(r.isrAmount).toBe(400);
    expect(r.ivaAmount).toBe(800);
    expect(r.totalRetenido).toBe(1200);
  });

  it("caso adicional: PM (persona moral) usa 2.5% ISR + 8% IVA, distinto de PF", () => {
    const r = computeRetencionPlataformasDigitales(10000, "PM", { isrRate: 0.025, ivaRate: 0.08 });
    expect(r.isrAmount).toBe(250);
    expect(r.ivaAmount).toBe(800);
  });

  it("rechaza tasas/bases negativas en cada función (defensa en profundidad)", () => {
    expect(() => computeIva(-1, 0.16)).toThrow(RangeError);
    expect(() => computeIsh(100, -0.05)).toThrow(RangeError);
    expect(() => computeDsa(-1, 20)).toThrow(RangeError);
    expect(() => computeIsn(-1, 0.04)).toThrow(RangeError);
    expect(() => computeIsrProvisional(-1, 0.1)).toThrow(RangeError);
    expect(() => computeDiotTotal([{ amount: -1 }])).toThrow(RangeError);
    expect(() => computeRetencionPlataformasDigitales(-1, "PF", { isrRate: 0.04, ivaRate: 0.08 })).toThrow(RangeError);
  });
});
