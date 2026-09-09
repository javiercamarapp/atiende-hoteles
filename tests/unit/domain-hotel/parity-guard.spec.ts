// REQ-REV-007 (P1/GOB, fuentes BP-047/BP-156): "parity guard" configurable por hotel
// que respete la paridad contractual vigente con OTAs — bloquea o alerta (según el
// modo configurado por el hotel) cuando una tarifa directa propuesta cae por debajo
// del piso pactado con un canal (referencia OTA menos el margen tolerado).
import { describe, expect, it } from "vitest";
import {
  PARITY_MODES,
  ParityGuardError,
  assertValidParityChannelConfig,
  assertValidParityGuardConfig,
  computeParityFloor,
  evaluateParityGuard,
  type ParityGuardConfig,
} from "@atiende-hoteles/domain-hotel";

function baseConfig(overrides: Partial<ParityGuardConfig> = {}): ParityGuardConfig {
  return {
    hotelId: "hotel-1",
    mode: "bloquea",
    channels: [{ channel: "booking.com", referenceRate: 100, toleranceAllowedPct: 0 }],
    ...overrides,
  };
}

describe("PARITY_MODES", () => {
  it("expone exactamente los 2 modos del requisito: bloquea y alerta", () => {
    expect(PARITY_MODES).toEqual(["bloquea", "alerta"]);
  });
});

describe("computeParityFloor", () => {
  it("con tolerancia 0 (paridad estricta) el piso es igual a la referencia", () => {
    expect(computeParityFloor(100, 0)).toBe(100);
  });

  it("con tolerancia > 0 el piso es proporcionalmente menor a la referencia", () => {
    expect(computeParityFloor(100, 5)).toBeCloseTo(95, 9);
    expect(computeParityFloor(200, 10)).toBeCloseTo(180, 9);
  });
});

describe("assertValidParityChannelConfig", () => {
  it("acepta un canal válido sin lanzar", () => {
    expect(() => assertValidParityChannelConfig({ channel: "booking.com", referenceRate: 100, toleranceAllowedPct: 5 })).not.toThrow();
  });

  it("rechaza nombre de canal vacío", () => {
    expect(() => assertValidParityChannelConfig({ channel: "", referenceRate: 100, toleranceAllowedPct: 0 })).toThrow(ParityGuardError);
    expect(() => assertValidParityChannelConfig({ channel: "   ", referenceRate: 100, toleranceAllowedPct: 0 })).toThrow(/canal_faltante/);
  });

  it("rechaza tarifa de referencia no positiva o no finita", () => {
    expect(() => assertValidParityChannelConfig({ channel: "expedia", referenceRate: 0, toleranceAllowedPct: 0 })).toThrow(
      /tarifa_referencia_invalida/,
    );
    expect(() => assertValidParityChannelConfig({ channel: "expedia", referenceRate: -10, toleranceAllowedPct: 0 })).toThrow(
      /tarifa_referencia_invalida/,
    );
    expect(() => assertValidParityChannelConfig({ channel: "expedia", referenceRate: Number.NaN, toleranceAllowedPct: 0 })).toThrow(
      /tarifa_referencia_invalida/,
    );
  });

  it("rechaza tolerancia fuera de [0, 100)", () => {
    expect(() => assertValidParityChannelConfig({ channel: "expedia", referenceRate: 100, toleranceAllowedPct: -1 })).toThrow(
      /tolerancia_invalida/,
    );
    expect(() => assertValidParityChannelConfig({ channel: "expedia", referenceRate: 100, toleranceAllowedPct: 100 })).toThrow(
      /tolerancia_invalida/,
    );
    expect(() => assertValidParityChannelConfig({ channel: "expedia", referenceRate: 100, toleranceAllowedPct: 150 })).toThrow(
      /tolerancia_invalida/,
    );
  });

  it("el límite 0 (paridad estricta) sí es válido", () => {
    expect(() => assertValidParityChannelConfig({ channel: "expedia", referenceRate: 100, toleranceAllowedPct: 0 })).not.toThrow();
  });
});

