// REQ-RES-010: club de segundo viaje -- aplicación automática del beneficio SOLO en
// reservas directas subsecuentes de un miembro activo.
import { describe, expect, it } from "vitest";
import {
  applyLoyaltyBenefit,
  assertValidLoyaltyDiscountPct,
  isActiveLoyaltyMember,
  type LoyaltyBenefitInput,
} from "@atiende-hoteles/domain-hotel";

describe("isActiveLoyaltyMember", () => {
  it("solo 'activo' cuenta como miembro activo", () => {
    expect(isActiveLoyaltyMember("activo")).toBe(true);
    expect(isActiveLoyaltyMember("revocado")).toBe(false);
    expect(isActiveLoyaltyMember(null)).toBe(false);
    expect(isActiveLoyaltyMember(undefined)).toBe(false);
  });
});

describe("assertValidLoyaltyDiscountPct", () => {
  it("rechaza fuera de [0,100]", () => {
    expect(() => assertValidLoyaltyDiscountPct(-1)).toThrow(/descuento_invalido/);
    expect(() => assertValidLoyaltyDiscountPct(101)).toThrow(/descuento_invalido/);
    expect(() => assertValidLoyaltyDiscountPct(Number.NaN)).toThrow(/descuento_invalido/);
  });
  it("acepta el rango válido incluyendo los bordes", () => {
    expect(() => assertValidLoyaltyDiscountPct(0)).not.toThrow();
    expect(() => assertValidLoyaltyDiscountPct(100)).not.toThrow();
    expect(() => assertValidLoyaltyDiscountPct(10)).not.toThrow();
  });
});

describe("applyLoyaltyBenefit (REQ-RES-010)", () => {
  const base: LoyaltyBenefitInput = {
    isActiveMember: true,
    isDirectChannel: true,
    discountPct: 10,
    netAmount: 2000,
  };

  it("miembro activo + canal directo + descuento > 0 -> aplica el descuento exacto", () => {
    const result = applyLoyaltyBenefit(base);
    expect(result.applies).toBe(true);
    expect(result.discountPct).toBe(10);
    expect(result.discountAmount).toBe(200);
    expect(result.netAmountAfterDiscount).toBe(1800);
  });

  it("miembro NO activo -> nunca aplica, sin importar el canal ni el descuento configurado", () => {
    const result = applyLoyaltyBenefit({ ...base, isActiveMember: false });
    expect(result.applies).toBe(false);
    expect(result.discountPct).toBe(0);
    expect(result.discountAmount).toBe(0);
    expect(result.netAmountAfterDiscount).toBe(2000);
  });

  it("canal NO directo (ej. futura reserva OTA) -> nunca aplica aunque el huésped sea miembro activo", () => {
    const result = applyLoyaltyBenefit({ ...base, isDirectChannel: false });
    expect(result.applies).toBe(false);
    expect(result.discountAmount).toBe(0);
    expect(result.netAmountAfterDiscount).toBe(2000);
  });

  it("discountPct configurado en 0 -> no aplica (nunca un descuento fantasma)", () => {
    const result = applyLoyaltyBenefit({ ...base, discountPct: 0 });
    expect(result.applies).toBe(false);
    expect(result.netAmountAfterDiscount).toBe(2000);
  });

  it("redondea a 2 decimales igual que el resto del motor de cotización", () => {
    const result = applyLoyaltyBenefit({ ...base, discountPct: 12.5, netAmount: 999.99 });
    expect(result.discountAmount).toBe(125); // 12.5% de 999.99 = 124.99875 -> 125.00
    expect(result.netAmountAfterDiscount).toBe(874.99);
  });

  it("cuando no aplica, netAmountAfterDiscount siempre es el neto original redondeado (nunca cambia el precio)", () => {
    const result = applyLoyaltyBenefit({ ...base, isActiveMember: false, netAmount: 1234.567 });
    expect(result.netAmountAfterDiscount).toBe(1234.57);
  });
});
