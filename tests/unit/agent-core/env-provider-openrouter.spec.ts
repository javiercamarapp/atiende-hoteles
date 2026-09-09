// fix/llm-openrouter-real: pruebas de CONTRATO reales del adaptador HTTP de
// `EnvProvider` (packages/agent-core/src/provider.ts) contra un simulador local fiel al
// formato publico de OpenRouter (`POST /api/v1/chat/completions`, compatible OpenAI --
// ver tests/support/openRouterSimulator.ts). Cubren exactamente los 5 escenarios
// pedidos: completar sin tools, completar con tool_calls, respuesta truncada por
// max_tokens, error 401 (credencial invalida) y rate-limit 429, mas timeout. Ver
// `OPENROUTER_INTEGRATION_VERIFIED_AGAINST_REAL_API` (provider.ts): este archivo NO
// prueba contra el servicio real de openrouter.ai, solo el contrato documentado.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvProvider,
  ProviderHttpError,
  ProviderTransientError,
  ProviderUnavailableError,
  type LlmCompleteParams,
} from "@atiende-hoteles/agent-core";
import { startOpenRouterSimulator, type OpenRouterSimulator } from "../../support/openRouterSimulator.ts";

let sim: OpenRouterSimulator;

beforeEach(async () => {
  sim = await startOpenRouterSimulator();
});

afterEach(async () => {
  await sim.close();
});

function makeProvider(overrides: Partial<ConstructorParameters<typeof EnvProvider>[0]> = {}): EnvProvider {
  return new EnvProvider({
    id: "openrouter-test",
    env: { OPENROUTER_API_KEY: "sk-or-test-key" },
    baseUrl: sim.chatCompletionsUrl,
    timeoutMs: 300,
    ...overrides,
  });
}

const baseParams: LlmCompleteParams = {
  modelSlug: "claude-sonnet-5",
  system: "eres un agente de prueba de hotel",
  messages: [{ role: "user", content: "hola, quiero reservar una habitacion" }],
  toolNames: [],
  temperature: 0,
  maxOutputTokens: 512,
  disableParallelToolUse: true,
};

