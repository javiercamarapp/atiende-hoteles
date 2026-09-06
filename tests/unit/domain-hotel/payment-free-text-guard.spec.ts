// L-tarjeta (auditoría-2 legal CRÍTICO, REQ-HUE-010/H09-027): detección (Luhn) y
// redacción de números de tarjeta/CVV/vencimiento en texto libre.
import { describe, expect, it } from "vitest";
import { detectAndRedactPaymentData, luhnValid } from "@atiende-hoteles/domain-hotel";

describe("luhnValid", () => {
  it("acepta un número de tarjeta de prueba Luhn-válido conocido (4111111111111111, Visa de prueba)", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
  });

  it("rechaza una racha de dígitos aleatoria que no cumple Luhn", () => {
    expect(luhnValid("1234567890123")).toBe(false);
  });

  it("rechaza longitudes fuera de rango", () => {
    expect(luhnValid("123")).toBe(false);
    expect(luhnValid("1".repeat(25))).toBe(false);
  });
});

describe("detectAndRedactPaymentData", () => {
  it("detecta y redacta un número de tarjeta con espacios (escenario del hallazgo: depósito por WhatsApp)", () => {
    const out = detectAndRedactPaymentData("les dejo mi tarjeta para el depósito: 4111 1111 1111 1111 venc 12/28 cvv 123");
    expect(out.containsCardNumber).toBe(true);
    expect(out.containsSensitiveData).toBe(true);
    expect(out.redactedText).not.toContain("4111");
    expect(out.redactedText).toContain("[TARJETA]");
    expect(out.redactedText).toContain("[CVV]");
    expect(out.redactedText).toContain("[VENCIMIENTO]");
  });

  it("detecta un número de tarjeta sin separadores", () => {
    const out = detectAndRedactPaymentData("mi numero es 4111111111111111 por si gustan cobrar");
    expect(out.containsCardNumber).toBe(true);
    expect(out.redactedText).toBe("mi numero es [TARJETA] por si gustan cobrar");
  });

  it("NO marca como sensible un mensaje normal sin dato de pago", () => {
    const out = detectAndRedactPaymentData("¿A qué hora es el check-in?");
    expect(out.containsSensitiveData).toBe(false);
    expect(out.containsCardNumber).toBe(false);
    expect(out.redactedText).toBe("¿A qué hora es el check-in?");
  });

  it("NO confunde un código de confirmación largo (no Luhn-válido) con una tarjeta", () => {
    const out = detectAndRedactPaymentData("mi código de confirmación es 1234567890123456");
    expect(out.containsCardNumber).toBe(false);
  });

  it("null/undefined/vacío no truena y no marca sensible", () => {
    expect(detectAndRedactPaymentData(null).containsSensitiveData).toBe(false);
    expect(detectAndRedactPaymentData(undefined).containsSensitiveData).toBe(false);
    expect(detectAndRedactPaymentData("").containsSensitiveData).toBe(false);
  });
});
