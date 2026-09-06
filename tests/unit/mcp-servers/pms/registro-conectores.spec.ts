// REQ-REV-008/REQ-AGT-018: registro único de conectores PMS -- el orden de prioridad
// de construcción (Cloudbeds→Mews→SiteMinder→OHIP, consenso mayoritario documentado en
// docs/REQUISITOS.md §4 punto 8) debe estar reflejado en un único lugar verificable,
// nunca disperso en `if provider === X` por el código. `scripts/checks/orden-conectores-pms.ts`
// complementa esta prueba con una revisión estática de que ningún archivo bifurca por
// nombre de proveedor fuera de este registro.
import { describe, expect, it } from "vitest";
import { getPmsConnectorRegistry, PMS_CONNECTOR_REGISTRY } from "@atiende-hoteles/mcp-pms";

describe("registro único de conectores PMS (REQ-REV-008)", () => {
  it("declara exactamente el orden de prioridad Cloudbeds(1)→Mews(2)→SiteMinder(3)→OHIP(4)", () => {
    const byPriority = [...PMS_CONNECTOR_REGISTRY].sort((a, b) => a.priority - b.priority);
    expect(byPriority.map((e) => e.provider)).toEqual(["cloudbeds", "mews", "siteminder", "ohip"]);
    expect(byPriority.map((e) => e.priority)).toEqual([1, 2, 3, 4]);
  });

  it("no tiene prioridades duplicadas ni proveedores duplicados", () => {
    const priorities = PMS_CONNECTOR_REGISTRY.map((e) => e.priority);
    const providers = PMS_CONNECTOR_REGISTRY.map((e) => e.provider);
    expect(new Set(priorities).size).toBe(priorities.length);
    expect(new Set(providers).size).toBe(providers.length);
  });

  it("solo Cloudbeds está marcado como implementado hoy (estado real, no aspiracional)", () => {
    const implementados = PMS_CONNECTOR_REGISTRY.filter((e) => e.status === "implementado").map((e) => e.provider);
    expect(implementados).toEqual(["cloudbeds"]);
  });

  it("getPmsConnectorRegistry() devuelve el mismo registro (función de acceso única)", () => {
    expect(getPmsConnectorRegistry()).toBe(PMS_CONNECTOR_REGISTRY);
  });
});
