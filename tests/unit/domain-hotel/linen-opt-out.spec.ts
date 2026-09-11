// REQ-HK-005: "El sistema debe registrar el opt-out de limpieza/reposición de blancos
// con incentivo (sin culpar al huésped en el mensaje) y contar blancos/amenidades por
// foto contra el consumo teórico, alertando desviaciones."
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEN_DEVIATION_THRESHOLD_PCT,
  LinenOptOutMessageBlamesGuestError,
  assertLinenOptOutMessageDoesNotBlameGuest,
  describeLinenOptOutConfirmationMessage,
  evaluateLinenCountDeviation,
  messageBlamesGuest,
} from "@atiende-hoteles/domain-hotel";

describe("messageBlamesGuest / assertLinenOptOutMessageDoesNotBlameGuest", () => {
  it("detecta frases que culpan/responsabilizan negativamente al huésped", () => {
    expect(messageBlamesGuest("Por tu culpa no se limpió tu habitación.")).toBe(true);
    expect(messageBlamesGuest("Es usted responsable de no recibir blancos limpios hoy.")).toBe(true);
    expect(messageBlamesGuest("Te niegas a que limpiemos tu cuarto.")).toBe(true);
    expect(messageBlamesGuest("Que desconsiderado de tu parte.")).toBe(true);
  });

  it("reconoce las mismas frases sin acentos (teclado de celular)", () => {
    expect(messageBlamesGuest("por su culpa no hubo limpieza")).toBe(true);
    expect(messageBlamesGuest("egoista de tu parte")).toBe(true);
  });

  it("NO marca un mensaje neutral que agradece y ofrece un incentivo", () => {
    const mensaje = describeLinenOptOutConfirmationMessage("10% de descuento en el spa");
    expect(messageBlamesGuest(mensaje)).toBe(false);
    expect(mensaje).toContain("10% de descuento en el spa");
  });

  it("assertLinenOptOutMessageDoesNotBlameGuest no truena con un mensaje seguro", () => {
    expect(() => assertLinenOptOutMessageDoesNotBlameGuest("Gracias por cuidar el planeta con nosotros.")).not.toThrow();
  });

  it("CASO NEGATIVO: assertLinenOptOutMessageDoesNotBlameGuest truena (fail-closed) con un mensaje que culpa al huésped", () => {
    expect(() => assertLinenOptOutMessageDoesNotBlameGuest("Por tu culpa no se te dará servicio hoy.")).toThrow(
      LinenOptOutMessageBlamesGuestError,
    );
  });
});

describe("evaluateLinenCountDeviation", () => {
  it("conteo igual al teórico: cero desviación, sin alerta", () => {
    const result = evaluateLinenCountDeviation({ countedQuantity: 20, theoreticalQuantity: 20, thresholdPct: 15 });
    expect(result.deviationUnits).toBe(0);
    expect(result.deviationPct).toBe(0);
    expect(result.alertTriggered).toBe(false);
  });

  it("desviación por debajo del umbral: no alerta", () => {
    // 2/20 = 10%, por debajo de un umbral de 15%.
    const result = evaluateLinenCountDeviation({ countedQuantity: 18, theoreticalQuantity: 20, thresholdPct: 15 });
    expect(result.deviationUnits).toBe(-2);
    expect(result.deviationPct).toBeCloseTo(10, 5);
    expect(result.alertTriggered).toBe(false);
  });

  it("CASO NEGATIVO (desviación real): faltante por encima del umbral SÍ dispara alerta", () => {
    // 5 contados contra 20 teóricos: -15 unidades, 75% de desviación, muy por encima de 15%.
    const result = evaluateLinenCountDeviation({ countedQuantity: 5, theoreticalQuantity: 20, thresholdPct: 15 });
    expect(result.deviationUnits).toBe(-15);
    expect(result.deviationPct).toBeCloseTo(75, 5);
    expect(result.alertTriggered).toBe(true);
  });

  it("un conteo de MÁS (sobre-reposición) también se detecta como desviación", () => {
    const result = evaluateLinenCountDeviation({ countedQuantity: 30, theoreticalQuantity: 20, thresholdPct: 15 });
    expect(result.deviationUnits).toBe(10);
    expect(result.deviationPct).toBeCloseTo(50, 5);
    expect(result.alertTriggered).toBe(true);
  });

  it("consumo teórico 0: contar 0 no es desviación, contar cualquier unidad es 100% de desviación", () => {
    const sinNada = evaluateLinenCountDeviation({ countedQuantity: 0, theoreticalQuantity: 0, thresholdPct: 15 });
    expect(sinNada.deviationPct).toBe(0);
    expect(sinNada.alertTriggered).toBe(false);

    const conAlgo = evaluateLinenCountDeviation({ countedQuantity: 3, theoreticalQuantity: 0, thresholdPct: 15 });
    expect(conAlgo.deviationPct).toBe(100);
    expect(conAlgo.alertTriggered).toBe(true);
  });

  it("desviación exactamente en el umbral no dispara alerta (umbral es un límite estricto de más allá, no de igual o más)", () => {
    // 3/20 = 15% exacto, thresholdPct = 15.
    const result = evaluateLinenCountDeviation({ countedQuantity: 17, theoreticalQuantity: 20, thresholdPct: 15 });
    expect(result.deviationPct).toBeCloseTo(15, 5);
    expect(result.alertTriggered).toBe(false);
  });
});

describe("DEFAULT_LINEN_DEVIATION_THRESHOLD_PCT", () => {
  it("es un porcentaje positivo razonable (ni 0 ni negativo)", () => {
    expect(DEFAULT_LINEN_DEVIATION_THRESHOLD_PCT).toBeGreaterThan(0);
  });
});
