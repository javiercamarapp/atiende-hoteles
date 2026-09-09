// Proveedor de LLM abstracto (ADR-006/ADR-007): el AgentRunner nunca habla directo con
// un SDK de proveedor. `FakeProvider` es determinista para pruebas; `EnvProvider` lee
// credenciales de entorno y, si faltan, se declara "unavailable" de forma honesta.
//
// Decision de negocio (docs/referencia/01-blueprint-y-decision-llm.md): el agente
// conversacional usa OpenRouter (https://openrouter.ai), NO un SDK de un solo
// proveedor -- `EnvProvider.complete()` hace una llamada HTTP real al endpoint
// OpenAI-compatible de OpenRouter (`POST /api/v1/chat/completions`,
// `Authorization: Bearer <OPENROUTER_API_KEY>`), documentado en
// https://openrouter.ai/docs/api-reference/chat-completion.
//
// fix/llm-openrouter-real: "esqueleto honesto" (ADR-006/ADR-007) -- esta integracion
// implementa el contrato HTTP REAL de OpenRouter (mismo formato de
// request/response documentado publicamente) y se prueba de verdad contra un
// simulador HTTP local fiel a ese contrato (ver
// tests/support/openRouterSimulator.ts / tests/unit/agent-core/env-provider-openrouter.spec.ts),
// pero NUNCA se ha ejercitado contra el servicio real de openrouter.ai -- no hay
// credenciales reales en este entorno de desarrollo/CI. Ver
// `OPENROUTER_INTEGRATION_VERIFIED_AGAINST_REAL_API` mas abajo (mismo patron que
// `SATSubmitter` en el repo hermano de facturacion: constante explicita en `false`,
// nunca "probablemente funciona" sin decirlo).
//
// Limitacion conocida, no oculta: `LlmCompleteParams.toolNames` (este mismo archivo)
// SOLO lleva nombres de tool, no el JSON Schema `strict:true`/`additionalProperties:
// false` que `tool.ts` `toStrictToolSchema()` ya sabe generar por tool -- esa funcion
// existe pero ningun codigo de `runner.ts` la invoca todavia al construir los params
// que le pasa a `LlmProvider.complete()`. Consecuencia real: esta implementacion le
// declara a OpenRouter cada tool con un `parameters` vacio/permisivo (`{}`,
// `additionalProperties: true`), asi que el modelo tiene que adivinar la forma de los
// argumentos solo por el nombre de la tool y el system prompt -- degrada la precision
// real de tool-calling contra un modelo de verdad. Corregirlo de raiz exige extender
// `LlmCompleteParams`/`AgentRunner` para propagar `toStrictToolSchema()` hasta aqui,
// un cambio de interfaz fuera del alcance de este fix (se pidio explicitamente no
// tocar la interfaz existente salvo necesidad estricta) -- documentado como pendiente
// para cuando se haga la primera prueba con credenciales reales, nunca escondido.
//
// Traduccion de historial de mensajes: `runner.ts` reconstruye el historial que le
// vuelve a mandar al proveedor con SOLO `{role:"assistant", content: texto}` seguido
// de los `{role:"tool", toolCallId, toolName, content}` de esa ronda -- no retiene el
// `input` JSON original de cada tool call. El contrato OpenAI/OpenRouter exige que todo
// mensaje `tool` encadene por `tool_call_id` con un `tool_calls` declarado en el
// mensaje `assistant` inmediatamente anterior, asi que `toOpenAiMessages()` (abajo)
// SINTETIZA ese `tool_calls` a partir de `toolCallId`/`toolName` con
// `arguments: "{}"` (placeholder, no el input real que el modelo uso) -- suficiente
// para que la forma del request sea valida, pero el modelo pierde el detalle exacto de
// que argumentos uso en una llamada anterior de la MISMA corrida si necesitara
// referenciarlos en un turno posterior.
import {
  ProviderHttpError,
  ProviderUnavailableError,
} from "./errors.ts";

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
  /** MEDIO (auditoria-2 agentico): REQ-AGT-005/REQ-AGT-016 exigen effort bajo en
   * canales de voz/WhatsApp (TTFT <600ms p50) -- antes `roleParamsForChannel()`
   * (roles.ts) calculaba este valor pero ningún código de `apps/api` lo llamaba NI
   * este tipo tenía dónde recibirlo, así que la corrección de la ronda 1 quedó
   * huérfana (cubierta solo por su propio test unitario). Opcional: un
   * `LlmProvider` real que no distinga effort puede ignorarlo. */
  readonly effort?: "low" | "medium" | "high";
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

