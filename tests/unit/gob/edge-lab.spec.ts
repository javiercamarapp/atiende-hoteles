// REQ-AGT-021 (BP-138): skill hotelera `edge-lab`. Dos cosas se prueban: (1) que los 15
// escenarios reales de `SCENARIOS` (contra folioEngine/fnbAllergyGuard/revenueEngineGate,
// módulos ya probados por su propia suite) efectivamente pasan hoy -- si un cambio futuro
// en esos módulos rompe una frontera, esta prueba cae igual que `edge-lab.ts` caería en
// CLI; (2) que `runEdgeLab` SÍ detecta un escenario que falla de verdad (caso negativo,
// con un escenario sintético construido para fallar a propósito).
import { describe, expect, it } from "vitest";
import { runEdgeLab, SCENARIOS, type EdgeScenario } from "../../../scripts/skills/edge-lab.ts";

describe("edge-lab: escenarios reales", () => {
  it("los 15 escenarios de frontera documentados pasan contra el dominio real", () => {
    const results = runEdgeLab();
    const fallidos = results.filter((r) => !r.ok);
    expect(fallidos).toEqual([]);
    expect(results.length).toBe(SCENARIOS.length);
    expect(results.length).toBeGreaterThanOrEqual(15);
  });

  it("cubre los tres módulos citados por BP-138/REQ-AGT-021 (folio, alergias F&B, gate de revenue)", () => {
    const modulos = new Set(SCENARIOS.map((s) => s.module));
    expect(modulos).toEqual(new Set(["folioEngine", "fnbAllergyGuard", "revenueEngineGate"]));
  });

  it("cada escenario tiene un id único (para que un reporte de fallo sea inequívoco)", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("edge-lab: detecta un escenario que sí falla (caso negativo)", () => {
  it("runEdgeLab reporta ok=false para un escenario construido para fallar", () => {
    const escenarioRoto: EdgeScenario = {
      id: "sintetico-roto",
      module: "sintetico",
      description: "escenario de prueba que espera un resultado incorrecto a propósito",
      run: () => ({ ok: false, detail: "FALLA: forzada para probar la detección del runner" }),
    };
    const results = runEdgeLab([...SCENARIOS, escenarioRoto]);
    const roto = results.find((r) => r.id === "sintetico-roto");
    expect(roto?.ok).toBe(false);
  });
});
