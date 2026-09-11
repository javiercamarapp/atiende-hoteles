// REQ-RES-015: "Motor de reservas opera en USD/MXN simultáneamente; una tarifa fijada
// en USD se convierte a MXN de reporte usando el tipo de cambio vigente registrado,
// verificado con dos monedas activas en el mismo periodo" (docs/ACEPTACION.md).
import { describe, expect, it } from "vitest";
import {
  ExchangeRateError,
  resolveVigenteExchangeRate,
  convertToReportingCurrency,
  summarizeMultiCurrencyTotals,
  type ExchangeRateRecord,
} from "@atiende-hoteles/domain-hotel";

const rates: ExchangeRateRecord[] = [
  { fromCurrency: "USD", toCurrency: "MXN", rate: 17.0, effectiveDate: "2026-01-01" },
  { fromCurrency: "USD", toCurrency: "MXN", rate: 18.5, effectiveDate: "2026-06-01" },
];

describe("resolveVigenteExchangeRate (REQ-RES-015)", () => {
  it("elige la fila con effective_date más reciente que no sea posterior a la fecha consultada", () => {
    const vigente = resolveVigenteExchangeRate(rates, "USD", "MXN", "2026-06-15");
    expect(vigente.rate).toBe(18.5);
    expect(vigente.effectiveDate).toBe("2026-06-01");
  });

  it("entre dos fechas de vigencia, usa la fila anterior mientras la más nueva todavía no aplique", () => {
    const vigente = resolveVigenteExchangeRate(rates, "USD", "MXN", "2026-03-01");
    expect(vigente.rate).toBe(17.0); // aún no rige la tasa de junio
  });

  it("nunca usa una tasa registrada con fecha FUTURA respecto a la fecha consultada", () => {
    // Consultando el 2025-12-31, ninguna de las dos filas (2026-01-01/2026-06-01) es
    // todavía vigente -- ambas son futuras respecto a esa fecha.
    expect(() => resolveVigenteExchangeRate(rates, "USD", "MXN", "2025-12-31")).toThrow(ExchangeRateError);
  });

  it("caso negativo: rechaza explícitamente (fail-closed) si no hay ninguna tasa registrada para el par", () => {
    expect(() => resolveVigenteExchangeRate([], "USD", "MXN", "2026-06-15")).toThrow(ExchangeRateError);
    try {
      resolveVigenteExchangeRate([], "EUR", "MXN", "2026-06-15");
      throw new Error("no debió llegar aquí");
    } catch (err) {
      expect(err).toBeInstanceOf(ExchangeRateError);
      expect((err as ExchangeRateError).code).toBe("tipo_cambio_no_registrado");
    }
  });
});

describe("convertToReportingCurrency (REQ-RES-015)", () => {
  it("una tarifa fijada en USD se convierte a MXN de reporte usando el tipo de cambio vigente registrado", () => {
    const result = convertToReportingCurrency({ amount: 100, currency: "USD" }, "MXN", "2026-06-15", rates);
    expect(result.amount).toBe(1850); // 100 * 18.5
    expect(result.currency).toBe("MXN");
    expect(result.exchangeRateApplied).toBe(18.5);
    expect(result.originalAmount).toBe(100);
    expect(result.originalCurrency).toBe("USD");
  });

  it("una tarifa YA fijada en la moneda de reporte es passthrough exacto, sin exigir ninguna tasa registrada", () => {
    const result = convertToReportingCurrency({ amount: 1850, currency: "MXN" }, "MXN", "2026-06-15", []);
    expect(result.amount).toBe(1850);
    expect(result.exchangeRateApplied).toBeNull();
    expect(result.originalCurrency).toBe("MXN");
  });

  it("caso negativo: convertir una divisa distinta sin tasa registrada para esa fecha lanza ExchangeRateError", () => {
    expect(() => convertToReportingCurrency({ amount: 100, currency: "EUR" }, "MXN", "2026-06-15", rates)).toThrow(
      ExchangeRateError,
    );
  });

  it("rechaza un monto negativo (nunca se infiere un signo, es responsabilidad del llamador)", () => {
    expect(() => convertToReportingCurrency({ amount: -10, currency: "USD" }, "MXN", "2026-06-15", rates)).toThrow(
      RangeError,
    );
  });
});

describe("summarizeMultiCurrencyTotals -- dos monedas activas en el mismo periodo (REQ-RES-015)", () => {
  it("suma líneas en USD y en MXN al mismo periodo, cada una convertida de forma determinista e independiente", () => {
    const result = summarizeMultiCurrencyTotals({
      lines: [
        { amount: 100, currency: "USD" }, // -> 1850 MXN
        { amount: 200, currency: "USD" }, // -> 3700 MXN
        { amount: 500, currency: "MXN" }, // -> 500 MXN (passthrough)
      ],
      reportingCurrency: "MXN",
      asOfDate: "2026-06-15",
      rates,
    });

    expect(result.totalInReportingCurrency).toBe(6050); // 1850 + 3700 + 500
    expect(result.reportingCurrency).toBe("MXN");
    expect(result.lines).toHaveLength(3);
    expect(result.foreignCurrenciesInvolved).toEqual(["USD"]);
  });

  it("cuando TODAS las líneas ya están en la moneda de reporte, no hay monedas extranjeras involucradas", () => {
    const result = summarizeMultiCurrencyTotals({
      lines: [{ amount: 100, currency: "MXN" }, { amount: 50, currency: "MXN" }],
      reportingCurrency: "MXN",
      asOfDate: "2026-06-15",
      rates,
    });
    expect(result.foreignCurrenciesInvolved).toEqual([]);
    expect(result.totalInReportingCurrency).toBe(150);
  });

  it("caso negativo: una línea en una divisa sin tipo de cambio registrado hace fallar TODA la agregación (fail-closed, nunca reporta un total parcial silencioso)", () => {
    expect(() =>
      summarizeMultiCurrencyTotals({
        lines: [
          { amount: 100, currency: "USD" },
          { amount: 30, currency: "GBP" }, // sin tasa registrada
        ],
        reportingCurrency: "MXN",
        asOfDate: "2026-06-15",
        rates,
      }),
    ).toThrow(ExchangeRateError);
  });
});
