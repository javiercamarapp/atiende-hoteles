// Patrón Likida/atiende.ai #8 (intent 2/3): "queja de pago" (disputa/cobro indebido) es
// DISTINTO de la captura de PAN en texto libre (paymentFreeTextGuard.ts) -- debe
// redirigirse al flujo estructurado de soporte de pagos en vez de caer en la
// clasificación genérica de ticket.
import { describe, expect, it } from "vitest";
import { looksLikePaymentComplaint } from "../../../packages/domain-hotel/src/paymentComplaintGuard.ts";

describe("looksLikePaymentComplaint", () => {
  it("detecta 'me cobraron de más'", () => {
    expect(looksLikePaymentComplaint("Hola, me cobraron de más en mi tarjeta, ayuda")).toBe(true);
  });

  it("detecta 'no reconozco este cargo'", () => {
    expect(looksLikePaymentComplaint("No reconozco este cargo en mi estado de cuenta")).toBe(true);
  });

  it("detecta 'quiero un reembolso'", () => {
    expect(looksLikePaymentComplaint("Quiero un reembolso, cancelaron mi vuelo y ya no llegué")).toBe(true);
  });

  it("detecta 'cargo duplicado'/'cobro duplicado'", () => {
    expect(looksLikePaymentComplaint("Veo un cargo duplicado de la misma noche")).toBe(true);
    expect(looksLikePaymentComplaint("Hay un cobro duplicado en mi cuenta")).toBe(true);
  });

  it("NO marca una pregunta normal sobre el precio (sin queja)", () => {
    expect(looksLikePaymentComplaint("¿Cuánto cuesta la habitación por noche?")).toBe(false);
  });

  it("NO marca una mención de 'pago' sin queja de cobro", () => {
    expect(looksLikePaymentComplaint("¿Puedo pagar con tarjeta al llegar?")).toBe(false);
  });

  it("texto vacío/nulo nunca se marca", () => {
    expect(looksLikePaymentComplaint("")).toBe(false);
    expect(looksLikePaymentComplaint(null)).toBe(false);
    expect(looksLikePaymentComplaint(undefined)).toBe(false);
  });
});
