// REQ-RES-016: detección de intentos de enviar datos de check-in por chat libre.
import { describe, expect, it } from "vitest";
import { looksLikeCheckinDataInFreeText } from "../../../packages/domain-hotel/src/checkinFreeTextGuard.ts";

describe("looksLikeCheckinDataInFreeText", () => {
  it("detecta frase de check-in + un RFC", () => {
    expect(looksLikeCheckinDataInFreeText("Hola, quiero hacer mi check-in, mi RFC es GALA900101ABC")).toBe(true);
  });

  it("detecta frase de check-in + una línea MRZ-like", () => {
    expect(
      looksLikeCheckinDataInFreeText("mi pasaporte: P<MEXGARCIA<<ANA<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"),
    ).toBe(true);
  });

  it("una pregunta simple sobre check-in SIN datos sensibles NO se marca (evita falsos positivos molestos)", () => {
    expect(looksLikeCheckinDataInFreeText("¿A qué hora puedo hacer check-in?")).toBe(false);
  });

  it("un RFC mencionado sin contexto de check-in no se marca", () => {
    expect(looksLikeCheckinDataInFreeText("La factura debe ir a nombre de GALA900101ABC")).toBe(false);
  });

  it("texto vacío/nulo nunca se marca", () => {
    expect(looksLikeCheckinDataInFreeText("")).toBe(false);
    expect(looksLikeCheckinDataInFreeText(null)).toBe(false);
    expect(looksLikeCheckinDataInFreeText(undefined)).toBe(false);
  });

  it("mensaje normal de reserva no se marca", () => {
    expect(looksLikeCheckinDataInFreeText("¿Tienen desayuno incluido en mi reserva?")).toBe(false);
  });
});
