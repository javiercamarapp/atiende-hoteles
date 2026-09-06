// REQ-RES-004: política de cancelación/depósito estructurada en puntos (free_until,
// penalty, no_show, deposit); toda confirmación entrega un número de cancelación no
// nulo y único (verificado a nivel de esquema: reservation.confirmation_code NOT NULL +
// UNIQUE, packages/db/migrations/0013_tarifas_avanzadas_y_politicas.sql — cubierto por
// tests/integration/reservas/*.spec.ts contra la base real).
import { describe, expect, it } from "vitest";
import { depositRequired, evaluateCancellation, evaluateNoShow, type CancellationPolicyConfig } from "@atiende-hoteles/domain-hotel";

const policy: CancellationPolicyConfig = {
  freeUntilHours: 24,
  penaltyPct: 50,
  noShowPct: 100,
  depositPct: 20,
};

describe("política de cancelación en 4 puntos (REQ-RES-004)", () => {
  it("cancelar con más horas de anticipación que 'free_until' no genera penalización", () => {
    const now = "2026-06-01T00:00:00Z";
    const checkIn = "2026-06-05"; // 96h de anticipación
    const result = evaluateCancellation(policy, now, checkIn, 4000);
    expect(result.isFree).toBe(true);
    expect(result.penaltyAmount).toBe(0);
    expect(result.refundAmount).toBe(4000);
  });

  it("cancelar dentro de la ventana de penalización cobra exactamente penalty_pct del total", () => {
    const now = "2026-06-04T12:00:00Z";
    const checkIn = "2026-06-05"; // 12h de anticipación < 24h
    const result = evaluateCancellation(policy, now, checkIn, 4000);
    expect(result.isFree).toBe(false);
    expect(result.penaltyAmount).toBe(2000); // 50% de 4000
    expect(result.refundAmount).toBe(2000);
  });

  it("cancelar exactamente en el límite de free_until_hours cuenta como gratuita (>=)", () => {
    const now = "2026-06-04T00:00:00Z"; // exactamente 24h antes
    const result = evaluateCancellation(policy, now, "2026-06-05", 1000);
    expect(result.isFree).toBe(true);
  });

  it("un no-show cobra no_show_pct del total (REQ-RES-008/H02-012, cálculo — el cobro real requiere pasarela, fuera de H4)", () => {
    const result = evaluateNoShow(policy, 1500);
    expect(result.chargeAmount).toBe(1500); // 100%
  });

  it("el depósito exigido es deposit_pct del total", () => {
    expect(depositRequired(policy, 5000)).toBe(1000);
  });

  it("el reembolso nunca es negativo aunque la penalización supere el total (defensivo)", () => {
    const aggressivePolicy: CancellationPolicyConfig = { ...policy, penaltyPct: 150 };
    const result = evaluateCancellation(aggressivePolicy, "2026-06-04T23:00:00Z", "2026-06-05", 1000);
    expect(result.refundAmount).toBe(0);
  });
});
