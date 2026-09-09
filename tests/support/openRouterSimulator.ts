// fix/llm-openrouter-real: simulador HTTP local FIEL al contrato publico de OpenRouter
// (`POST /api/v1/chat/completions`, formato OpenAI Chat Completions -- ver
// https://openrouter.ai/docs/api-reference/chat-completion) para poder probar de
// verdad el adaptador real de `EnvProvider` (packages/agent-core/src/provider.ts) SIN
// red ni credenciales reales. Mismo patron que `fakeGoogleOAuth.ts` (servidor
// `node:http` real, guion de pasos programable) y que `FakeProvider` (agent-core
// provider.ts) del lado del adaptador. Ver
// `OPENROUTER_INTEGRATION_VERIFIED_AGAINST_REAL_API` en provider.ts: este simulador
// prueba el CONTRATO tal como esta documentado publicamente, nunca sustituye una
// prueba contra el servicio real de openrouter.ai.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";

export type OpenRouterSimStep =
  | {
      readonly kind: "final";
      readonly content: string;
      readonly usage?: { readonly promptTokens?: number; readonly completionTokens?: number };
      readonly finishReason?: string;
    }
  | {
      readonly kind: "tool_calls";
      readonly calls: ReadonlyArray<{ readonly id?: string; readonly name: string; readonly arguments: string }>;
      readonly usage?: { readonly promptTokens?: number; readonly completionTokens?: number };
    }
  | {
      readonly kind: "truncated";
      readonly content?: string | null;
      readonly usage?: { readonly promptTokens?: number; readonly completionTokens?: number };
    }
  /** Respuesta de error HTTP real (401/429/500/...), con el cuerpo
   * `{error:{message,code}}` que OpenRouter documenta. */
  | { readonly kind: "http_error"; readonly status: number; readonly message: string; readonly code?: string }
  /** Nunca responde -- para forzar el timeout/AbortController del lado del cliente. */
  | { readonly kind: "hang" }
  /** Cuerpo crudo arbitrario con status 200 -- para el caso "200 sin choices". */
  | { readonly kind: "raw_200"; readonly body: unknown };

export interface CapturedOpenRouterRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

export interface OpenRouterSimulator {
  readonly baseUrl: string;
  readonly chatCompletionsUrl: string;
  /** Encola el proximo paso a devolver (FIFO); sin pasos encolados, responde un
   * "final" generico. */
  enqueue(step: OpenRouterSimStep): void;
  /** Todas las requests recibidas hasta ahora, en orden -- para verificar la
   * traduccion real del request (headers, mensajes, tools, etc.). */
  readonly requests: CapturedOpenRouterRequest[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export async function startOpenRouterSimulator(): Promise<OpenRouterSimulator> {
  const queue: OpenRouterSimStep[] = [];
  const requests: CapturedOpenRouterRequest[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      writeJson(res, 500, { error: { message: `simulador: fallo interno: ${(err as Error).message}` } });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== "/api/v1/chat/completions") {
      writeJson(res, 404, { error: { message: "ruta no soportada por el simulador" } });
      return;
    }

    const raw = await readBody(req);
    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      writeJson(res, 400, { error: { message: "cuerpo no es JSON valido" } });
      return;
    }
    requests.push({ headers: { ...req.headers }, body: parsedBody });

    const step = queue.shift() ?? { kind: "final" as const, content: "(simulador: sin pasos encolados)" };

    switch (step.kind) {
      case "hang":
        // Deliberadamente nunca responde -- el cliente debe abortar por su propio
        // timeout. La conexion se destruye en close() al terminar la prueba.
        return;
      case "http_error":
        writeJson(res, step.status, { error: { message: step.message, code: step.code } });
        return;
      case "raw_200":
        writeJson(res, 200, step.body);
        return;
      case "final":
        writeJson(res, 200, {
          id: `sim-${randomUUID()}`,
          model: String(parsedBody.model ?? ""),
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: step.content },
              finish_reason: step.finishReason ?? "stop",
            },
          ],
          usage: {
            prompt_tokens: step.usage?.promptTokens ?? 50,
            completion_tokens: step.usage?.completionTokens ?? 20,
          },
        });
        return;
      case "tool_calls":
        writeJson(res, 200, {
          id: `sim-${randomUUID()}`,
          model: String(parsedBody.model ?? ""),
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: step.calls.map((call, i) => ({
                  id: call.id ?? `sim-call-${i}`,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: step.usage?.promptTokens ?? 50,
            completion_tokens: step.usage?.completionTokens ?? 20,
          },
        });
        return;
      case "truncated":
        writeJson(res, 200, {
          id: `sim-${randomUUID()}`,
          model: String(parsedBody.model ?? ""),
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: step.content ?? null },
              finish_reason: "length",
            },
          ],
          usage: {
            prompt_tokens: step.usage?.promptTokens ?? 50,
            completion_tokens: step.usage?.completionTokens ?? 500,
          },
        });
        return;
      default: {
        const exhaustive: never = step;
        throw new Error(`OpenRouterSimStep desconocido: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    chatCompletionsUrl: `${baseUrl}/api/v1/chat/completions`,
    enqueue(step: OpenRouterSimStep) {
      queue.push(step);
    },
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
