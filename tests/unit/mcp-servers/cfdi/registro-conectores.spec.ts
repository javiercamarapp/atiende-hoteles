// REQ-INT-015 (GOB-059/BP-141): el patrón de "registro único" de conectores (nacido con
// PMS en REQ-REV-008/REQ-AGT-018, ver tests/unit/mcp-servers/pms/registro-conectores.spec.ts)
// también aplica a conectores CFDI/PAC -- el orden de conmutación Finkok(1, primario)→
// SW Sapien(2, secundario), ya reflejado en cómo `apps/api/src/app.ts` construye
// `DualPacCfdiPort`, debe estar declarado en un único lugar verificable, nunca disperso
// en `if provider === X` por el código. `scripts/checks/registro-unico-conectores.ts`
// complementa esta prueba con una revisión estática de que ningún archivo bifurca por
// nombre de PAC fuera de este registro.
import { describe, expect, it } from "vitest";
import { getCfdiConnectorRegistry, CFDI_CONNECTOR_REGISTRY } from "@atiende-hoteles/mcp-cfdi";

describe("registro único de conectores CFDI/PAC (REQ-INT-015)", () => {
  it("declara exactamente el orden de conmutación Finkok(1, primario)→SW Sapien(2, secundario)", () => {
    const byPriority = [...CFDI_CONNECTOR_REGISTRY].sort((a, b) => a.priority - b.priority);
    expect(byPriority.map((e) => e.provider)).toEqual(["finkok", "sw_sapien"]);
    expect(byPriority.map((e) => e.priority)).toEqual([1, 2]);
  });

  it("no tiene prioridades duplicadas ni PAC duplicados", () => {
    const priorities = CFDI_CONNECTOR_REGISTRY.map((e) => e.priority);
    const providers = CFDI_CONNECTOR_REGISTRY.map((e) => e.provider);
    expect(new Set(priorities).size).toBe(priorities.length);
    expect(new Set(providers).size).toBe(providers.length);
  });

  it("Finkok y SW Sapien están marcados como implementados hoy (estado real: código de adaptador existe, pendiente de credenciales/CSD)", () => {
    const implementados = CFDI_CONNECTOR_REGISTRY.filter((e) => e.status === "implementado").map((e) => e.provider);
    expect(implementados).toEqual(["finkok", "sw_sapien"]);
  });

  it("getCfdiConnectorRegistry() devuelve el mismo registro (función de acceso única)", () => {
    expect(getCfdiConnectorRegistry()).toBe(CFDI_CONNECTOR_REGISTRY);
  });
});
