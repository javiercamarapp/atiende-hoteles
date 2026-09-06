// H07-005: restricciones de estadía (MinLOS/CTA/CTD) sobre el motor de cotización.
import { describe, expect, it } from "vitest";
import { computeQuote, QuoteError, type QuoteInput } from "@atiende-hoteles/domain-hotel";

function baseInput(overrides: Partial<QuoteInput> = {}): QuoteInput {
  return {
    checkInDate: "2026-07-01",
    checkOutDate: "2026-07-03",
    currency: "MXN",
    taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
    nightlyRates: [
      { date: "2026-07-01", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false },
      { date: "2026-07-02", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false },
      { date: "2026-07-03", price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false },
    ],
    ...overrides,
  };
}

function withArrivalNight(overrides: Partial<QuoteInput["nightlyRates"][number]>): QuoteInput {
  const input = baseInput();
  input.nightlyRates[0] = { ...input.nightlyRates[0]!, ...overrides };
  return input;
}

describe("restricciones de estadía: min-stay/CTA/CTD (H07-005)", () => {
  it("rechaza una llegada en una fecha cerrada a llegadas (CTA)", () => {
    const input = withArrivalNight({ closedToArrival: true });
    expect(() => computeQuote(input)).toThrow(QuoteError);
    try {
      computeQuote(input);
    } catch (err) {
      expect((err as QuoteError).code).toBe("cerrado_a_llegada");
    }
  });

  it("rechaza una estadía más corta que la estadía mínima de la fecha de llegada", () => {
    const input = withArrivalNight({ minStay: 3 }); // la estadía base es de 2 noches
    expect(() => computeQuote(input)).toThrow(QuoteError);
    try {
      computeQuote(input);
    } catch (err) {
      expect((err as QuoteError).code).toBe("estadia_minima_no_alcanzada");
    }
  });

  it("acepta una estadía que cumple exactamente la estadía mínima", () => {
    const input = withArrivalNight({ minStay: 2 });
    expect(computeQuote(input).nights).toBe(2);
  });

  it("rechaza una salida en una fecha cerrada a salidas (CTD)", () => {
    const input = baseInput();
    input.nightlyRates[2] = { ...input.nightlyRates[2]!, closedToDeparture: true }; // 2026-07-03 es checkOutDate
    expect(() => computeQuote(input)).toThrow(QuoteError);
    try {
      computeQuote(input);
    } catch (err) {
      expect((err as QuoteError).code).toBe("cerrado_a_salida");
    }
  });

  it("CTD en una noche que NO es la fecha de salida no afecta la cotización (solo importa la fecha de checkout)", () => {
    const input = baseInput();
    input.nightlyRates[1] = { ...input.nightlyRates[1]!, closedToDeparture: true }; // noche intermedia, no es checkout
    expect(computeQuote(input).nights).toBe(2);
  });

  it("una estadía de 0 noches (checkOutDate === checkInDate) es rechazada por el esquema, no solo por el motor", () => {
    expect(() =>
      computeQuote({ ...baseInput(), checkOutDate: "2026-07-01" } as unknown as QuoteInput),
    ).toThrow();
  });
});