export interface ProviderRouterOptions {
  /** Proveedores en orden de prioridad; el primero DISPONIBLE de la lista es al que se
   * llama. Se necesita al menos uno. */
  readonly providers: readonly LlmProvider[];
  readonly id?: string;
}

/**
 * Router propio de proveedor de modelo (REQ-AGT-011/LLM-022): en los canales
 * conversacionales (`recepcion_virtual`/`enrutador_mensajes`, ver `roles.ts`
 * `ModelRole` "canal"/"enrutador") el `AgentRunner` debe hablar con un `LlmProvider` que
 * garantice continuidad si el primario no esta disponible, en vez de que cada punto de
 * wiring (`apps/api`) tenga que decidir a mano cual proveedor usar. `ProviderRouter`
 * cubre el escenario que NINGUN otro mecanismo de este archivo cubria: el proveedor
 * primario todavia NO se ha intentado llamar y YA se sabe, por `isAvailable()`, que va a
 * fallar (sin credenciales, o cualquier chequeo de salud que el propio `LlmProvider`
 * implemente) -- salta derecho al siguiente proveedor disponible de la lista en vez de
 * pagar una llamada que ya se sabe perdida.
 *
 * Un fallo TRANSITORIO a mitad de una llamada ya en curso (`ProviderTransientError`) se
 * propaga tal cual, sin capturarlo aqui: ese caso ya lo cubre
 * `AgentRunnerOptions.fallbackProvider` (`runner.ts`), que reintenta la MISMA ronda con
 * el proveedor de respaldo y SI deja rastro en la traza (`provider_fallback`,
 * `AgentTraceEvent`) -- este router resuelve el caso anterior a esa llamada, no lo
 * duplica. Las dos capas se combinan pasando el mismo proveedor de respaldo como
 * `providers[1]` de este router Y como `fallbackProvider` del `AgentRunner` (ver
 * `apps/api/src/routes/agentes.ts`), para continuidad tanto si el primario nunca estuvo
 * disponible como si falla a medio camino.
 */
export class ProviderRouter implements LlmProvider {
  readonly id: string;
  private readonly providers: readonly LlmProvider[];
  private lastUsedProviderId: string | undefined;

  constructor(options: ProviderRouterOptions) {
    if (options.providers.length === 0) {
      throw new Error("ProviderRouter requiere al menos un LlmProvider registrado");
    }
    this.id = options.id ?? "router";
    this.providers = options.providers;
  }

  /** true si CUALQUIERA de los proveedores registrados esta disponible -- el router en
   * su conjunto solo esta "caido" cuando TODOS lo estan. */
  isAvailable(): boolean {
    return this.providers.some((provider) => provider.isAvailable());
  }

