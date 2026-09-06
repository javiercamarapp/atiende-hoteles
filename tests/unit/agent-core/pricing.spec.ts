// REQ-AGT-020: presupuesto/costo por accion explicito, medido contra una tabla de
// precios configurable (nunca un numero incrustado en el runner).
import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_PRICING, DEFAULT_PRICING, estimateCostUsd } from "@atiende-hoteles/agent-core";

describe("estimateCostUsd", () => {
  it("calcula el costo de 1M tokens de entrada y 1M de salida para Sonnet 5", () => {
    const usd = estimateCostUsd(DEFAULT_PRICING, "claude-sonnet-5", 1_000_000, 1_000_000);
    expect(usd).toBeCloseTo(2 + 10, 6);
  });

  it("devuelve 0 para un modelo ausente de la tabla (nunca se adivina un precio)", () => {
    expect(estimateCostUsd(DEFAULT_PRICING, "fake-model", 1000, 1000)).toBe(0);
  });

  it("DEFAULT_BATCH_PRICING es ~50% de DEFAULT_PRICING (Opus 5 Batch nocturno)", () => {
    expect(DEFAULT_BATCH_PRICING["claude-opus-5"]!.inputPerMTok).toBeCloseTo(
      DEFAULT_PRICING["claude-opus-5"]!.inputPerMTok / 2,
      6,
    );
  });

  it("escala linealmente con la cantidad de tokens", () => {
    const usdPequeno = estimateCostUsd(DEFAULT_PRICING, "claude-haiku-4-5", 500, 500);
    const usdGrande = estimateCostUsd(DEFAULT_PRICING, "claude-haiku-4-5", 5000, 5000);
    expect(usdGrande).toBeCloseTo(usdPequeno * 10, 6);
  });
});
