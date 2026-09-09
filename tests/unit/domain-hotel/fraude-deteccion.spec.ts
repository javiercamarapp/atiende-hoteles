// H16-014 · REQ-REC-014 (P1/SEG): las 4 reglas puras de detección de fraude interno
// (descuentos fuera de política, folio reabierto post-auditoría, cargo F&B no
// posteado, reembolso a tarjeta distinta) + el enrutamiento de destinatario por
// patrón.
import { describe, expect, it } from "vitest";
import {
  detectDiscountOutsidePolicy,
  detectFolioReopenedAfterAudit,
  detectRefundToDifferentCard,
  detectUnpostedFnbCharge,
  recipientRolesForPattern,
} from "@atiende-hoteles/domain-hotel";

describe("detectDiscountOutsidePolicy (1/4 — descuentos fuera de política)", () => {
  const base = {
    chargeId: "charge-1",
    folioId: "folio-1",
    thresholdAmount: 500,
    discountAuthorizedByStaffId: null as string | null,
    appliedByHasAdminRole: false,
  };

  it("no alerta un descuento por debajo del umbral, sin autorización", () => {
    expect(detectDiscountOutsidePolicy({ ...base, discountAmount: -200 })).toBeNull();
  });

  it("no alerta un descuento exactamente en el umbral (tolerancia de redondeo)", () => {
    expect(detectDiscountOutsidePolicy({ ...base, discountAmount: -500 })).toBeNull();
  });

  it("alerta un descuento sobre el umbral SIN autorización y aplicado por un rol no administrativo", () => {
    const finding = detectDiscountOutsidePolicy({ ...base, discountAmount: -800 });
    expect(finding).not.toBeNull();
    expect(finding?.pattern).toBe("descuento_fuera_de_politica");
    expect(finding?.chargeId).toBe("charge-1");
    expect(finding?.folioId).toBe("folio-1");
    expect(finding?.dedupeKey).toBe("descuento_fuera_de_politica:charge-1");
    expect(finding?.reason).toMatch(/umbral/);
  });

  it("evalúa por MAGNITUD del descuento (charge.amount puede venir negativo)", () => {
    const negativo = detectDiscountOutsidePolicy({ ...base, discountAmount: -900 });
    const positivo = detectDiscountOutsidePolicy({ ...base, discountAmount: 900 });
    expect(negativo).not.toBeNull();
    expect(positivo).not.toBeNull();
    expect(negativo?.evidence.discountAmount).toBe(900);
    expect(positivo?.evidence.discountAmount).toBe(900);
  });

  it("NO alerta si quien aplicó el descuento ya tenía rol administrativo (se autoriza a sí mismo)", () => {
    expect(detectDiscountOutsidePolicy({ ...base, discountAmount: -900, appliedByHasAdminRole: true })).toBeNull();
  });

  it("NO alerta si trae discount_authorized_by de un tercero administrativo", () => {
    expect(
      detectDiscountOutsidePolicy({ ...base, discountAmount: -900, discountAuthorizedByStaffId: "admin-1" }),
    ).toBeNull();
  });

  it("SÍ alerta cuando ni el actor ni un tercero autorizaron un descuento por encima del umbral", () => {
    const finding = detectDiscountOutsidePolicy({
      ...base,
      discountAmount: -1200,
      appliedByHasAdminRole: false,
      discountAuthorizedByStaffId: null,
    });
    expect(finding).not.toBeNull();
  });
});

describe("detectFolioReopenedAfterAudit (2/4 — folio reabierto post-auditoría)", () => {
  it("no alerta un cargo creado ANTES del cierre del folio", () => {
    const finding = detectFolioReopenedAfterAudit({
      folioId: "folio-1",
      folioClosedAt: "2026-09-05T10:00:00.000Z",
      chargeId: "charge-1",
      chargeCreatedAt: "2026-09-05T09:00:00.000Z",
    });
    expect(finding).toBeNull();
  });

  it("no alerta un cargo creado en el MISMO instante del cierre", () => {
    const finding = detectFolioReopenedAfterAudit({
      folioId: "folio-1",
      folioClosedAt: "2026-09-05T10:00:00.000Z",
      chargeId: "charge-1",
      chargeCreatedAt: "2026-09-05T10:00:00.000Z",
    });
    expect(finding).toBeNull();
  });

  it("alerta un cargo creado DESPUÉS del cierre del folio (implica reapertura fuera del flujo)", () => {
    const finding = detectFolioReopenedAfterAudit({
      folioId: "folio-1",
      folioClosedAt: "2026-09-05T10:00:00.000Z",
      chargeId: "charge-2",
      chargeCreatedAt: "2026-09-06T08:00:00.000Z",
    });
    expect(finding).not.toBeNull();
    expect(finding?.pattern).toBe("folio_reabierto_post_auditoria");
    expect(finding?.chargeId).toBe("charge-2");
    expect(finding?.dedupeKey).toBe("folio_reabierto_post_auditoria:charge-2");
    expect(finding?.reason).toMatch(/cerró/);
  });
});

