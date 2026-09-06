// REQ-RES-002: toda cotización lee disponibilidad/tarifa exclusivamente de datos reales
// (rate_plan); ninguna ruta de cotización invoca al LLM para fijar el precio. Un mock de
// "LLM" que intenta inyectar/alterar el precio final se descarta ANTES de calcular nada
// (parseQuoteInput usa un esquema zod que solo reconoce las columnas reales de
// rate_plan). No se prueba aquí PmsPort/MockPmsConnector (packages/mcp-servers/pms):
// ese conector es trabajo en paralelo de otro agente, fuera de alcance de esta suite —
// ver docs/PROGRESO.md H4.
import { describe, expect, it } from "vitest";
import { computeQuote, parseQuoteInput } from "@atiende-hoteles/domain-hotel";

describe("la fuente del precio es siempre la tarifa real, nunca un LLM (REQ-RES-002)", () => {
  it("un 'LLM' que intenta inyectar un precio propio en la tarifa de una noche es ignorado: se descarta antes de calcular", () => {
    // Simula un canal conversacional (WhatsApp/voz) cuyo modelo de lenguaje devuelve un
    // JSON con un campo extra `llmSuggestedPrice` intentando fijar el precio final.
    const rawFromLlmChannel = {
      checkInDate: "2026-05-01",
      checkOutDate: "2026-05-02",
      taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
      nightlyRates: [
        {
          date: "2026-05-01",
          price: 1500, // precio REAL de rate_plan
          llmSuggestedPrice: 1, // el LLM "negocia" un peso — debe ser ignorado
          minStay: 1,
        },
      ],
    };

    const parsed = parseQuoteInput(rawFromLlmChannel);
    // El campo inyectado por el LLM no sobrevive el parseo.
    expect(parsed.nightlyRates[0]).not.toHaveProperty("llmSuggestedPrice");

    const quote = computeQuote(parsed);
    expect(quote.netAmount).toBe(1500);
    expect(quote.totalAmount).toBeGreaterThan(1500); // impuestos reales aplicados, no el "$1" del LLM
  });

  it("un intento de inyectar un 'totalOverride' a nivel de cotización completa también se descarta", () => {
    const raw = {
      checkInDate: "2026-05-01",
      checkOutDate: "2026-05-02",
      taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
      totalOverride: 1, // no existe en el esquema: se elimina
      nightlyRates: [{ date: "2026-05-01", price: 2000 }],
    };
    const parsed = parseQuoteInput(raw);
    expect(parsed).not.toHaveProperty("totalOverride");
    expect(computeQuote(parsed).totalAmount).toBeGreaterThan(2000);
  });

  it("sin una fila de tarifa real para la noche solicitada, la cotización se rechaza en vez de estimar un precio", () => {
    const raw = {
      checkInDate: "2026-05-01",
      checkOutDate: "2026-05-02",
      taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
      nightlyRates: [],
    };
    expect(() => parseQuoteInput(raw)).toThrow();
  });
});