describe("assertValidParityGuardConfig", () => {
  it("acepta configuración válida con varios canales distintos", () => {
    expect(() =>
      assertValidParityGuardConfig(
        baseConfig({
          channels: [
            { channel: "booking.com", referenceRate: 100, toleranceAllowedPct: 0 },
            { channel: "expedia", referenceRate: 105, toleranceAllowedPct: 5 },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("acepta channels vacío (hotel sin cláusula de paridad vigente todavía)", () => {
    expect(() => assertValidParityGuardConfig(baseConfig({ channels: [] }))).not.toThrow();
  });

  it("rechaza modo inválido", () => {
    // @ts-expect-error -- modo inválido a propósito para probar la validación en runtime
    expect(() => assertValidParityGuardConfig(baseConfig({ mode: "avisa" }))).toThrow(/modo_invalido/);
  });

  it("rechaza canal duplicado (mismo canal, distinto o igual criterio) para el mismo hotel", () => {
    expect(() =>
      assertValidParityGuardConfig(
        baseConfig({
          channels: [
            { channel: "booking.com", referenceRate: 100, toleranceAllowedPct: 0 },
            { channel: "Booking.com", referenceRate: 110, toleranceAllowedPct: 5 }, // mismo canal, distinta capitalización
          ],
        }),
      ),
    ).toThrow(/canal_duplicado/);
  });

  it("propaga la validación de cada canal individual", () => {
    expect(() =>
      assertValidParityGuardConfig(baseConfig({ channels: [{ channel: "expedia", referenceRate: -1, toleranceAllowedPct: 0 }] })),
    ).toThrow(/tarifa_referencia_invalida/);
  });
});

describe("evaluateParityGuard — validación de entrada", () => {
  it("lanza ParityGuardError si la configuración es inválida (no confunde config rota con 'sin violaciones')", () => {
    expect(() => evaluateParityGuard(baseConfig({ mode: "avisa" as never }), 100)).toThrow(ParityGuardError);
  });

  it("lanza ParityGuardError si la tarifa propuesta no es un número positivo", () => {
    expect(() => evaluateParityGuard(baseConfig(), 0)).toThrow(/tarifa_propuesta_invalida/);
    expect(() => evaluateParityGuard(baseConfig(), -50)).toThrow(/tarifa_propuesta_invalida/);
    expect(() => evaluateParityGuard(baseConfig(), Number.NaN)).toThrow(/tarifa_propuesta_invalida/);
  });
});

describe("evaluateParityGuard — sin cláusula de paridad configurada", () => {
  it("channels vacío siempre permite la propuesta, sin violaciones", () => {
    const result = evaluateParityGuard(baseConfig({ channels: [] }), 1);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.reasons).toEqual([]);
  });
});

describe("evaluateParityGuard — modo 'bloquea'", () => {
  it("una tarifa propuesta igual a la referencia (paridad estricta) no viola nada", () => {
    const result = evaluateParityGuard(baseConfig({ mode: "bloquea" }), 100);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("una tarifa propuesta por ENCIMA de la referencia nunca viola la paridad", () => {
    const result = evaluateParityGuard(baseConfig({ mode: "bloquea" }), 150);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("una tarifa propuesta por debajo del piso pactado (paridad estricta) BLOQUEA la propuesta", () => {
    const result = evaluateParityGuard(baseConfig({ mode: "bloquea" }), 90);
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      channel: "booking.com",
      referenceRate: 100,
      toleranceAllowedPct: 0,
      floorRate: 100,
      proposedRate: 90,
    });
    expect(result.violations[0]!.deficitPct).toBeCloseTo(10, 9);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/^paridad_rota:booking\.com:/);
  });

  it("respeta la tolerancia pactada: justo en el piso (referencia - tolerancia) NO es violación", () => {
    const config = baseConfig({ channels: [{ channel: "expedia", referenceRate: 100, toleranceAllowedPct: 5 }] });
    const result = evaluateParityGuard(config, 95); // piso = 100 * 0.95 = 95, exactamente en el borde
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("1 centavo por debajo del piso pactado SÍ es violación (el margen es exactamente el pactado, no más)", () => {
    const config = baseConfig({ channels: [{ channel: "expedia", referenceRate: 100, toleranceAllowedPct: 5 }] });
    const result = evaluateParityGuard(config, 94.99);
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it("tolera error de punto flotante en la frontera exacta del piso", () => {
    const config = baseConfig({ channels: [{ channel: "expedia", referenceRate: 100, toleranceAllowedPct: 5 }] });
    const result = evaluateParityGuard(config, 95 - 1e-12); // "prácticamente" 95, no una violación real
    expect(result.allowed).toBe(true);
  });

  it("la paridad debe cumplirse INDIVIDUALMENTE con cada canal — romper con uno solo ya bloquea", () => {
    const config = baseConfig({
      mode: "bloquea",
      channels: [
        { channel: "booking.com", referenceRate: 100, toleranceAllowedPct: 0 },
        { channel: "expedia", referenceRate: 120, toleranceAllowedPct: 0 },
      ],
    });
    // 100 respeta a booking.com (piso 100) pero rompe con expedia (piso 120)
    const result = evaluateParityGuard(config, 100);
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.channel).toBe("expedia");
  });

  it("puede romper la paridad con varios canales a la vez — reporta una violación por canal", () => {
    const config = baseConfig({
      mode: "bloquea",
      channels: [
        { channel: "booking.com", referenceRate: 100, toleranceAllowedPct: 0 },
        { channel: "expedia", referenceRate: 120, toleranceAllowedPct: 0 },
      ],
    });
    const result = evaluateParityGuard(config, 50);
    expect(result.allowed).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.channel).sort()).toEqual(["booking.com", "expedia"]);
    expect(result.reasons).toHaveLength(2);
  });
});

describe("evaluateParityGuard — modo 'alerta'", () => {
  it("una violación de paridad NO bloquea en modo alerta, pero se reporta igual", () => {
    const config = baseConfig({ mode: "alerta" });
    const result = evaluateParityGuard(config, 90);
    expect(result.allowed).toBe(true); // nunca bloquea en este modo
    expect(result.violations).toHaveLength(1); // pero la violación real se reporta igual
    expect(result.reasons[0]).toMatch(/^paridad_rota:booking\.com:/);
  });

  it("sin violaciones, modo alerta también permite y no reporta nada", () => {
    const result = evaluateParityGuard(baseConfig({ mode: "alerta" }), 100);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.reasons).toEqual([]);
  });
});

describe("evaluateParityGuard — el resultado siempre refleja hotelId/mode/proposedRate de entrada", () => {
  it("ecoa hotelId, mode y proposedRate en el resultado para trazabilidad", () => {
    const config = baseConfig({ hotelId: "hotel-42", mode: "alerta" });
    const result = evaluateParityGuard(config, 77);
    expect(result.hotelId).toBe("hotel-42");
    expect(result.mode).toBe("alerta");
    expect(result.proposedRate).toBe(77);
  });
});