describe("EnvProvider (OpenRouter real) -- contrato HTTP contra simulador local", () => {
  it("completa sin tools: traduce el request (Authorization Bearer, modelo mapeado anthropic/<slug>, system+user) y la respuesta final", async () => {
    sim.enqueue({ kind: "final", content: "Claro, con gusto te ayudo a reservar.", usage: { promptTokens: 42, completionTokens: 18 } });

    const provider = makeProvider();
    const completion = await provider.complete(baseParams);

    expect(completion.text).toBe("Claro, con gusto te ayudo a reservar.");
    expect(completion.toolCalls).toHaveLength(0);
    expect(completion.truncated).toBe(false);
    expect(completion.stopReason).toBe("end_turn");
    expect(completion.usage).toEqual({ inputTokens: 42, outputTokens: 18 });
    // El modelSlug reportado sigue siendo el interno (pricing.ts/roles.ts), no el
    // string real que se le mando a OpenRouter -- ver comentario de EnvProviderOptions.
    expect(completion.modelSlug).toBe("claude-sonnet-5");

    expect(sim.requests).toHaveLength(1);
    const sent = sim.requests[0]!;
    expect(sent.headers.authorization).toBe("Bearer sk-or-test-key");
    expect(sent.body.model).toBe("anthropic/claude-sonnet-5");
    expect(sent.body.temperature).toBe(0);
    expect(sent.body.max_tokens).toBe(512);
    expect(sent.body.messages).toEqual([
      { role: "system", content: "eres un agente de prueba de hotel" },
      { role: "user", content: "hola, quiero reservar una habitacion" },
    ]);
    expect(sent.body.tools).toBeUndefined();
  });

  it("completa con tool_calls: declara `tools`/`tool_choice`/`parallel_tool_calls` en el request y traduce los tool_calls de la respuesta", async () => {
    sim.enqueue({
      kind: "tool_calls",
      calls: [{ id: "call-1", name: "consultar_disponibilidad", arguments: '{"fecha":"2026-10-01"}' }],
    });

    const provider = makeProvider();
    const completion = await provider.complete({
      ...baseParams,
      toolNames: ["consultar_disponibilidad", "crear_reserva"],
      disableParallelToolUse: true,
    });

    expect(completion.text).toBeNull();
    expect(completion.stopReason).toBe("tool_use");
    expect(completion.toolCalls).toEqual([
      { id: "call-1", name: "consultar_disponibilidad", input: { fecha: "2026-10-01" } },
    ]);

    const sent = sim.requests[0]!;
    expect(sent.body.tool_choice).toBe("auto");
    expect(sent.body.parallel_tool_calls).toBe(false); // disableParallelToolUse:true -> parallel_tool_calls:false
    expect(sent.body.tools).toEqual([
      { type: "function", function: { name: "consultar_disponibilidad", parameters: { type: "object", properties: {}, additionalProperties: true } } },
      { type: "function", function: { name: "crear_reserva", parameters: { type: "object", properties: {}, additionalProperties: true } } },
    ]);
  });

  it("argumentos de tool_call no-JSON no tumban la llamada: quedan como {_raw} para que el runner los rechace con su propio mensaje", async () => {
    sim.enqueue({ kind: "tool_calls", calls: [{ name: "consultar_disponibilidad", arguments: "esto no es json" }] });
    const provider = makeProvider();
    const completion = await provider.complete({ ...baseParams, toolNames: ["consultar_disponibilidad"] });
    expect(completion.toolCalls[0]!.input).toEqual({ _raw: "esto no es json" });
  });

  it("respuesta truncada por max_tokens (finish_reason:'length'): truncated:true y stopReason:'max_tokens'", async () => {
    sim.enqueue({ kind: "truncated", content: "la respuesta se corta a la mit" });
    const provider = makeProvider();
    const completion = await provider.complete(baseParams);
    expect(completion.truncated).toBe(true);
    expect(completion.stopReason).toBe("max_tokens");
    expect(completion.text).toBe("la respuesta se corta a la mit");
  });

  it("401 (credencial invalida/revocada): lanza ProviderHttpError con status 401, NO ProviderTransientError -- no debe disparar fallback cross-provider, y expone el status", async () => {
    sim.enqueue({ kind: "http_error", status: 401, message: "No auth credentials found", code: "invalid_api_key" });
    const provider = makeProvider();

    try {
      await provider.complete(baseParams);
      expect.unreachable("debia lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderHttpError);
      expect(err).not.toBeInstanceOf(ProviderTransientError);
      expect((err as InstanceType<typeof ProviderHttpError>).status).toBe(401);
    }
  });

  it("429 (rate limit): lanza ProviderTransientError -- SI apto para fallback cross-provider", async () => {
    sim.enqueue({ kind: "http_error", status: 429, message: "Rate limit exceeded", code: "rate_limit_exceeded" });
    const provider = makeProvider();
    await expect(provider.complete(baseParams)).rejects.toThrow(ProviderTransientError);
  });

  it("5xx del proveedor tambien es transitorio", async () => {
    sim.enqueue({ kind: "http_error", status: 503, message: "upstream unavailable" });
    const provider = makeProvider();
    await expect(provider.complete(baseParams)).rejects.toThrow(ProviderTransientError);
  });

  it("timeout: si OpenRouter no responde dentro de timeoutMs, lanza ProviderTransientError (apto para fallback), nunca cuelga la corrida", async () => {
    sim.enqueue({ kind: "hang" });
    const provider = makeProvider({ timeoutMs: 150 });
    await expect(provider.complete(baseParams)).rejects.toThrow(ProviderTransientError);
  });

  it("200 sin 'choices' (contrato inesperado): lanza ProviderHttpError, nunca fabrica una respuesta vacia como si fuera valida", async () => {
    sim.enqueue({ kind: "raw_200", body: { id: "sim-raro", model: "anthropic/claude-sonnet-5" } });
    const provider = makeProvider();
    await expect(provider.complete(baseParams)).rejects.toThrow(ProviderHttpError);
  });

  it("sin OPENROUTER_API_KEY: isAvailable() false y complete() lanza ProviderUnavailableError SIN llegar a tocar la red", async () => {
    const provider = makeProvider({ env: {} });
    expect(provider.isAvailable()).toBe(false);
    await expect(provider.complete(baseParams)).rejects.toThrow(ProviderUnavailableError);
    expect(sim.requests).toHaveLength(0);
  });

  it("modelo configurable por env (OPENROUTER_MODEL) sobreescribe el mapeo por defecto para TODAS las llamadas de esa instancia", async () => {
    sim.enqueue({ kind: "final", content: "ok" });
    const provider = makeProvider({ env: { OPENROUTER_API_KEY: "sk-or-test-key", OPENROUTER_MODEL: "openai/gpt-5" } });
    await provider.complete(baseParams);
    expect(sim.requests[0]!.body.model).toBe("openai/gpt-5");
  });

  it("modelSlugOverride reporta el modelo REAL usado por esta instancia (proveedor de respaldo con modelo distinto al de params.modelSlug), para que el costo se atribuya correctamente", async () => {
    sim.enqueue({ kind: "final", content: "ok", usage: { promptTokens: 10, completionTokens: 5 } });
    const provider = makeProvider({ model: "anthropic/claude-haiku-4-5", modelSlugOverride: "claude-haiku-4-5" });
    const completion = await provider.complete(baseParams); // params.modelSlug sigue siendo "claude-sonnet-5"
    expect(sim.requests[0]!.body.model).toBe("anthropic/claude-haiku-4-5");
    expect(completion.modelSlug).toBe("claude-haiku-4-5");
  });

  it("reenvia effort como reasoning.effort (Unified Reasoning API de OpenRouter) cuando LlmCompleteParams.effort viene fijado", async () => {
    sim.enqueue({ kind: "final", content: "ok" });
    const provider = makeProvider();
    await provider.complete({ ...baseParams, effort: "low" });
    expect(sim.requests[0]!.body.reasoning).toEqual({ effort: "low" });
  });

  it("historial con mensajes 'tool' previos: sintetiza el tool_calls del assistant anterior para que el request sea valido segun el contrato OpenAI/OpenRouter", async () => {
    sim.enqueue({ kind: "final", content: "listo, ya quedo registrada la tarea" });
    const provider = makeProvider();
    await provider.complete({
      ...baseParams,
      messages: [
        { role: "user", content: "crea una tarea de limpieza" },
        { role: "assistant", content: "" },
        { role: "tool", toolCallId: "call-9", toolName: "crear_tarea_housekeeping", content: "tarea creada: HK-1" },
      ],
    });
    const messages = sim.requests[0]!.body.messages as Array<Record<string, unknown>>;
    const assistantMsg = messages[2]!;
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tool_calls).toEqual([
      { id: "call-9", type: "function", function: { name: "crear_tarea_housekeeping", arguments: "{}" } },
    ]);
    const toolMsg = messages[3]!;
    expect(toolMsg).toEqual({ role: "tool", content: "tarea creada: HK-1", tool_call_id: "call-9" });
  });
});
