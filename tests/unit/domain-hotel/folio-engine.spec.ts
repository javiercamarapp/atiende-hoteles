// H5 · REQ-REC-004/012, REQ-BO-001: motor determinista de cargos por concepto,
// redondeo a centavos, autorización de descuentos por umbral/rol, y reglas de cierre
// de folio (saldo cero o cuenta por cobrar autorizada).
import { describe, expect, it } from "vitest";
import {
  computeChargeAmounts,
  evaluateDiscountAuthorization,
  evaluateFolioClose,
} from "@atiende-hoteles/domain-hotel";

const taxConfig = { ivaRate: 0.16, ishRate: 0.03 };

describe("computeChargeAmounts (REQ-BO-001/H16-003)", () => {
  it("hospedaje lleva IVA + ISH", () => {
    const r = computeChargeAmounts({ concept: "hospedaje", netAmount: 1000, taxConfig });
    expect(r.netAmount).toBe(1000);
    expect(r.taxAmount).toBe(190); // 160 IVA + 30 ISH
    expect(r.totalAmount).toBe(1190);
  });

  it("A&B/extras/ajuste llevan IVA pero NUNCA ISH (H16-010: el ISH de Quintana Roo grava solo la contraprestación por hospedaje, excluye alimentos/otros servicios desglosados)", () => {
    const ab = computeChargeAmounts({ concept: "ab", netAmount: 250, taxConfig });
    expect(ab.taxAmount).toBe(40); // solo 16% IVA, 0 ISH
    expect(ab.totalAmount).toBe(290);

    const extras = computeChargeAmounts({ concept: "extras", netAmount: 250, taxConfig });
    expect(extras.taxAmount).toBe(40);

    const ajuste = computeChargeAmounts({ concept: "ajuste", netAmount: 250, taxConfig });
    expect(ajuste.taxAmount).toBe(40);

    const otro = computeChargeAmounts({ concept: "otro", netAmount: 250, taxConfig });
    expect(otro.taxAmount).toBe(40);
  });

  it("ISH a la tasa real de la fuente (H16, p.16: 5% para Quintana Roo) solo aplica sobre hospedaje", () => {
    const fuenteTaxConfig = { ivaRate: 0.16, ishRate: 0.05 };
    const hospedaje = computeChargeAmounts({ concept: "hospedaje", netAmount: 1000, taxConfig: fuenteTaxConfig });
    expect(hospedaje.taxAmount).toBe(210); // 160 IVA + 50 ISH (5%)

    const ab = computeChargeAmounts({ concept: "ab", netAmount: 1000, taxConfig: fuenteTaxConfig });
    expect(ab.taxAmount).toBe(160); // solo IVA, sin ISH
  });

  it("propina NUNCA lleva impuesto (REQ-BO-001: excluida del CFDI)", () => {
    const r = computeChargeAmounts({ concept: "propina", netAmount: 100, taxConfig });
    expect(r.taxAmount).toBe(0);
    expect(r.totalAmount).toBe(100);
  });

  it("descuento/reverso tampoco llevan impuesto propio calculado aquí", () => {
    const r = computeChargeAmounts({ concept: "descuento", netAmount: 50, taxConfig });
    expect(r.taxAmount).toBe(0);
    expect(r.totalAmount).toBe(50);
  });

  it("redondea a centavos de forma consistente (caso con arrastre de flotante)", () => {
    const r = computeChargeAmounts({ concept: "hospedaje", netAmount: 333.335, taxConfig });
    expect(Number.isInteger(r.netAmount * 100)).toBe(true);
    expect(Number.isInteger(r.taxAmount * 100)).toBe(true);
    expect(Number.isInteger(r.totalAmount * 100)).toBe(true);
  });

  it("rechaza un monto neto negativo para un concepto de cargo real", () => {
    expect(() => computeChargeAmounts({ concept: "hospedaje", netAmount: -1, taxConfig })).toThrow(RangeError);
  });
});

describe("evaluateDiscountAuthorization (autorización por umbral/rol)", () => {
  it("un descuento bajo el umbral se permite sin autorización adicional", () => {
    const r = evaluateDiscountAuthorization({ amount: 200, thresholdAmount: 500, actorHasAdminRole: false });
    expect(r.allowed).toBe(true);
  });

  it("un descuento sobre el umbral aplicado por frontdesk SIN autorización se rechaza", () => {
    const r = evaluateDiscountAuthorization({ amount: 800, thresholdAmount: 500, actorHasAdminRole: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/umbral/);
  });

  it("un descuento sobre el umbral aplicado por owner/gm SÍ se permite (actor ya es rol administrativo)", () => {
    const r = evaluateDiscountAuthorization({ amount: 800, thresholdAmount: 500, actorHasAdminRole: true });
    expect(r.allowed).toBe(true);
  });

  it("un descuento sobre el umbral aplicado por frontdesk CON autorización de un admin se permite", () => {
    const r = evaluateDiscountAuthorization({
      amount: 800,
      thresholdAmount: 500,
      actorHasAdminRole: false,
      authorizedByAdminUserId: "11111111-1111-1111-1111-111111111111",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateFolioClose (cierre de folio, saldo cero o cuenta por cobrar autorizada)", () => {
  it("cierra como saldo_cero cuando el balance es 0", () => {
    const r = evaluateFolioClose({ balance: 0, reason: "saldo_cero", actorHasAdminRole: false });
    expect(r.allowed).toBe(true);
  });

  it("tolera un residuo de redondeo de un centavo como saldo_cero", () => {
    const r = evaluateFolioClose({ balance: 0.01, reason: "saldo_cero", actorHasAdminRole: false });
    expect(r.allowed).toBe(true);
  });

  it("rechaza cerrar como saldo_cero con saldo real pendiente", () => {
    const r = evaluateFolioClose({ balance: 150, reason: "saldo_cero", actorHasAdminRole: false });
    expect(r.allowed).toBe(false);
  });

  it("rechaza cuenta_por_cobrar sin rol administrativo", () => {
    const r = evaluateFolioClose({ balance: 150, reason: "cuenta_por_cobrar", actorHasAdminRole: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/administrativo/);
  });

  it("permite cuenta_por_cobrar con saldo pendiente y rol administrativo", () => {
    const r = evaluateFolioClose({ balance: 150, reason: "cuenta_por_cobrar", actorHasAdminRole: true });
    expect(r.allowed).toBe(true);
  });
});
