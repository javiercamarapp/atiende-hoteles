// REQ-AB-014 (P2/F, H10-010): "disparar ofertas de upsell F&B (cena romántica,
// botella, desayuno en cama) en momentos definidos (T-7, T-3, check-in), con el
// precio siempre proveniente del motor de Revenue." Mismo patrón que
// `pricing-source.spec.ts` (REQ-RES-002): un "LLM" que intenta inyectar su propio
// precio se descarta ANTES de que el precio llegue a ningún cálculo.
import { describe, expect, it } from "vitest";
import {
  daysUntilCheckIn,
  dueUpsellTriggerMoments,
  FnbUpsellEngineError,
  parseRevenuePricedCatalogRow,
  resolveOfferPrice,
  UPSELL_OFFER_TYPES,
  UPSELL_TRIGGER_MOMENTS,
} from "@atiende-hoteles/domain-hotel";

describe("REQ-AB-014: catálogos cerrados", () => {
  it("los 3 tipos de oferta son exactamente los del REQ, ni uno más ni uno menos", () => {
    expect([...UPSELL_OFFER_TYPES].sort()).toEqual(["botella", "cena_romantica", "desayuno_en_cama"].sort());
  });
  it("los 3 momentos de disparo son exactamente T-7/T-3/check-in", () => {
    expect([...UPSELL_TRIGGER_MOMENTS]).toEqual(["t_menos_7", "t_menos_3", "checkin"]);
  });
});

describe("REQ-AB-014: daysUntilCheckIn / dueUpsellTriggerMoments", () => {
  it("a exactamente 7 días, T-7 ya está vencido (inclusive)", () => {
    expect(daysUntilCheckIn("2026-05-08", "2026-05-01T00:00:00Z")).toBe(7);
    expect(dueUpsellTriggerMoments("2026-05-08", "2026-05-01T00:00:00Z")).toEqual(["t_menos_7"]);
  });

  it("a 8 días, ningún momento está vencido todavía", () => {
    expect(dueUpsellTriggerMoments("2026-05-09", "2026-05-01T00:00:00Z")).toEqual([]);
  });

  it("a exactamente 3 días, T-7 y T-3 están vencidos, check-in todavía no", () => {
    expect(dueUpsellTriggerMoments("2026-05-04", "2026-05-01T00:00:00Z")).toEqual(["t_menos_7", "t_menos_3"]);
  });

  it("el día de check-in (0 días), y un día después (-1), check-in cuenta como vencido -- nunca se pierde por correr tarde", () => {
    expect(dueUpsellTriggerMoments("2026-05-01", "2026-05-01T00:00:00Z")).toEqual(["t_menos_7", "t_menos_3", "checkin"]);
    expect(dueUpsellTriggerMoments("2026-05-01", "2026-05-02T10:00:00Z")).toEqual(["t_menos_7", "t_menos_3", "checkin"]);
  });

  it("una reserva de última hora (2 días de anticipación) dispara T-7 y T-3 juntos en el mismo tick -- alcance correcto, no un bug (mismo criterio que ticketEscalationScheduler)", () => {
    expect(dueUpsellTriggerMoments("2026-05-03", "2026-05-01T00:00:00Z")).toEqual(["t_menos_7", "t_menos_3"]);
  });

  it("nunca vuelve a incluir un momento ya disparado (idempotencia de dominio)", () => {
    expect(dueUpsellTriggerMoments("2026-05-01", "2026-05-01T00:00:00Z", ["t_menos_7", "t_menos_3"])).toEqual(["checkin"]);
    expect(dueUpsellTriggerMoments("2026-05-01", "2026-05-01T00:00:00Z", ["t_menos_7", "t_menos_3", "checkin"])).toEqual([]);
  });

  it("rechaza una fecha de check-in mal formada en vez de calcular con un valor ambiguo", () => {
    expect(() => daysUntilCheckIn("01/05/2026", "2026-05-01T00:00:00Z")).toThrow(FnbUpsellEngineError);
  });
});

describe("REQ-AB-014: el precio siempre proviene del catálogo real (motor de Revenue), nunca de un LLM", () => {
  it("un 'LLM' que intenta inyectar `llmSuggestedPrice`/`descuentoNegociado` es ignorado: se descarta antes de calcular", () => {
    const rawFromLlmChannel = {
      menuItemId: "11111111-1111-4111-8111-111111111111",
      price: 1200, // precio REAL de menu_item
      llmSuggestedPrice: 1, // el LLM "negocia" un peso -- debe ser ignorado
      descuentoNegociado: 0.99,
      active: true,
    };
    const parsed = parseRevenuePricedCatalogRow(rawFromLlmChannel);
    expect(parsed).not.toHaveProperty("llmSuggestedPrice");
    expect(parsed).not.toHaveProperty("descuentoNegociado");
    expect(resolveOfferPrice(parsed)).toBe(1200);
  });

  it("un intento de inyectar `price` como string negociable (nunca un número real) se rechaza", () => {
    expect(() => parseRevenuePricedCatalogRow({ menuItemId: "11111111-1111-4111-8111-111111111111", price: "lo que el huésped quiera pagar", active: true })).toThrow();
  });

  it("un platillo/paquete inactivo no puede fijar el precio de una oferta (nunca se dispara con algo retirado del menú)", () => {
    const row = parseRevenuePricedCatalogRow({ menuItemId: "11111111-1111-4111-8111-111111111111", price: 500, active: false });
    expect(() => resolveOfferPrice(row)).toThrow(FnbUpsellEngineError);
  });

  it("sin una fila real de catálogo (menu_item), no hay forma de fijar un precio -- se rechaza en vez de estimar", () => {
    expect(() => parseRevenuePricedCatalogRow({})).toThrow(FnbUpsellEngineError);
  });
});