  /** `id` del proveedor que de verdad resolvio la ultima llamada -- `undefined` antes de
   * la primera. Util para atribuir costo/trazabilidad sin adivinar. */
  getLastUsedProviderId(): string | undefined {
    return this.lastUsedProviderId;
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompletion> {
    const chosen = this.providers.find((provider) => provider.isAvailable());
    if (!chosen) {
      throw new ProviderUnavailableError(
        this.id,
        `ningun proveedor disponible en este router (probados: ${this.providers.map((p) => p.id).join(", ")})`,
      );
    }
    this.lastUsedProviderId = chosen.id;
    return chosen.complete(params);
  }
}

export interface EnvProviderOptions {
  readonly id?: string;
  /** Orden de prioridad de variables de entorno a revisar para la credencial (Bearer
   * token). Default: solo `OPENROUTER_API_KEY` -- es la UNICA credencial que este
   * `complete()` sabe usar (llama al endpoint de OpenRouter, nunca a Anthropic/OpenAI
   * directo), asi que listar aqui una variable que guarde una clave de otro proveedor
   * (p.ej. `ANTHROPIC_API_KEY`) produciria un 401 real contra OpenRouter -- no lo hagas
   * salvo que sepas que esa variable SI contiene una clave valida de openrouter.ai. */
  readonly envKeys?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  /** Modelo EXACTO a pedirle a OpenRouter (p.ej. "anthropic/claude-sonnet-5"),
   * maxima prioridad. Si se omite: `env[modelEnvKey]`: si se omite eso tambien: se
   * deriva de `LlmCompleteParams.modelSlug` (el slug que `roles.ts` ya resuelve por rol
   * -- canal/enrutador/batch_nocturno) con el prefijo de vendor `anthropic/`, que es
   * como OpenRouter enruta los slugs de Claude que este repo usa
   * (DEFAULT_MODEL_BY_ROLE, roles.ts). Fijar `model` aqui es lo que permite que DOS
   * instancias de `EnvProvider` compartan la MISMA `OPENROUTER_API_KEY` pero llamen a
   * modelos distintos (p.ej. primario Sonnet / respaldo Haiku, ver
   * apps/api/src/routes/agentes.ts) -- failover cruzado de MODELO dentro de la MISMA
   * cuenta de OpenRouter, no de credencial. */
  readonly model?: string;
  /** Variable de entorno que, si esta presente, fija el modelo para TODAS las llamadas
   * de esta instancia sin importar `LlmCompleteParams.modelSlug` -- escape hatch
   * operativo (forzar un modelo especifico sin tocar codigo/`model` del constructor).
   * Default: "OPENROUTER_MODEL". */
  readonly modelEnvKey?: string;
  /** `LlmCompletion.modelSlug` que esta instancia reporta -- por defecto ecoa
   * `params.modelSlug` (igual que `FakeProvider` sin `modelSlugOverride`), correcto
   * cuando el modelo real invocado SI corresponde al slug que `roles.ts`/`pricing.ts`
   * esperan para ese rol. Fijalo explicitamente cuando `model` this instancia apunta a
   * un modelo DISTINTO del `modelSlug` que le llega en `params` (el caso del proveedor
   * de respaldo: sigue viniendo `modelSlug:"claude-sonnet-5"` en `params` pero esta
   * instancia en realidad llama a Haiku) -- si no, `estimateCostUsd`
   * (pricing.ts) le cobraria al hotel el precio de un modelo que no se uso. */
  readonly modelSlugOverride?: string;
  /** Base URL del endpoint de chat completions. Default: el real de OpenRouter.
   * Sobreescribible en pruebas para apuntar al simulador HTTP local. */
  readonly baseUrl?: string;
  /** `fetch` inyectable (tests: apuntar a un simulador local sin red real). Default:
   * `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Milisegundos antes de abortar la llamada HTTP y tratarla como error transitorio
   * (`ProviderTransientError`, apto para fallback). Default 30_000 -- generoso frente
   * al presupuesto de tiempo TOTAL de una corrida (`createRunBudget`, 60_000ms en
   * apps/api/agentes.ts), pero acotado: nunca cuelga la corrida indefinidamente. */
  readonly timeoutMs?: number;
  /** Headers opcionales que OpenRouter documenta para atribucion en su ranking publico
   * (no afectan la respuesta ni el cobro). */
  readonly httpReferer?: string;
  readonly appTitle?: string;
}

const DEFAULT_ENV_KEYS = ["OPENROUTER_API_KEY"] as const;
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL_ENV_KEY = "OPENROUTER_MODEL";
/** Default razonable cuando ni `model` (constructor) ni `env[modelEnvKey]` estan
 * fijados y `modelSlug` no es reconocible como slug de Claude (ver
 * `mapModelSlugToOpenRouterModel`) -- Sonnet 5 vía Anthropic es el modelo por defecto
 * documentado para el rol `canal` (roles.ts `DEFAULT_MODEL_BY_ROLE`). */
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-5";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * fix/llm-openrouter-real (ADR-006/ADR-007, "esqueleto honesto"): `false` explicito y
 * a proposito -- esta constante NUNCA debe volverse `true` por inferencia ("ya casi
 * seguro que funciona"), solo cuando alguien haya corrido de verdad
 * `EnvProvider.complete()` contra `https://openrouter.ai` con una `OPENROUTER_API_KEY`
 * real y confirmado una respuesta real de un modelo real. Ver el bloque de comentarios
 * al inicio de este archivo para el detalle de lo que SI se probo (contrato HTTP contra
 * un simulador local fiel) y lo que NO (el proveedor real).
 *
 * Pasos EXACTOS para la primera prueba real (ninguno se puede saltar):
 * 1. Crear una cuenta en https://openrouter.ai y generar una API key en
 *    "Settings -> API Keys".
 * 2. Cargar creditos (OpenRouter cobra prepago por uso; sin saldo, la cuenta real
 *    responde 402/403 aunque la key sea valida).
 * 3. Exportar `OPENROUTER_API_KEY=<la key real>` en el entorno del proceso que
 *    construye `EnvProvider` (apps/api).
 * 4. Opcional: exportar `OPENROUTER_MODEL=<slug-de-openrouter>` (p.ej.
 *    "anthropic/claude-sonnet-5") si el default no coincide con un modelo habilitado
 *    en esa cuenta -- confirmar el slug exacto en https://openrouter.ai/models.
 * 5. Ejecutar un `AgentRunner.run()` real (o `EnvProvider.complete()` suelto) SIN
 *    `demo:true` y verificar a mano el `AgentRunResult`/traza -- recien ahi, cambiar
 *    esta constante a `true` en el MISMO commit que documente la verificacion (fecha,
 *    modelo usado, quien la corrio).
 */
export const OPENROUTER_INTEGRATION_VERIFIED_AGAINST_REAL_API = false as const;

interface OpenRouterFunctionCall {
  readonly name: string;
  readonly arguments: string;
}

interface OpenRouterRequestToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: OpenRouterFunctionCall;
}

interface OpenRouterRequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenRouterRequestToolCall[];
}

