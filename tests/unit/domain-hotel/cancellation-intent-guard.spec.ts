// Patrón Likida/atiende.ai #8 (intent 1/3): "cancelar mi reserva" en chat debe
// redirigirse al endpoint estructurado ya verificado (POST /reservas/cancelacion-publica)
// en vez de caer en la clasificación genérica de ticket.
import { describe, expect, it } from "vitest";
import { looksLikeCancellationIntent } from "../../../packages/domain-hotel/src/cancellationIntentGuard.ts";

describe("looksLikeCancellationIntent", () => {
  it("detecta 'quiero cancelar mi reserva'", () => {
    expect(looksLikeCancellationIntent("Hola, quiero cancelar mi reserva por favor")).toBe(true);
  });

  it("detecta 'necesito anular la reservación'", () => {
    expect(looksLikeCancellationIntent("Necesito anular la reservación del próximo fin de semana")).toBe(true);
  });

  it("detecta 'cancelación de mi reservación'", () => {
    expect(looksLikeCancellationIntent("Quisiera la cancelación de mi reservación, ya no podré ir")).toBe(true);
  });

  it("NO marca 'cancelar' sin mencionar la reserva (otro contexto)", () => {
    expect(looksLikeCancellationIntent("¿Puedo cancelar mi pedido de room service?")).toBe(false);
  });

  it("NO marca una mención de 'reserva' sin verbo de cancelación", () => {
    expect(looksLikeCancellationIntent("¿A qué nombre está mi reserva?")).toBe(false);
  });

  it("texto vacío/nulo nunca se marca", () => {
    expect(looksLikeCancellationIntent("")).toBe(false);
    expect(looksLikeCancellationIntent(null)).toBe(false);
    expect(looksLikeCancellationIntent(undefined)).toBe(false);
  });

  it("mensaje normal de consulta de reserva no se marca", () => {
    expect(looksLikeCancellationIntent("¿Tienen desayuno incluido en mi reserva?")).toBe(false);
  });
});
