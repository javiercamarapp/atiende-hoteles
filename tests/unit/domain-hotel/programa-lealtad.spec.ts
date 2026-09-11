// REQ-CRM-008: programa de lealtad -- elegibilidad PURA para canjear los 3 beneficios
// (late checkout, crédito F&B, reconocimiento) más allá de la tarifa directa con
// descuento (esa, REQ-RES-010, ya está probada en club-segundo-viaje.spec.ts).
import { describe, expect, it } from "vitest";
import {
  assertValidFnbCreditAmount,
  assertValidLateCheckoutHours,
  assertValidReconocimientoTexto,
  evaluateLoyaltyRedemption,
  type LoyaltyBenefitsConfig,
} from "@atiende-hoteles/domain-hotel";

const CONFIG_TODO_HABILITADO: LoyaltyBenefitsConfig = {
  lateCheckoutHours: 2,
  fnbCreditAmount: 300,
  reconocimientoTexto: "Nota de bienvenida VIP + upgrade de habitación si hay disponibilidad.",
};

const CONFIG_VACIA: LoyaltyBenefitsConfig = { lateCheckoutHours: null, fnbCreditAmount: null, reconocimientoTexto: null };

describe("evaluateLoyaltyRedemption (REQ-CRM-008)", () => {
  it("miembro activo + beneficio configurado -> aplica cada uno de los 3 tipos con su snapshot exacto", () => {
    const lateCheckout = evaluateLoyaltyRedemption({ isActiveMember: true, benefitType: "late_checkout", config: CONFIG_TODO_HABILITADO });
    expect(lateCheckout.applies).toBe(true);
    expect(lateCheckout.snapshot).toEqual({ lateCheckoutHours: 2, fnbCreditAmount: null, reconocimientoTexto: null });

    const creditoFnb = evaluateLoyaltyRedemption({ isActiveMember: true, benefitType: "credito_fnb", config: CONFIG_TODO_HABILITADO });
    expect(creditoFnb.applies).toBe(true);
    expect(creditoFnb.snapshot).toEqual({ lateCheckoutHours: null, fnbCreditAmount: 300, reconocimientoTexto: null });

    const reconocimiento = evaluateLoyaltyRedemption({ isActiveMember: true, benefitType: "reconocimiento", config: CONFIG_TODO_HABILITADO });
    expect(reconocimiento.applies).toBe(true);
    expect(reconocimiento.snapshot.reconocimientoTexto).toBe(CONFIG_TODO_HABILITADO.reconocimientoTexto);
  });

  it("miembro NO activo -> rechaza los 3 tipos sin importar la config (fail-closed, prioridad sobre la config)", () => {
    for (const benefitType of ["late_checkout", "credito_fnb", "reconocimiento"] as const) {
      const result = evaluateLoyaltyRedemption({ isActiveMember: false, benefitType, config: CONFIG_TODO_HABILITADO });
      expect(result.applies).toBe(false);
      expect(result.motivoRechazo).toBe("miembro_inactivo");
      expect(result.snapshot).toEqual({ lateCheckoutHours: null, fnbCreditAmount: null, reconocimientoTexto: null });
    }
  });

  it("miembro activo pero SIN ese beneficio configurado (null) -> rechaza, nunca inventa un valor", () => {
    for (const benefitType of ["late_checkout", "credito_fnb", "reconocimiento"] as const) {
      const result = evaluateLoyaltyRedemption({ isActiveMember: true, benefitType, config: CONFIG_VACIA });
      expect(result.applies).toBe(false);
      expect(result.motivoRechazo).toBe("beneficio_no_configurado");
    }
  });

  it("crédito F&B configurado en 0 -> no aplica (mismo criterio que discountPct=0 en REQ-RES-010: nunca un beneficio fantasma)", () => {
    const result = evaluateLoyaltyRedemption({
      isActiveMember: true,
      benefitType: "credito_fnb",
      config: { ...CONFIG_TODO_HABILITADO, fnbCreditAmount: 0 },
    });
    expect(result.applies).toBe(false);
    expect(result.motivoRechazo).toBe("beneficio_no_configurado");
  });

  it("reconocimiento configurado como cadena solo de espacios -> no aplica", () => {
    const result = evaluateLoyaltyRedemption({
      isActiveMember: true,
      benefitType: "reconocimiento",
      config: { ...CONFIG_TODO_HABILITADO, reconocimientoTexto: "   " },
    });
    expect(result.applies).toBe(false);
    expect(result.motivoRechazo).toBe("beneficio_no_configurado");
  });
});

describe("validadores de configuración", () => {
  it("assertValidLateCheckoutHours rechaza fuera de [1,6] y no-enteros", () => {
    expect(() => assertValidLateCheckoutHours(0)).toThrow(/late_checkout_invalido/);
    expect(() => assertValidLateCheckoutHours(7)).toThrow(/late_checkout_invalido/);
    expect(() => assertValidLateCheckoutHours(1.5)).toThrow(/late_checkout_invalido/);
    expect(() => assertValidLateCheckoutHours(2)).not.toThrow();
  });

  it("assertValidFnbCreditAmount rechaza negativos y NaN", () => {
    expect(() => assertValidFnbCreditAmount(-1)).toThrow(/credito_fnb_invalido/);
    expect(() => assertValidFnbCreditAmount(Number.NaN)).toThrow(/credito_fnb_invalido/);
    expect(() => assertValidFnbCreditAmount(0)).not.toThrow();
    expect(() => assertValidFnbCreditAmount(300)).not.toThrow();
  });

  it("assertValidReconocimientoTexto rechaza vacío/solo espacios", () => {
    expect(() => assertValidReconocimientoTexto("")).toThrow(/reconocimiento_invalido/);
    expect(() => assertValidReconocimientoTexto("   ")).toThrow(/reconocimiento_invalido/);
    expect(() => assertValidReconocimientoTexto("Nota VIP")).not.toThrow();
  });
});
