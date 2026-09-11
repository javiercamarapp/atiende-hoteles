// REQ-INT-015 (GOB-059/BP-141): el patrón de "registro único" de conectores (nacido con
// PMS en REQ-REV-008/REQ-AGT-018, ver tests/unit/mcp-servers/pms/registro-conectores.spec.ts)
// también aplica a conectores de pago -- el orden de selección Stripe(1)→Conekta(2), ya
// documentado en `resolvePaymentPort()`, debe estar reflejado en un único lugar
// verificable, nunca disperso en `if provider === X` por el código.
// `scripts/checks/registro-unico-conectores.ts` complementa esta prueba con una revisión
// estática de que ningún archivo bifurca por nombre de proveedor de pago fuera de este
// registro.
import { describe, expect, it } from "vitest";
import { getPaymentConnectorRegistry, PAYMENT_CONNECTOR_REGISTRY } from "@atiende-hoteles/mcp-payments";

describe("registro único de conectores de pago (REQ-INT-015)", () => {
  it("declara exactamente el orden de prioridad Stripe(1)→Conekta(2)", () => {
    const byPriority = [...PAYMENT_CONNECTOR_REGISTRY].sort((a, b) => a.priority - b.priority);
    expect(byPriority.map((e) => e.provider)).toEqual(["stripe", "conekta"]);
    expect(byPriority.map((e) => e.priority)).toEqual([1, 2]);
  });

  it("no tiene prioridades duplicadas ni proveedores duplicados", () => {
    const priorities = PAYMENT_CONNECTOR_REGISTRY.map((e) => e.priority);
    const providers = PAYMENT_CONNECTOR_REGISTRY.map((e) => e.provider);
    expect(new Set(priorities).size).toBe(priorities.length);
    expect(new Set(providers).size).toBe(providers.length);
  });

  it("Stripe y Conekta están marcados como implementados hoy (estado real: código de adaptador existe)", () => {
    const implementados = PAYMENT_CONNECTOR_REGISTRY.filter((e) => e.status === "implementado").map((e) => e.provider);
    expect(implementados).toEqual(["stripe", "conekta"]);
  });

  it("getPaymentConnectorRegistry() devuelve el mismo registro (función de acceso única)", () => {
    expect(getPaymentConnectorRegistry()).toBe(PAYMENT_CONNECTOR_REGISTRY);
  });
});
