// REQ-AB-005 (P2/F): "El sistema debe registrar consumo de minibar/honor bar mediante
// foto o checklist con evidencia asociada al cargo, manteniendo la tasa de disputas
// bajo un umbral objetivo (<3%)."
import { describe, expect, it } from "vitest";
import {
  MinibarEvidenceMissingError,
  assertMinibarEvidencePresent,
  computeMinibarDisputeRate,
  validateMinibarEvidence,
} from "@atiende-hoteles/domain-hotel";

describe("validateMinibarEvidence", () => {
  it("acepta una foto con URL http(s) válida", () => {
    const result = validateMinibarEvidence({ type: "foto", photoUrl: "https://cdn.example.com/minibar/123.jpg" });
    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("rechaza 'foto' sin URL (ausente, vacía o solo espacios)", () => {
    expect(validateMinibarEvidence({ type: "foto" }).valid).toBe(false);
    expect(validateMinibarEvidence({ type: "foto", photoUrl: "" }).valid).toBe(false);
    expect(validateMinibarEvidence({ type: "foto", photoUrl: "   " }).valid).toBe(false);
  });

  it("rechaza 'foto' con un valor que no es una URL http(s) real", () => {
    const result = validateMinibarEvidence({ type: "foto", photoUrl: "foto-tomada-ayer" });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/URL/);
  });

  it("acepta un checklist con al menos un elemento válido", () => {
    const result = validateMinibarEvidence({
      type: "checklist",
      checklistItems: [{ item: "Refresco cola 355ml", cantidad: 2 }],
    });
    expect(result.valid).toBe(true);
  });

  it("rechaza un checklist vacío", () => {
    expect(validateMinibarEvidence({ type: "checklist", checklistItems: [] }).valid).toBe(false);
    expect(validateMinibarEvidence({ type: "checklist" }).valid).toBe(false);
  });

  it("rechaza un checklist con un elemento sin nombre o con cantidad <= 0", () => {
    expect(
      validateMinibarEvidence({ type: "checklist", checklistItems: [{ item: "  ", cantidad: 1 }] }).valid,
    ).toBe(false);
    expect(
      validateMinibarEvidence({ type: "checklist", checklistItems: [{ item: "Agua mineral", cantidad: 0 }] }).valid,
    ).toBe(false);
    expect(
      validateMinibarEvidence({ type: "checklist", checklistItems: [{ item: "Agua mineral", cantidad: -1 }] }).valid,
    ).toBe(false);
  });

  it("assertMinibarEvidencePresent no truena con evidencia válida y truena con evidencia ausente", () => {
    expect(() => assertMinibarEvidencePresent({ type: "foto", photoUrl: "https://cdn.example.com/a.jpg" })).not.toThrow();
    expect(() => assertMinibarEvidencePresent({ type: "foto", photoUrl: null })).toThrow(MinibarEvidenceMissingError);
    expect(() => assertMinibarEvidencePresent({ type: "checklist", checklistItems: [] })).toThrow(
      MinibarEvidenceMissingError,
    );
  });
});

describe("computeMinibarDisputeRate", () => {
  it("sin consumos registrados en el periodo: 'sinDatos', nunca un 0% fabricado", () => {
    const result = computeMinibarDisputeRate({ totalRegistrados: 0, totalDisputados: 0 });
    expect(result.sinDatos).toBe(true);
    expect(result.ratePercent).toBeNull();
    expect(result.dentroDelUmbral).toBeNull();
  });

  it("tasa de disputas por debajo del umbral objetivo (<3%) se marca dentro del umbral", () => {
    // 2 de 100 = 2% < 3%
    const result = computeMinibarDisputeRate({ totalRegistrados: 100, totalDisputados: 2 });
    expect(result.sinDatos).toBe(false);
    expect(result.ratePercent).toBeCloseTo(2, 5);
    expect(result.thresholdPercent).toBe(3);
    expect(result.dentroDelUmbral).toBe(true);
  });

  it("tasa de disputas en o por encima del umbral objetivo (<3%) se marca FUERA del umbral (caso negativo)", () => {
    // 3 de 100 = exactamente 3% -- el criterio es "<3%", 3% NO cumple.
    const enUmbral = computeMinibarDisputeRate({ totalRegistrados: 100, totalDisputados: 3 });
    expect(enUmbral.dentroDelUmbral).toBe(false);

    // 5 de 100 = 5% > 3%, claramente fuera.
    const sobreUmbral = computeMinibarDisputeRate({ totalRegistrados: 100, totalDisputados: 5 });
    expect(sobreUmbral.ratePercent).toBeCloseTo(5, 5);
    expect(sobreUmbral.dentroDelUmbral).toBe(false);
  });

  it("rechaza entradas inconsistentes (negativos, o disputados > registrados)", () => {
    expect(() => computeMinibarDisputeRate({ totalRegistrados: -1, totalDisputados: 0 })).toThrow(RangeError);
    expect(() => computeMinibarDisputeRate({ totalRegistrados: 0, totalDisputados: -1 })).toThrow(RangeError);
    expect(() => computeMinibarDisputeRate({ totalRegistrados: 5, totalDisputados: 6 })).toThrow(RangeError);
  });
});
