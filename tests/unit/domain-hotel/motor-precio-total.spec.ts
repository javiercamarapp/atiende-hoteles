// REQ-REV-001: toda cotización pasa por el motor de precio total determinista
// (neto + IVA + ISH); ninguna ruta de código permite a un LLM calcular/redondear/fijar
// el precio final.
import { describe, expect, it } from "vitest";
import { computeQuote, QuoteError, type QuoteInput } from "@atiende-hoteles/domain-hotel";

function baseInput(overrides: Partial<QuoteInput> = {}): QuoteInput {
  return {
    checkInDate: "2026-03-10",
    checkOutDate: "2026-03-13",
    currency: "MXN",
    taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
    nightlyRates: [
      { date: "2026-03-10", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false },
      { date: "2026-03-11", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false },
      { date: "2026-03-12", price: 1200, minStay: 1, closedToArrival: false, closedToDeparture: false },
      { date: "2026-03-13", price: 1200, minStay: 1, closedToArrival: false, closedToDeparture: false },
    ],
    ...overrides,
  };
}

describe("motor de precio total determinista (REQ-REV-001)", () => {
  it("calcula neto = suma de noches, y total = neto + IVA + ISH exactamente", () => {
    const quote = computeQuote(baseInput());
    expect(quote.nights).toBe(3);
    expect(quote.netAmount).toBe(3200); // 1000 + 1000 + 1200
    expect(quote.ivaAmount).toBe(512); // 3200 * 0.16
    expect(quote.ishAmount).toBe(96); // 3200 * 0.03
    expect(quote.totalAmount).toBe(3808);
  });

  it("es determinista: misma entrada produce exactamente la misma salida siempre", () => {
    const a = computeQuote(baseInput());
    const b = computeQuote(baseInput());
    expect(a).toEqual(b);
  });

  it("respeta impuestos distintos por hotel (parámetro, no una tasa fija en código)", () => {
    const quote = computeQuote(baseInput({ taxConfig: { ivaRate: 0, ishRate: 0 } }));
    expect(quote.ivaAmount).toBe(0);
    expect(quote.ishAmount).toBe(0);
    expect(quote.totalAmount).toBe(quote.netAmount);
  });

  it("rechaza una estadía de 0 noches (checkOutDate = checkInDate)", () => {
    expect(() =>
      computeQuote({ ...baseInput(), checkOutDate: "2026-03-10", nightlyRates: [baseInput().nightlyRates[0]!] }),
    ).toThrow(/checkOutDate debe ser posterior/);
  });

  it("rechaza cuando falta la tarifa de alguna noche del rango (nunca inventa un precio)", () => {
    const input = baseInput();
    input.nightlyRates = input.nightlyRates.filter((r) => r.date !== "2026-03-12");
    expect(() => computeQuote(input)).toThrow(QuoteError);
    try {
      computeQuote(input);
    } catch (err) {
      expect((err as QuoteError).code).toBe("sin_tarifa");
    }
  });

  it("cambio de mes: 28 feb -> 2 mar cuenta 2 noches sin saltarse ni duplicar el 1 de marzo", () => {
    const input = baseInput({
      checkInDate: "2026-02-28",
      checkOutDate: "2026-03-02",
      nightlyRates: [
        { date: "2026-02-28", price: 900, minStay: 1, closedToArrival: false, closedToDeparture: false },
        { date: "2026-03-01", price: 900, minStay: 1, closedToArrival: false, closedToDeparture: false },
        { date: "2026-03-02", price: 900, minStay: 1, closedToArrival: false, closedToDeparture: false },
      ],
    });
    const quote = computeQuote(input);
    expect(quote.nights).toBe(2);
    expect(quote.nightlyBreakdown.map((n) => n.date)).toEqual(["2026-02-28", "2026-03-01"]);
  });

  it("estadía que cruza la fecha histórica de cambio de horario en México (1er domingo de abril de 2025) cuenta noches correctamente", () => {
    // Antes de la reforma de 2022, México adelantaba el reloj el primer domingo de
    // abril. computeQuote usa fechas calendario UTC puras (sin componente de hora):
    // el resultado debe ser idéntico exista o no DST vigente esa fecha en el sistema.
    const input = baseInput({
      checkInDate: "2025-04-04",
      checkOutDate: "2025-04-07",
      nightlyRates: [
        { date: "2025-04-04", price: 800, minStay: 1, closedToArrival: false, closedToDeparture: false },
        { date: "2025-04-05", price: 800, minStay: 1, closedToArrival: false, closedToDeparture: false },
        { date: "2025-04-06", price: 800, minStay: 1, closedToArrival: false, closedToDeparture: false },
        { date: "2025-04-07", price: 800, minStay: 1, closedToArrival: false, closedToDeparture: false },
      ],
    });
    const quote = computeQuote(input);
    expect(quote.nights).toBe(3);
    expect(quote.nightlyBreakdown.map((n) => n.date)).toEqual(["2025-04-04", "2025-04-05", "2025-04-06"]);
  });
});