/**
 * Traduce el historial provider-agnostico de `LlmCompleteParams` al formato de mensajes
 * OpenAI/OpenRouter. Ver el comentario de archivo ("Traduccion de historial...") para
 * la limitacion conocida: sintetiza el `tool_calls` que el contrato exige antes de cada
 * mensaje `tool`, con `arguments:"{}"` como placeholder porque `runner.ts` no retiene
 * el input original de la tool call en el historial que reenvia.
 */
function toOpenAiMessages(system: string, messages: readonly LlmMessage[]): OpenRouterRequestMessage[] {
  const out: OpenRouterRequestMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "tool") {
      const previous = out[out.length - 1];
      const toolCallId = message.toolCallId ?? `desconocido-${out.length}`;
      if (previous && previous.role === "assistant") {
        previous.tool_calls = previous.tool_calls ?? [];
        if (!previous.tool_calls.some((call) => call.id === toolCallId)) {
          previous.tool_calls.push({
            id: toolCallId,
            type: "function",
            function: { name: message.toolName ?? "tool_desconocida", arguments: "{}" },
          });
        }
        // OpenAI/OpenRouter exigen `content: null` (nunca "") en un mensaje assistant
        // que trae `tool_calls`.
        if (previous.content === "") previous.content = null;
      }
      out.push({ role: "tool", content: message.content, tool_call_id: toolCallId });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

/** `claude-*` es el unico prefijo de slug que `roles.ts` (`DEFAULT_MODEL_BY_ROLE`)
 * produce hoy -- OpenRouter enruta esos modelos bajo el vendor "anthropic/". Si un rol
 * futuro resuelve a un slug de otro vendor, este es el UNICO lugar que hay que tocar
 * (o baste con fijar `model`/`OPENROUTER_MODEL` para ese proceso, sin tocar codigo).
 * Exportada (no solo interna a `resolveOpenRouterModel`) para que un llamador como
 * `apps/api/src/routes/agentes.ts` pueda calcular, con la MISMA logica, el string de
 * OpenRouter que le corresponde a un slug de OTRO rol (p.ej. el de `enrutador`,
 * `resolveModelForRole("enrutador")`) al configurar `EnvProviderOptions.model` de una
 * instancia de respaldo con failover cruzado de MODELO. */
export function mapModelSlugToOpenRouterModel(modelSlug: string): string {
  if (modelSlug.startsWith("claude-")) return `anthropic/${modelSlug}`;
  return DEFAULT_OPENROUTER_MODEL;
}

function safeParseJsonArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Argumentos no-JSON de un modelo real: no se descarta la tool call completa (el
    // runner la valida de todos modos contra el Zod schema real de la tool y la
    // rechaza ahi con un mensaje claro), se le pasa el string crudo para que quede
    // rastro de lo que el modelo mando.
    return { _raw: raw };
  }
}

