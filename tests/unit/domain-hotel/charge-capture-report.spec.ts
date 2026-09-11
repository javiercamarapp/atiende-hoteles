// REQ-AB-012 (P1/NF), mitad "reporte de tasa de captura ≥99.5%" (H10-020). La otra
// mitad (doble verificación de identidad, H10-022) tiene su propia suite en
// `folio-engine.spec.ts`/`ab012-bypass-por-concepto.spec.ts` -- no se duplica aquí.
import { describe, expect, it } from "vitest";
import {
  buildChargeCaptureReport,
  validateRoomChargeCaptureAttempt,
  type RoomChargeCaptureAttemptInput,
  type RoomChargeCaptureAttemptRecord,
} from "@atiende-hoteles/domain-hotel";

function baseAttemptInput(overrides: Partial<RoomChargeCaptureAttemptInput> = {}): RoomChargeCaptureAttemptInput {
  return {
    folioId: "11111111-1111-1111-1111-111111111111",
    source: "fnb",
    description: "2 cervezas cerradas a la habitación 304",
    amount: 250,
    occurredAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    capturedBy: "22222222-2222-2222-2222-222222222222",
    ...overrides,
  };
}

describe("validateRoomChargeCaptureAttempt", () => {
  it("un intento completo y coherente es válido", () => {
    expect(validateRoomChargeCaptureAttempt(baseAttemptInput())).toEqual({ valid: true, reasons: [] });
  });

  it("rechaza amount <= 0", () => {
    const result = validateRoomChargeCaptureAttempt(baseAttemptInput({ amount: 0 }));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("amount"))).toBe(true);
  });

  it("rechaza folioId/description/capturedBy vacíos, todos a la vez (acumula razones)", () => {
    const result = validateRoomChargeCaptureAttempt(baseAttemptInput({ folioId: "", description: "  ", capturedBy: "" }));
    expect(result.valid).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("rechaza una fuente fuera del enum", () => {
    const result = validateRoomChargeCaptureAttempt(baseAttemptInput({ source: "bar" as never }));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("source"))).toBe(true);
  });

  it("rechaza occurredAt no parseable", () => {
    const result = validateRoomChargeCaptureAttempt(baseAttemptInput({ occurredAt: "no-es-fecha" }));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("fecha/hora ISO válida"))).toBe(true);
  });

  it("rechaza occurredAt en el futuro más allá del margen de sesgo de reloj", () => {
    const futuro = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = validateRoomChargeCaptureAttempt(baseAttemptInput({ occurredAt: futuro }));
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("futuro"))).toBe(true);
  });

  it("acepta occurredAt dentro del margen de sesgo de reloj (+2 minutos)", () => {
    const casiAhora = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    expect(validateRoomChargeCaptureAttempt(baseAttemptInput({ occurredAt: casiAhora })).valid).toBe(true);
  });
});

function attempt(status: RoomChargeCaptureAttemptRecord["status"], overrides: Partial<RoomChargeCaptureAttemptRecord> = {}): RoomChargeCaptureAttemptRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    status,
    amount: 100,
    description: "cargo sintético",
    source: "fnb",
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildChargeCaptureReport", () => {
  it("con 0 intentos en el periodo, la tasa es 1 (vacuamente cumplida, no es fuga)", () => {
    const report = buildChargeCaptureReport([]);
    expect(report).toMatchObject({ totalAttempts: 0, captured: 0, leaked: 0, pending: 0, captureRate: 1, meetsTarget: true });
  });

  it("200/200 capturados => 100% >= 99.5%: cumple el umbral (caso positivo real del REQ)", () => {
    const attempts = Array.from({ length: 200 }, () => attempt("capturado"));
    const report = buildChargeCaptureReport(attempts, { targetRate: 0.995 });
    expect(report.captureRate).toBe(1);
    expect(report.meetsTarget).toBe(true);
    expect(report.uncapturedAttempts).toHaveLength(0);
  });

  it("199 capturados + 1 fuga sobre 200 => 99.5% exacto: SÍ cumple (umbral inclusivo)", () => {
    const attempts = [...Array.from({ length: 199 }, () => attempt("capturado")), attempt("fuga")];
    const report = buildChargeCaptureReport(attempts, { targetRate: 0.995 });
    expect(report.captureRate).toBeCloseTo(0.995, 10);
    expect(report.meetsTarget).toBe(true);
  });

  it("197 capturados + 3 sin capturar sobre 200 => 98.5%: NO cumple el umbral 99.5% (caso negativo del REQ)", () => {
    const attempts = [
      ...Array.from({ length: 197 }, () => attempt("capturado")),
      attempt("fuga", { description: "vale de spa perdido" }),
      attempt("pendiente", { description: "comanda de bar sin reconciliar" }),
      attempt("pendiente", { description: "cargo de minibar sin reconciliar" }),
    ];
    const report = buildChargeCaptureReport(attempts, { targetRate: 0.995 });
    expect(report.captureRate).toBeCloseTo(0.985, 10);
    expect(report.meetsTarget).toBe(false);
    expect(report.leaked).toBe(1);
    expect(report.pending).toBe(2);
    expect(report.uncapturedAttempts).toHaveLength(3);
  });

  it("'pendiente' cuenta como NO capturado (nunca infla la tasa dejando intentos sin resolver)", () => {
    const attempts = [attempt("capturado"), attempt("pendiente")];
    const report = buildChargeCaptureReport(attempts);
    expect(report.captureRate).toBe(0.5);
  });

  it("uncapturedAttempts viene ordenado del más antiguo al más reciente (lista de seguimiento operativo)", () => {
    const viejo = attempt("fuga", { id: "viejo", occurredAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
    const reciente = attempt("pendiente", { id: "reciente", occurredAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
    const report = buildChargeCaptureReport([reciente, viejo]);
    expect(report.uncapturedAttempts.map((a) => a.id)).toEqual(["viejo", "reciente"]);
  });

  it("targetRate configurable por hotel (nunca fijo): un umbral menor puede convertir el mismo dataset en 'cumple'", () => {
    const attempts = [...Array.from({ length: 197 }, () => attempt("capturado")), attempt("fuga"), attempt("fuga"), attempt("fuga")];
    expect(buildChargeCaptureReport(attempts, { targetRate: 0.995 }).meetsTarget).toBe(false);
    expect(buildChargeCaptureReport(attempts, { targetRate: 0.95 }).meetsTarget).toBe(true);
  });

  it("rechaza un targetRate fuera de (0, 1]", () => {
    expect(() => buildChargeCaptureReport([], { targetRate: 0 })).toThrow(RangeError);
    expect(() => buildChargeCaptureReport([], { targetRate: 1.5 })).toThrow(RangeError);
  });
});