describe("detectUnpostedFnbCharge (3/4 — cargo F&B no posteado)", () => {
  it("no alerta cuando la venta POS coincide en monto con un cargo F&B posteado", () => {
    const finding = detectUnpostedFnbCharge({
      folioId: "folio-1",
      posSaleId: "pos-1",
      posSaleAmount: 350,
      matchedCharge: { chargeId: "charge-ab-1", amount: 350 },
    });
    expect(finding).toBeNull();
  });

  it("tolera un centavo de diferencia por redondeo", () => {
    const finding = detectUnpostedFnbCharge({
      folioId: "folio-1",
      posSaleId: "pos-1",
      posSaleAmount: 350,
      matchedCharge: { chargeId: "charge-ab-1", amount: 350.01 },
    });
    expect(finding).toBeNull();
  });

  it("alerta cuando NO hay ningún cargo F&B posteado para la venta POS", () => {
    const finding = detectUnpostedFnbCharge({
      folioId: "folio-1",
      posSaleId: "pos-2",
      posSaleAmount: 480,
      matchedCharge: null,
    });
    expect(finding).not.toBeNull();
    expect(finding?.pattern).toBe("cargo_fnb_no_posteado");
    expect(finding?.chargeId).toBeNull();
    expect(finding?.dedupeKey).toBe("cargo_fnb_no_posteado:pos-2");
    expect(finding?.reason).toMatch(/nunca se cobró/);
  });

  it("alerta cuando el cargo posteado NO coincide en monto con la venta POS", () => {
    const finding = detectUnpostedFnbCharge({
      folioId: "folio-1",
      posSaleId: "pos-3",
      posSaleAmount: 500,
      matchedCharge: { chargeId: "charge-ab-2", amount: 200 },
    });
    expect(finding).not.toBeNull();
    expect(finding?.chargeId).toBe("charge-ab-2");
    expect(finding?.evidence.matchedChargeAmount).toBe(200);
  });
});

describe("detectRefundToDifferentCard (4/4 — reembolso a tarjeta distinta)", () => {
  it("no alerta cuando el reembolso coincide con un pago capturado del mismo folio", () => {
    const finding = detectRefundToDifferentCard({
      folioId: "folio-1",
      refundPaymentId: "pago-refund-1",
      refundTokenRef: "STRIPE-PAY-1",
      matchingCapturedTokenFound: true,
    });
    expect(finding).toBeNull();
  });

  it("alerta cuando el token del reembolso NO coincide con ningún pago capturado del folio", () => {
    const finding = detectRefundToDifferentCard({
      folioId: "folio-1",
      refundPaymentId: "pago-refund-2",
      refundTokenRef: "STRIPE-PAY-OTRA-TARJETA",
      matchingCapturedTokenFound: false,
    });
    expect(finding).not.toBeNull();
    expect(finding?.pattern).toBe("reembolso_tarjeta_distinta");
    expect(finding?.paymentId).toBe("pago-refund-2");
    expect(finding?.chargeId).toBeNull();
    expect(finding?.dedupeKey).toBe("reembolso_tarjeta_distinta:pago-refund-2");
  });
});

describe("recipientRolesForPattern (REQ-REC-014: alerta al destinatario correspondiente)", () => {
  it("descuento_fuera_de_politica → owner/gm", () => {
    expect(recipientRolesForPattern("descuento_fuera_de_politica")).toEqual(["owner", "gm"]);
  });

  it("folio_reabierto_post_auditoria → owner/gm/accountant", () => {
    expect(recipientRolesForPattern("folio_reabierto_post_auditoria")).toEqual(["owner", "gm", "accountant"]);
  });

  it("cargo_fnb_no_posteado → owner/gm/fnb", () => {
    expect(recipientRolesForPattern("cargo_fnb_no_posteado")).toEqual(["owner", "gm", "fnb"]);
  });

  it("reembolso_tarjeta_distinta → owner/gm/accountant", () => {
    expect(recipientRolesForPattern("reembolso_tarjeta_distinta")).toEqual(["owner", "gm", "accountant"]);
  });
});
