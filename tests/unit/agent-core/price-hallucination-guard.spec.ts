// Patrón Likida/atiende.ai #4: guardia anti-alucinación determinista para precio/
// disponibilidad citados por el agente conversacional. Pruebas puras del módulo (sin
// AgentRunner) -- ver tests/unit/agent-core/runner.spec.ts para la integración
// end-to-end (close()/run_finished).
import { describe, expect, it } from "vitest";
import {
  findPriceHallucinations,
  PRICE_HALLUCINATION_FALLBACK_MESSAGE,
  sanitizeClosingMessage,
} from "../../../packages/agent-core/src/priceHallucinationGuard.ts";

describe("findPriceHallucinations", () => {
  it("detecta '$1,200' sin sourcedText", () => {
    const findings = findPriceHallucinations("La habitación cuesta $1,200 por noche.");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("money");
  });

  it("detecta '1200 pesos'/'50 USD' (sin símbolo, con palabra de moneda)", () => {
    expect(findPriceHallucinations("Son 1200 pesos por noche.")).toHaveLength(1);
    expect(findPriceHallucinations("Cuesta 50 USD.")).toHaveLength(1);
  });

  it("NO marca un número que no tiene forma de cifra monetaria (ej. un código de reserva)", () => {
    expect(findPriceHallucinations("Tu código de reserva es 48213099.")).toHaveLength(0);
  });

  it("exonera la cifra si la MISMA secuencia de dígitos aparece en sourcedText", () => {
    const findings = findPriceHallucinations("Cuesta $1,200 MXN.", ["La tarifa es $1,200 MXN por noche."]);
    expect(findings).toHaveLength(0);
  });

  it("NO exonera una cifra DISTINTA aunque sourcedText tenga otra cifra", () => {
    const findings = findPriceHallucinations("Te ofrezco $999 MXN.", ["La tarifa es $1,200 MXN por noche."]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.matchedText).toContain("999");
  });

  it("detecta una afirmación de disponibilidad ('hay habitaciones disponibles') sin sourcedText", () => {
    const findings = findPriceHallucinations("Hay habitaciones disponibles para esas fechas.");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("availability");
  });

  it("exonera la afirmación de disponibilidad si la misma frase-patrón aparece en sourcedText", () => {
    const findings = findPriceHallucinations("Sí hay disponibilidad.", ["Resultado: sí hay disponibilidad para esas fechas."]);
    expect(findings).toHaveLength(0);
  });

  it("un mensaje sin ninguna mención de dinero/disponibilidad no produce hallazgos", () => {
    expect(findPriceHallucinations("Con gusto te ayudo con tu solicitud.")).toHaveLength(0);
  });

  it("puede detectar VARIAS cifras distintas en el mismo mensaje", () => {
    const findings = findPriceHallucinations("La sencilla cuesta $800 y la doble $1,100.");
    expect(findings).toHaveLength(2);
  });
});

describe("sanitizeClosingMessage", () => {
  it("sin hallazgos, devuelve el mensaje original tal cual (blocked=false)", () => {
    const result = sanitizeClosingMessage("Con gusto te ayudo.");
    expect(result).toEqual({ message: "Con gusto te ayudo.", blocked: false, findings: [] });
  });

  it("con un hallazgo, reemplaza TODO el mensaje por el fallback fijo (nunca recorta solo el fragmento)", () => {
    const result = sanitizeClosingMessage("Cuesta $500, aprovecha antes de que se acabe.");
    expect(result.blocked).toBe(true);
    expect(result.message).toBe(PRICE_HALLUCINATION_FALLBACK_MESSAGE);
    expect(result.findings).toHaveLength(1);
  });

  it("una cifra sourced deja pasar el mensaje completo sin tocarlo", () => {
    const result = sanitizeClosingMessage("La tarifa es $1,200 MXN.", ["Tool: tarifa=$1,200 MXN"]);
    expect(result).toEqual({ message: "La tarifa es $1,200 MXN.", blocked: false, findings: [] });
  });
});
