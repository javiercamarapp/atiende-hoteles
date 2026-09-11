// REQ-HK-012 (docs/ACEPTACION.md): "Ticket enriquecido con historial del activo
// asociado; N tickets repetidos en X días (configurable) sobre el mismo activo escalan
// automáticamente (verificado con N+1 repeticiones)." Unit puro (sin BD, sin I/O) de
// `packages/domain-hotel/src/tickets/assetEscalation.ts` -- verifica: (1) el default de
// política (3 en 14 días) cuando el hotel no configuró la suya, (2) que una política
// configurada la reemplaza COMPLETA (nunca mezcla un campo configurado con el otro en
// default), (3) que una política configurada inválida (0/negativo) cae al default
// completo, (4) la decisión de escalar en el límite exacto N y justo por debajo (N-1,
// caso negativo), y (5) la aritmética de la ventana de días. El escenario de
// integración real contra embedded-postgres (crear tickets reales, contar dentro de la
// ventana, escalar de punta a punta) vive en
// `tests/integration/mantenimiento/escalado-por-repeticion.spec.ts`.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASSET_ESCALATION_POLICY,
  DEFAULT_ASSET_ESCALATION_ROLES,
  computeEscalationWindowStart,
  resolveAssetEscalationPolicy,
  shouldEscalateAsset,
} from "@atiende-hoteles/domain-hotel";
import {
  DEFAULT_ASSET_ESCALATION_POLICY as AGENT_CORE_DEFAULT_ASSET_ESCALATION_POLICY,
  DEFAULT_ASSET_ESCALATION_ROLES as AGENT_CORE_DEFAULT_ASSET_ESCALATION_ROLES,
} from "@atiende-hoteles/agent-core";

// agent-core sigue sin depender de `@atiende-hoteles/domain-hotel` (núcleo puro sin
// dependencias externas al paquete, ver comentario de cabecera de
// `packages/agent-core/src/tools/ticketTools.ts` para el mismo criterio ya aplicado al
// SLA) -- `createMaintenanceTicketTool` (housekeepingTools.ts) mantiene su PROPIA copia
// del default de escalación por repetición. Esta prueba es la que garantiza que ambas
// copias nunca diverjan en silencio.
describe("paridad domain-hotel ↔ agent-core del default de escalación por repetición (REQ-HK-012)", () => {
  it("el default de agent-core coincide EXACTAMENTE con el de domain-hotel", () => {
    expect(AGENT_CORE_DEFAULT_ASSET_ESCALATION_POLICY).toEqual(DEFAULT_ASSET_ESCALATION_POLICY);
  });

  it("los roles de escalación de agent-core coinciden con los de domain-hotel", () => {
    expect(AGENT_CORE_DEFAULT_ASSET_ESCALATION_ROLES).toEqual(DEFAULT_ASSET_ESCALATION_ROLES);
  });
});

describe("resolveAssetEscalationPolicy — configurado vs. default (REQ-HK-012)", () => {
  it("usa el default (3 en 14 días) cuando el hotel no configuró ninguna política", () => {
    expect(resolveAssetEscalationPolicy(null)).toEqual(DEFAULT_ASSET_ESCALATION_POLICY);
    expect(resolveAssetEscalationPolicy(undefined)).toEqual(DEFAULT_ASSET_ESCALATION_POLICY);
  });

  it("usa la política configurada del hotel cuando ambos campos son válidos", () => {
    expect(resolveAssetEscalationPolicy({ thresholdCount: 5, windowDays: 30 })).toEqual({
      thresholdCount: 5,
      windowDays: 30,
    });
  });

  it.each([
    { thresholdCount: 0, windowDays: 14 },
    { thresholdCount: -1, windowDays: 14 },
    { thresholdCount: 5, windowDays: 0 },
    { thresholdCount: 5, windowDays: -3 },
  ])(
    "una política configurada parcialmente inválida (%j) cae COMPLETA al default, nunca mezcla un campo configurado con el otro en default",
    (configurada) => {
      expect(resolveAssetEscalationPolicy(configurada)).toEqual(DEFAULT_ASSET_ESCALATION_POLICY);
    },
  );
});

describe("computeEscalationWindowStart — aritmética de la ventana (REQ-HK-012 'X días')", () => {
  it("resta exactamente windowDays días (en ms) a `now`", () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const inicio = computeEscalationWindowStart(now, 14);
    expect(inicio.toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });

  it("con windowDays=1 resta exactamente 24 horas", () => {
    const now = new Date("2026-09-15T00:00:00.000Z");
    expect(computeEscalationWindowStart(now, 1).toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
});

describe("shouldEscalateAsset — decisión de escalar (REQ-HK-012 'N tickets repetidos ... escalan automáticamente')", () => {
  const policy = { thresholdCount: 3, windowDays: 14 };

  it("NO escala por debajo del umbral (N-1 tickets en la ventana)", () => {
    expect(shouldEscalateAsset(2, policy)).toBe(false);
  });

  it("escala exactamente AL alcanzar el umbral N (inclusive, no requiere N+1 para disparar)", () => {
    expect(shouldEscalateAsset(3, policy)).toBe(true);
  });

  it("sigue escalando por encima del umbral (N+1, el caso explícito del criterio de aceptación)", () => {
    expect(shouldEscalateAsset(4, policy)).toBe(true);
  });

  it("con 0 tickets nunca escala, sin importar un umbral muy bajo (caso negativo trivial)", () => {
    expect(shouldEscalateAsset(0, { thresholdCount: 1, windowDays: 14 })).toBe(false);
  });
});

describe("DEFAULT_ASSET_ESCALATION_ROLES", () => {
  it("escala a gm+owner por defecto (mismo trío que la escalación por SLA de guest_ticket)", () => {
    expect(DEFAULT_ASSET_ESCALATION_ROLES).toEqual(["gm", "owner"]);
  });
});
