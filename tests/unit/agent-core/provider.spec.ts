// LlmProvider abstracto: FakeProvider es determinista para pruebas; EnvProvider se
// declara honestamente "sin configurar" cuando faltan credenciales (ADR-006/ADR-007).
// fix/llm-openrouter-real: EnvProvider ahora SI habla con OpenRouter de verdad -- las
// pruebas de contrato HTTP (sin tools, con tool_calls, truncado, 401, rate-limit,
// timeout) contra un simulador local viven en
// tests/unit/agent-core/env-provider-openrouter.spec.ts; este archivo solo cubre la
// semántica local de disponibilidad/credenciales que NO requiere red.
import { describe, expect, it } from "vitest";
import {
  EnvProvider,
  FakeProvider,
  ProviderRouter,
  ProviderTransientError,
  ProviderUnavailableError,
  type LlmProvider,
} from "@atiende-hoteles/agent-core";

const baseParams = {
  modelSlug: "claude-sonnet-5",
  system: "eres un agente de prueba",
  messages: [],
  toolNames: [],
  temperature: 0,
  maxOutputTokens: 100,
  disableParallelToolUse: true,
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

  it("isAvailable() es true con OPENROUTER_API_KEY presente", () => {
    const provider = new EnvProvider({ env: { OPENROUTER_API_KEY: "sk-or-test-123" } });
    expect(provider.isAvailable()).toBe(true);
  });

  it("isAvailable() es false con ANTHROPIC_API_KEY presente pero sin OPENROUTER_API_KEY -- OpenRouter es la unica credencial que este complete() sabe usar", () => {
    const provider = new EnvProvider({ env: { ANTHROPIC_API_KEY: "sk-ant-test-123" } });
    expect(provider.isAvailable()).toBe(false);
  });

  // El contrato HTTP real (llamada, traduccion request/response, tool_calls, truncado,
  // 401/429/timeout) se prueba contra un simulador local en
  // env-provider-openrouter.spec.ts -- no se duplica aqui.
});

// REQ-AGT-011/LLM-022: router propio de fallback de proveedor -- garantiza continuidad
// en canales conversacionales cuando el proveedor primario NUNCA llega a estar
// disponible (sin credenciales / chequeo de salud propio del LlmProvider), saltando
// directo al de respaldo en vez de pagar una llamada que ya se sabe perdida. Un fallo
// TRANSITORIO a mitad de una llamada ya en curso NO lo captura este router -- eso sigue
// siendo responsabilidad de `AgentRunner.fallbackProvider` (runner.spec.ts), para no
// duplicar esa lógica ni su rastro en la traza (`provider_fallback`).
describe("ProviderRouter", () => {
  it("isAvailable() es true si CUALQUIERA de los proveedores registrados esta disponible", () => {
    const primario = new EnvProvider({ id: "primario", env: {} });
    const respaldo = new EnvProvider({ id: "respaldo", env: { OPENROUTER_API_KEY: "sk-r" } });
    const router = new ProviderRouter({ providers: [primario, respaldo] });
    expect(router.isAvailable()).toBe(true);
  });

  it("isAvailable() es false solo cuando TODOS los proveedores registrados lo estan", () => {
    const primario = new EnvProvider({ id: "primario", env: {} });
    const respaldo = new EnvProvider({ id: "respaldo", env: {} });
    const router = new ProviderRouter({ providers: [primario, respaldo] });
    expect(router.isAvailable()).toBe(false);
  });

  it("con el primario disponible, complete() responde con el primario y nunca toca el de respaldo", async () => {
    const primario = new FakeProvider([{ kind: "final", text: "respondio el primario" }], "modelo-primario");
    const respaldo = new FakeProvider([{ kind: "final", text: "NUNCA deberia verse" }], "modelo-respaldo");
    const router = new ProviderRouter({ providers: [primario, respaldo] });

    const completion = await router.complete(baseParams);

    expect(completion.text).toBe("respondio el primario");
    expect(completion.modelSlug).toBe("modelo-primario");
    expect(router.getLastUsedProviderId()).toBe(primario.id);
    // El guion del respaldo sigue intacto (nunca se le llamo) -- lo verifica el primer
    // paso de su propio guion, que seguiria devolviendo el texto de aviso si se le
    // llamara ahora.
    const stillUntouched = await respaldo.complete(baseParams);
    expect(stillUntouched.text).toBe("NUNCA deberia verse");
  });

  it("REQ-AGT-011: si el primario NO esta disponible (sin credenciales), continua con el de respaldo sin intentar la llamada perdida", async () => {
    const primario = new EnvProvider({ id: "anthropic-primario", env: {} });
    const respaldo = new FakeProvider(
      [{ kind: "final", text: "conversacion continua por el respaldo" }],
      "modelo-respaldo",
    );
    const router = new ProviderRouter({ providers: [primario, respaldo] });

    const completion = await router.complete(baseParams);

    expect(completion.text).toBe("conversacion continua por el respaldo");
    expect(router.getLastUsedProviderId()).toBe(respaldo.id);
  });

  it("si NINGUN proveedor esta disponible, lanza ProviderUnavailableError listando los ids probados (nunca fabrica una respuesta)", async () => {
    const primario = new EnvProvider({ id: "anthropic-primario", env: {} });
    const respaldo = new EnvProvider({ id: "openrouter-respaldo", env: {} });
    const router = new ProviderRouter({ providers: [primario, respaldo] });

    await expect(router.complete(baseParams)).rejects.toThrow(ProviderUnavailableError);
    await expect(router.complete(baseParams)).rejects.toThrow(/anthropic-primario/);
    await expect(router.complete(baseParams)).rejects.toThrow(/openrouter-respaldo/);
  });

  it("un fallo TRANSITORIO a mitad de la llamada del proveedor elegido se propaga tal cual, sin capturarlo aqui", async () => {
    const primario = new FakeProvider([{ kind: "transient_error" }]);
    const respaldo = new FakeProvider([{ kind: "final", text: "no deberia llamarse desde este router" }]);
    const router = new ProviderRouter({ providers: [primario, respaldo] });

    await expect(router.complete(baseParams)).rejects.toThrow(ProviderTransientError);
    // El respaldo sigue intacto: este router NO lo invoco (esa reaccion es
    // responsabilidad de AgentRunner.fallbackProvider, no de este router).
    const stillUntouched = await respaldo.complete(baseParams);
    expect(stillUntouched.text).toBe("no deberia llamarse desde este router");
  });

  it("constructor rechaza una lista vacia de proveedores", () => {
    expect(() => new ProviderRouter({ providers: [] })).toThrow();
  });

  it("id por defecto es 'router'; se puede sobreescribir explicitamente", () => {
    const provider: LlmProvider = new FakeProvider([]);
    expect(new ProviderRouter({ providers: [provider] }).id).toBe("router");
    expect(new ProviderRouter({ providers: [provider], id: "router-canal" }).id).toBe("router-canal");
  });

  it("getLastUsedProviderId() es undefined antes de la primera llamada", () => {
    const router = new ProviderRouter({ providers: [new FakeProvider([])] });
    expect(router.getLastUsedProviderId()).toBeUndefined();
  });
});