interface OpenRouterResponseToolCall {
  readonly id: string;
  readonly type?: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

interface OpenRouterResponseMessage {
  readonly role?: string;
  readonly content?: string | null;
  readonly tool_calls?: readonly OpenRouterResponseToolCall[];
}

interface OpenRouterChoice {
  readonly index?: number;
  readonly message: OpenRouterResponseMessage;
  readonly finish_reason?: string | null;
}

interface OpenRouterUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
}

interface OpenRouterErrorBody {
  readonly message?: string;
  readonly code?: number | string;
}

interface OpenRouterCompletionResponse {
  readonly choices?: readonly OpenRouterChoice[];
  readonly usage?: OpenRouterUsage;
  readonly error?: OpenRouterErrorBody;
}

function parseOpenRouterResponse(reportedModelSlug: string, body: OpenRouterCompletionResponse): LlmCompletion {
  const choice = body.choices?.[0];
  const toolCallsResponse = choice?.message.tool_calls ?? [];
  const toolCalls: LlmToolCallRequest[] = toolCallsResponse.map((call) => ({
    id: call.id,
    name: call.function.name,
    input: safeParseJsonArguments(call.function.arguments),
  }));
  const finishReason = choice?.finish_reason ?? null;
  const truncated = finishReason === "length";
  const stopReason: LlmStopReason = truncated ? "max_tokens" : toolCalls.length > 0 ? "tool_use" : "end_turn";
  return {
    modelSlug: reportedModelSlug,
    text: choice?.message.content ?? null,
    toolCalls,
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    },
    truncated,
    stopReason,
  };
}

/**
 * Llama de verdad al endpoint de chat completions de OpenRouter (formato compatible con
 * OpenAI Chat Completions, ver comentario de archivo para el contrato exacto y las
 * limitaciones conocidas). `isAvailable()` sigue siendo puramente local (solo mira el
 * entorno, nunca hace red):
 * - Sin `OPENROUTER_API_KEY` (u otra de `envKeys`): `complete()` lanza
 *   `ProviderUnavailableError` ("agente de IA no configurado en este entorno").
 * - Con credencial: `complete()` hace el POST real. Un fallo de red/timeout/429/5xx
 *   lanza `ProviderTransientError` (apto para fallback cross-provider); un 4xx
 *   distinto (401/400/404...) lanza `ProviderHttpError` (NO dispara fallback, necesita
 *   revision humana de configuracion) -- nunca se fabrica una respuesta para aparentar
 *   que la llamada funciono.
 */
export class EnvProvider implements LlmProvider {
  readonly id: string;
  private readonly envKeys: readonly string[];
  private readonly env: Record<string, string | undefined>;
  private readonly modelOverride: string | undefined;
  private readonly modelEnvKey: string;
  private readonly modelSlugOverride: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly httpReferer: string | undefined;
  private readonly appTitle: string | undefined;

