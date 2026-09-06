// Proveedor de LLM abstracto (ADR-006/ADR-007): el AgentRunner nunca habla directo con
// un SDK de proveedor. `FakeProvider` es determinista para pruebas; `EnvProvider` lee
// credenciales de entorno y, si faltan, se declara "unavailable" de forma honesta -- y si
// SI hay credenciales, declara honestamente que la llamada real esta pendiente de
// integracion (H6a es nucleo puro, sin llamadas reales a proveedores de LLM).

import { ProviderNotImplementedError, ProviderUnavailableError } from "./errors.ts";

export interface LlmToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "unavailable";

export interface LlmCompletion {
  readonly modelSlug: string;
  readonly text: string | null;
  readonly toolCalls: readonly LlmToolCallRequest[];
  readonly usage: LlmUsage;
  /** true si la respuesta se corto por limite de tokens: se trata como error, nunca
   * como respuesta valida (ver AgentRunner). */
  readonly truncated: boolean;
  readonly stopReason: LlmStopReason;
}

export interface LlmCompleteParams {
  readonly modelSlug: string;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly toolNames: readonly string[];
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** REQ-AGT-004: pide al proveedor que NO devuelva varias tool calls en la misma
   * respuesta -- el core nunca debe tener que decidir en paralelo dos rutas de dinero
   * (o de efecto en general) generadas en una sola llamada. `AgentRunner` lo envia
   * siempre en `true`; un `LlmProvider` real (Anthropic: `disable_parallel_tool_use`)
   * debe honrarlo. Ver tambien el guardarraiz de refuerzo en AgentRunner.run() (aud-1
   * agentico.md ALTO: "disable_parallel_tool_use no anclado en ningun tipo/chequeo"). */
  readonly disableParallelToolUse: boolean;
}

export interface LlmProvider {
  readonly id: string;
  isAvailable(): boolean;
  complete(params: LlmCompleteParams): Promise<LlmCompletion>;
}

/** Error transitorio (red, 5xx, rate limit) apto para fallback cross-provider. Cualquier
 * otro error (4xx, credenciales, no implementado) NO dispara fallback. */
export class ProviderTransientError extends Error {
  readonly providerId: string;

  constructor(providerId: string, message: string) {
    super(message);
    this.name = "ProviderTransientError";
    this.providerId = providerId;
  }
}

export type FakeStep =
  | { readonly kind: "tool_calls"; readonly calls: ReadonlyArray<{ name: string; input: unknown }>; readonly usage?: Partial<LlmUsage> }
  | { readonly kind: "final"; readonly text: string; readonly usage?: Partial<LlmUsage> }
  | { readonly kind: "truncated"; readonly partialText?: string; readonly usage?: Partial<LlmUsage> }
  | { readonly kind: "transient_error" };

/** Proveedor determinista para pruebas: reproduce un guion de pasos fijo, sin red. */
export class FakeProvider implements LlmProvider {
  readonly id = "fake";
  private cursor = 0;
  // H6b: campos explicitos, no "parameter properties" (ver mismo comentario en
  // runner.ts) -- incompatibles con `node --experimental-strip-types`, el runtime real
  // de apps/api.
  private readonly script: readonly FakeStep[];
  private readonly modelSlugOverride?: string;

  constructor(script: readonly FakeStep[], modelSlugOverride?: string) {
    this.script = script;
    this.modelSlugOverride = modelSlugOverride;
  }

  isAvailable(): boolean {
    return true;
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompletion> {
    const step = this.script[this.cursor];
    const modelSlug = this.modelSlugOverride ?? params.modelSlug;
    if (!step) {
      return this.finalCompletion(modelSlug, "(fin de guion de prueba: FakeProvider sin mas pasos)", {});
    }
    this.cursor += 1;

    switch (step.kind) {
      case "transient_error":
        throw new ProviderTransientError(this.id, "error transitorio simulado por FakeProvider");
      case "tool_calls":
        return {
          modelSlug,
          text: null,
          toolCalls: step.calls.map((call, i) => ({
            id: `fake-call-${this.cursor}-${i}`,
            name: call.name,
            input: call.input,
          })),
          usage: {
            inputTokens: step.usage?.inputTokens ?? 50,
            outputTokens: step.usage?.outputTokens ?? 20,
          },
          truncated: false,
          stopReason: "tool_use",
        };
      case "final":
        return this.finalCompletion(modelSlug, step.text, step.usage);
      case "truncated":
        return {
          modelSlug,
          text: step.partialText ?? null,
          toolCalls: [],
          usage: {
            inputTokens: step.usage?.inputTokens ?? 50,
            outputTokens: step.usage?.outputTokens ?? 500,
          },
          truncated: true,
          stopReason: "max_tokens",
        };
      default: {
        const exhaustive: never = step;
        throw new Error(`FakeStep desconocido: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private finalCompletion(modelSlug: string, text: string, usage?: Partial<LlmUsage>): LlmCompletion {
    return {
      modelSlug,
      text,
      toolCalls: [],
      usage: {
        inputTokens: usage?.inputTokens ?? 50,
        outputTokens: usage?.outputTokens ?? 20,
      },
      truncated: false,
      stopReason: "end_turn",
    };
  }
}

export interface EnvProviderOptions {
  readonly id?: string;
  /** Orden de prioridad de variables de entorno a revisar. */
  readonly envKeys?: readonly string[];
  readonly env?: Record<string, string | undefined>;
}

const DEFAULT_ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] as const;

/**
 * Lee credenciales reales de entorno. Nunca hace una llamada de red en este hito:
 * - Sin credenciales: `complete()` lanza `ProviderUnavailableError` ("agente de IA no
 *   configurado en este entorno").
 * - Con credenciales: `complete()` lanza `ProviderNotImplementedError` (honesto: la
 *   integracion real con el proveedor esta pendiente, ver ADR-007) -- nunca se fabrica
 *   una respuesta para aparentar que la integracion funciona.
 */
export class EnvProvider implements LlmProvider {
  readonly id: string;
  private readonly envKeys: readonly string[];
  private readonly env: Record<string, string | undefined>;

  constructor(options: EnvProviderOptions = {}) {
    this.id = options.id ?? "env";
    this.envKeys = options.envKeys ?? DEFAULT_ENV_KEYS;
    this.env = options.env ?? process.env;
  }

  private credentialKey(): string | undefined {
    return this.envKeys.find((key) => Boolean(this.env[key] && this.env[key]!.trim().length > 0));
  }

  isAvailable(): boolean {
    return this.credentialKey() !== undefined;
  }

  async complete(_params: LlmCompleteParams): Promise<LlmCompletion> {
    const key = this.credentialKey();
    if (!key) {
      throw new ProviderUnavailableError(
        this.id,
        `agente de IA no configurado en este entorno: falta una de [${this.envKeys.join(", ")}]`,
      );
    }
    throw new ProviderNotImplementedError(
      this.id,
      `credencial "${key}" presente, pero la llamada real al proveedor LLM no esta ` +
        `implementada en agent-core (H6a es nucleo sin integraciones externas; ver ADR-007)`,
    );
  }
}
