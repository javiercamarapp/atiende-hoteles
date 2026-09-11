// Patrón Likida/atiende.ai #7: guardia genérica "nunca termina sin preguntar" -- pruebas
// puras del módulo (sin AgentRunner). Ver tests/unit/agent-core/runner.spec.ts para la
// integración end-to-end (close()/run_finished) con el agente onboarding_conversacional.
import { describe, expect, it } from "vitest";
import {
  COMPLETION_STATUS_UNKNOWN_MESSAGE,
  enforceCompletionStatusBeforeClosing,
  type ToolResultRecord,
} from "../../../packages/agent-core/src/completionStatusGuard.ts";

describe("enforceCompletionStatusBeforeClosing", () => {
  it("sin completionStatusToolName configurado, nunca bloquea (comportamiento de todos los demás agentes)", () => {
    const result = enforceCompletionStatusBeforeClosing("listo", "completado", [], undefined);
    expect(result).toEqual({ message: "listo", blocked: false, camposFaltantes: [] });
  });

  it("con un status distinto de 'completado', nunca bloquea (esos ya tienen su propio mensaje explícito)", () => {
    const result = enforceCompletionStatusBeforeClosing("mensaje", "esperando_aprobacion", [], "consultar_estado");
    expect(result.blocked).toBe(false);
  });

  it("status='completado' pero la tool de estado NUNCA se llamó esta corrida: bloquea con el mensaje genérico", () => {
    const result = enforceCompletionStatusBeforeClosing("listo, gracias", "completado", [], "consultar_estado");
    expect(result.blocked).toBe(true);
    expect(result.message).toBe(COMPLETION_STATUS_UNKNOWN_MESSAGE);
  });

  it("la tool de estado SÍ se llamó y reportó completo=true: no bloquea, el mensaje pasa tal cual", () => {
    const toolResults: ToolResultRecord[] = [{ toolName: "consultar_estado", summary: "completo", data: { completo: true } }];
    const result = enforceCompletionStatusBeforeClosing("¡Listo, tu onboarding terminó!", "completado", toolResults, "consultar_estado");
    expect(result).toEqual({ message: "¡Listo, tu onboarding terminó!", blocked: false, camposFaltantes: [] });
  });

  it("la tool de estado reportó completo=false con campos faltantes: reemplaza el mensaje por una pregunta que los nombra", () => {
    const toolResults: ToolResultRecord[] = [
      { toolName: "consultar_estado", summary: "incompleto", data: { completo: false, camposFaltantes: ["la zona horaria"] } },
    ];
    const result = enforceCompletionStatusBeforeClosing("¡Todo listo!", "completado", toolResults, "consultar_estado");
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("la zona horaria");
    expect(result.camposFaltantes).toEqual(["la zona horaria"]);
  });

  it("usa la ÚLTIMA llamada a la tool de estado esta corrida, no la primera", () => {
    const toolResults: ToolResultRecord[] = [
      { toolName: "consultar_estado", summary: "incompleto", data: { completo: false, camposFaltantes: ["x"] } },
      { toolName: "otra_tool", summary: "algo más", data: {} },
      { toolName: "consultar_estado", summary: "completo", data: { completo: true } },
    ];
    const result = enforceCompletionStatusBeforeClosing("listo", "completado", toolResults, "consultar_estado");
    expect(result.blocked).toBe(false);
  });

  it("ignora resultados de OTRAS tools que no sean la tool de estado configurada", () => {
    const toolResults: ToolResultRecord[] = [{ toolName: "otra_tool", summary: "algo", data: { completo: true } }];
    const result = enforceCompletionStatusBeforeClosing("listo", "completado", toolResults, "consultar_estado");
    expect(result.blocked).toBe(true); // la tool de ESTADO configurada nunca se llamó
  });

  it("un result.data con forma inesperada (sin 'completo' booleano) se trata como 'sin evidencia' (fail-closed)", () => {
    const toolResults: ToolResultRecord[] = [{ toolName: "consultar_estado", summary: "raro", data: { otraCosa: 123 } }];
    const result = enforceCompletionStatusBeforeClosing("listo", "completado", toolResults, "consultar_estado");
    expect(result.blocked).toBe(true);
  });
});
