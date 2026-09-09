// REQ-AB-003 (P1/F): "...con cola offline y reconciliación al recuperar conectividad
// en zonas sin señal (playa/alberca)."
import { describe, expect, it } from "vitest";
import { validateFnbOfflineQueueItem, type FnbOfflineQueueItemInput } from "@atiende-hoteles/domain-hotel";

function baseCargo(overrides: Partial<FnbOfflineQueueItemInput> = {}): FnbOfflineQueueItemInput {
  return {
    clientOperationId: "11111111-1111-1111-1111-111111111111",
    operationType: "cargo",
    folioId: "22222222-2222-2222-2222-222222222222",
    description: "2 cervezas en alberca",
    amount: 180,
    capturedBy: "33333333-3333-3333-3333-333333333333",
    capturedOfflineAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // hace 1 hora
    deviceId: "tablet-alberca-02",
    ...overrides,
  };
}

describe("validateFnbOfflineQueueItem: 'cargo'", () => {
  it("un ítem completo y coherente es válido", () => {
    const result = validateFnbOfflineQueueItem(baseCargo());
    expect(result).toEqual({ valid: true, reasons: [] });
  });

  it("rechaza amount <= 0", () => {
    const result = validateFnbOfflineQueueItem(baseCargo({ amount: 0 }));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("amount"))).toBe(true);
  });

  it("rechaza clientOperationId/folioId/deviceId vacíos, todos a la vez (acumula razones)", () => {
    const result = validateFnbOfflineQueueItem(baseCargo({ clientOperationId: "  ", folioId: "", deviceId: "" }));
    expect(result.valid).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("rechaza si 'cargo' trae originalChargeId (no aplica a esta operación)", () => {
    const result = validateFnbOfflineQueueItem(baseCargo({ originalChargeId: "44444444-4444-4444-4444-444444444444" }));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("originalChargeId no debe enviarse"))).toBe(true);
  });

  it("rechaza capturedOfflineAt inválido (no parseable)", () => {
    const result = validateFnbOfflineQueueItem(baseCargo({ capturedOfflineAt: "no-es-una-fecha" }));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("fecha/hora ISO válida"))).toBe(true);
  });

  it("rechaza capturedOfflineAt en el futuro más allá del margen de sesgo de reloj", () => {
    const futuro = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1 hora
    const result = validateFnbOfflineQueueItem(baseCargo({ capturedOfflineAt: futuro }));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("futuro"))).toBe(true);
  });

  it("acepta capturedOfflineAt dentro del margen de sesgo de reloj (+2 minutos)", () => {
    const casiAhora = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    const result = validateFnbOfflineQueueItem(baseCargo({ capturedOfflineAt: casiAhora }));
    expect(result.valid).toBe(true);
  });
});

describe("validateFnbOfflineQueueItem: 'reverso'", () => {
  function baseReverso(overrides: Partial<FnbOfflineQueueItemInput> = {}): FnbOfflineQueueItemInput {
    return {
      ...baseCargo(),
      operationType: "reverso",
      originalChargeId: "44444444-4444-4444-4444-444444444444",
      ...overrides,
    };
  }

  it("un reverso completo con originalChargeId es válido", () => {
    expect(validateFnbOfflineQueueItem(baseReverso())).toEqual({ valid: true, reasons: [] });
  });

  it("rechaza un reverso SIN originalChargeId", () => {
    const result = validateFnbOfflineQueueItem(baseReverso({ originalChargeId: undefined }));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("originalChargeId es requerido"))).toBe(true);
  });
});
