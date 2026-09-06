// LlmProvider abstracto: FakeProvider es determinista para pruebas; EnvProvider se
// declara honestamente "sin configurar" cuando faltan credenciales, y nunca fabrica una
// respuesta cuando SI hay credenciales pero la integracion real no esta implementada
// en este hito (ADR-006/ADR-007, sin llamadas reales a proveedores de LLM).
import { describe, expect, it } from "vitest";
import {
  EnvProvider,
  FakeProvider,
  ProviderNotImplementedError,
  ProviderTransientError,
  ProviderUnavailableError,
} from "@atiende-hoteles/agent-core";

const baseParams = {
  modelSlug: "claude-sonnet-5",
  system: "eres un agente de prueba",
  messages: [],
  toolNames: [],
  temperature: 0,
  maxOutputTokens: 100,
};

describe("FakeProvider", () => {
  it("reproduce el guion en orden: tool_calls y luego final", async () => {
    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "consultar_disponibilidad", input: {} }] },
      { kind: "final", text: "listo" },
    ]);
    const first = await provider.complete(baseParams);
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]!.name).toBe("consultar_disponibilidad");

    const second = await provider.complete(baseParams);
    expect(second.text).toBe("listo");
    expect(second.toolCalls).toHaveLength(0);
  });

  it("marca truncated:true en un paso 'truncated'", async () => {
    const provider = new FakeProvider([{ kind: "truncated", partialText: "a medi" }]);
    const completion = await provider.complete(baseParams);
    expect(completion.truncated).toBe(true);
    expect(completion.stopReason).toBe("max_tokens");
  });

  it("lanza ProviderTransientError en un paso 'transient_error'", async () => {
    const provider = new FakeProvider([{ kind: "transient_error" }]);
    await expect(provider.complete(baseParams)).rejects.toThrow(ProviderTransientError);
  });

  it("isAvailable() siempre es true", () => {
    expect(new FakeProvider([]).isAvailable()).toBe(true);
  });
});

describe("EnvProvider", () => {
  it("isAvailable() es false sin credenciales", () => {
    const provider = new EnvProvider({ env: {} });
    expect(provider.isAvailable()).toBe(false);
  });

  it("complete() lanza ProviderUnavailableError sin credenciales (estado honesto)", async () => {
    const provider = new EnvProvider({ env: {} });
    await expect(provider.complete(baseParams)).rejects.toThrow(ProviderUnavailableError);
  });

  it("isAvailable() es true con ANTHROPIC_API_KEY presente", () => {
    const provider = new EnvProvider({ env: { ANTHROPIC_API_KEY: "sk-test-123" } });
    expect(provider.isAvailable()).toBe(true);
  });

  it("complete() con credenciales presentes lanza ProviderNotImplementedError, NUNCA fabrica una respuesta", async () => {
    const provider = new EnvProvider({ env: { ANTHROPIC_API_KEY: "sk-test-123" } });
    await expect(provider.complete(baseParams)).rejects.toThrow(ProviderNotImplementedError);
  });
});
