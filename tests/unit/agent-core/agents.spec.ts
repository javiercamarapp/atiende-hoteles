// H7 · Catálogo de agentes como configuración (ADR-006): selección de modelo por rol +
// gate/techo por defecto de cada agente vendible -- ENTREGA punto 5 "unit (selección de
// modelo por rol y env...)".
import { describe, expect, it } from "vitest";
import {
  AGENT_DEFINITIONS,
  AUDITOR_NOCTURNO,
  ENRUTADOR_MENSAJES,
  ONBOARDING_CONVERSACIONAL,
  RECEPCION_VIRTUAL,
  getAgentDefinition,
  listAgentDefinitions,
  resolveModelForRole,
} from "@atiende-hoteles/agent-core";

describe("AGENT_DEFINITIONS", () => {
  it("declara los 3 agentes de H7 + onboarding_conversacional (patrón Likida #7) con nombre coherente con su clave", () => {
    const names = listAgentDefinitions().map((d) => d.name);
    expect(names.sort()).toEqual([AUDITOR_NOCTURNO, ENRUTADOR_MENSAJES, ONBOARDING_CONVERSACIONAL, RECEPCION_VIRTUAL].sort());
  });

  it("onboarding_conversacional declara completionStatusToolName y SOLO owner/gm pueden dispararlo", () => {
    const onboarding = getAgentDefinition(ONBOARDING_CONVERSACIONAL)!;
    expect(onboarding.completionStatusToolName).toBe("consultar_estado_onboarding");
    expect(onboarding.toolNames).toContain("consultar_estado_onboarding");
    expect([...onboarding.allowedStaffRoles].sort()).toEqual(["gm", "owner"]);
  });

  it("cada agente arranca en gate shadow por defecto (BP-016: ningún agente nuevo entra en autopilot por omisión)", () => {
    for (const def of listAgentDefinitions()) {
      expect(def.defaultGate).toBe("shadow");
    }
  });

  it("cada agente resuelve al slug de modelo del rol que declara (recepción=canal->Sonnet, enrutador->Haiku, auditor=batch->Opus)", () => {
    expect(resolveModelForRole(AGENT_DEFINITIONS[RECEPCION_VIRTUAL]!.role)).toBe("claude-sonnet-5");
    expect(resolveModelForRole(AGENT_DEFINITIONS[ENRUTADOR_MENSAJES]!.role)).toBe("claude-haiku-4-5");
    expect(resolveModelForRole(AGENT_DEFINITIONS[AUDITOR_NOCTURNO]!.role)).toBe("claude-opus-5");
  });

  it("housekeeping/mantenimiento nunca aparecen en la lista de roles permitidos del auditor de revenue/cierre", () => {
    const auditor = getAgentDefinition(AUDITOR_NOCTURNO)!;
    expect(auditor.allowedStaffRoles).not.toContain("housekeeping");
    expect(auditor.allowedStaffRoles).not.toContain("maintenance");
  });

  it("el enrutador de mensajes no tiene tools registradas (solo clasifica, nunca ejecuta)", () => {
    expect(getAgentDefinition(ENRUTADOR_MENSAJES)!.toolNames).toHaveLength(0);
  });

  it("todo techo mensual por defecto es positivo y queda dentro de la banda total de referencia (LLM-026: USD 27-158/mes por hotel)", () => {
    const total = listAgentDefinitions().reduce((sum, d) => sum + d.defaultMonthlyCeilingUsd, 0);
    for (const def of listAgentDefinitions()) {
      expect(def.defaultMonthlyCeilingUsd).toBeGreaterThan(0);
    }
    expect(total).toBeGreaterThanOrEqual(27);
    expect(total).toBeLessThanOrEqual(158);
  });

  it("getAgentDefinition() devuelve undefined para un nombre inexistente (catálogo cerrado, REQ-AGT-018)", () => {
    expect(getAgentDefinition("agente_que_no_existe")).toBeUndefined();
  });
});