  constructor(options: EnvProviderOptions = {}) {
    this.id = options.id ?? "env";
    this.envKeys = options.envKeys ?? DEFAULT_ENV_KEYS;
    this.env = options.env ?? process.env;
    this.modelOverride = options.model;
    this.modelEnvKey = options.modelEnvKey ?? DEFAULT_MODEL_ENV_KEY;
    this.modelSlugOverride = options.modelSlugOverride;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.httpReferer = options.httpReferer;
    this.appTitle = options.appTitle;
  }

  private credentialKey(): string | undefined {
    return this.envKeys.find((key) => Boolean(this.env[key] && this.env[key]!.trim().length > 0));
  }

  isAvailable(): boolean {
    return this.credentialKey() !== undefined;
  }

  private resolveOpenRouterModel(params: LlmCompleteParams): string {
    if (this.modelOverride && this.modelOverride.trim().length > 0) return this.modelOverride;
    const fromEnv = this.env[this.modelEnvKey];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
    return mapModelSlugToOpenRouterModel(params.modelSlug);
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompletion> {
    const key = this.credentialKey();
    if (!key) {
      throw new ProviderUnavailableError(
        this.id,
        `agente de IA no configurado en este entorno: falta una de [${this.envKeys.join(", ")}]`,
      );
    }
    const apiKey = this.env[key]!;
    const model = this.resolveOpenRouterModel(params);

    const hasTools = params.toolNames.length > 0;
    const requestBody: Record<string, unknown> = {
      model,
      messages: toOpenAiMessages(params.system, params.messages),
      temperature: params.temperature,
      max_tokens: params.maxOutputTokens,
    };
    if (hasTools) {
      // Ver comentario de archivo ("Limitacion conocida"): `parameters` permisivo
      // porque `LlmCompleteParams.toolNames` no trae el JSON Schema real de la tool.
      requestBody.tools = params.toolNames.map((name) => ({
        type: "function",
        function: {
          name,
          parameters: { type: "object", properties: {}, additionalProperties: true },
        },
      }));
      requestBody.tool_choice = "auto";
      // REQ-AGT-004: mismo parametro que OpenAI Chat Completions documenta
      // (`parallel_tool_calls`), que OpenRouter pasa tal cual a los modelos que lo
      // soportan (openrouter.ai/docs/api-reference/parameters).
      requestBody.parallel_tool_calls = !params.disableParallelToolUse;
    }
    if (params.effort) {
      // Unified Reasoning API de OpenRouter (openrouter.ai/docs/use-cases/reasoning-tokens):
      // `reasoning.effort` en vez de un parametro por-proveedor -- sin verificar contra
      // el servicio real en este entorno (ver OPENROUTER_INTEGRATION_VERIFIED_AGAINST_REAL_API).
      requestBody.reasoning = { effort: params.effort };
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(this.httpReferer ? { "HTTP-Referer": this.httpReferer } : {}),
          ...(this.appTitle ? { "X-Title": this.appTitle } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderTransientError(this.id, `OpenRouter no respondio en ${this.timeoutMs}ms (timeout)`);
      }
      throw new ProviderTransientError(
        this.id,
        `fallo de red hacia OpenRouter: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    let json: OpenRouterCompletionResponse | undefined;
    try {
      json = (await response.json()) as OpenRouterCompletionResponse;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const detail = json?.error?.message ?? `HTTP ${response.status} sin cuerpo de error legible`;
      // Mismo criterio documentado en `ProviderTransientError` (arriba de este
      // archivo): red/5xx/rate-limit son transitorios (aptos para fallback);
      // cualquier otro 4xx (401 credencial invalida, 400 request mal formado, 404
      // modelo inexistente en la cuenta...) NO lo es.
      if (response.status === 429 || response.status >= 500) {
        throw new ProviderTransientError(this.id, `OpenRouter respondio ${response.status}: ${detail}`);
      }
      throw new ProviderHttpError(this.id, response.status, `OpenRouter respondio ${response.status}: ${detail}`);
    }

    if (!json || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new ProviderHttpError(
        this.id,
        response.status,
        "OpenRouter respondio 200 sin 'choices' -- respuesta inesperada, no coincide con el contrato documentado",
      );
    }

    return parseOpenRouterResponse(this.modelSlugOverride ?? params.modelSlug, json);
  }
}
