// H18 · conector-pms-enterprise: simulador HTTP local (node:http) del lado RECEPTOR de
// `WebhookOutboundAdapter` -- mismo patrón que `tests/support/fakeGoogleOAuth.ts`/
// `fakeStripeServer.ts` (servidor real en 127.0.0.1, puerto aleatorio, sin red externa),
// pero al revés de esos: aquí NOSOTROS somos el cliente que llama, este servidor juega
// el rol del sistema enterprise del hotel (HotSOS/Optii-style) que RECIBE el webhook y
// verifica su firma HMAC saliente, exactamente como se documenta en
// `packages/mcp-servers/outbound/src/adapters/webhook-outbound-adapter.ts`.
//
// "Genérico" (ver comentario de cabecera de ese adaptador) significa que no hay un
// contrato público de un proveedor real que reproducir aquí -- este servidor implementa
// el contrato MÍNIMO que cualquier receptor de este conector necesita cumplir: verificar
// `X-Atiende-Signature` con el secreto compartido, responder 2xx si es válida, 401 si no,
// y reproducir los escenarios de prueba controlados (429 con Retry-After, 500, timeout,
// respuesta con id externo) que la suite de contrato ejercita.
import { createServer, type Server } from "node:http";
import {
  OUTBOUND_EVENT_ID_HEADER,
  OUTBOUND_SIGNATURE_HEADER,
  OUTBOUND_TASK_TYPE_HEADER,
} from "@atiende-hoteles/mcp-outbound";
import { verifyHmacSignature } from "@atiende-hoteles/mcp-shared";

export interface ReceivedOutboundCall {
  rawBody: string;
  signature: string | undefined;
  eventId: string | undefined;
  taskType: string | undefined;
}

export interface FakeOutboundTargetServer {
  baseUrl: string;
  webhookUrl: string;
  secret: string;
  received: ReceivedOutboundCall[];
  /** Fuerza que las próximas `times` peticiones respondan 429 con `Retry-After`
   *  (segundos, usar 0 para no ralentizar la prueba real) -- escenario de reintento con
   *  backoff. Después de agotar `times`, vuelve a responder 200 normal. */
  force429(retryAfterSeconds: number, times?: number): void;
  /** Fuerza que la SIGUIENTE petición responda 500 (no-2xx que NUNCA se reintenta). */
  force500(): void;
  /** Fuerza que la SIGUIENTE petición nunca responda (para el escenario de timeout). */
  forceHang(): void;
  /** Limpia cualquier `force*` pendiente -- llamar en `afterEach` para que una prueba
   *  que agotó reintentos (p.ej. 429 sostenido) no deje estado a medias para la
   *  siguiente. */
  resetForcedResponses(): void;
  close(): Promise<void>;
}

export async function startFakeOutboundTargetServer(): Promise<FakeOutboundTargetServer> {
  const secret = "secreto-compartido-de-prueba-1234567890";
  const received: ReceivedOutboundCall[] = [];
  let nextResponse: "ok" | "429" | "500" | "hang" = "ok";
  let retryAfter = 1;
  let remaining429 = 0;

  async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const rawBody = await readBody(req);
      const signature = req.headers[OUTBOUND_SIGNATURE_HEADER.toLowerCase()] as string | undefined;
      const eventId = req.headers[OUTBOUND_EVENT_ID_HEADER.toLowerCase()] as string | undefined;
      const taskType = req.headers[OUTBOUND_TASK_TYPE_HEADER.toLowerCase()] as string | undefined;
      received.push({ rawBody, signature, eventId, taskType });

      let responseKind = nextResponse;
      nextResponse = "ok";
      if (responseKind === "ok" && remaining429 > 0) responseKind = "429";

      if (responseKind === "hang") return; // nunca responde -- el cliente debe abortar por timeout.

      if (!verifyHmacSignature(rawBody, signature, secret)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "firma inválida" }));
        return;
      }

      if (responseKind === "429") {
        if (remaining429 > 0) remaining429 -= 1;
        res.writeHead(429, { "content-type": "application/json", "Retry-After": String(retryAfter) });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      if (responseKind === "500") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "error interno del sistema del hotel" }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `HOTELSYS-${received.length}` }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    webhookUrl: `${baseUrl}/webhook`,
    secret,
    received,
    force429(retryAfterSeconds: number, times = 1) {
      nextResponse = "429";
      retryAfter = retryAfterSeconds;
      remaining429 = times;
    },
    force500() {
      nextResponse = "500";
    },
    forceHang() {
      nextResponse = "hang";
    },
    resetForcedResponses() {
      nextResponse = "ok";
      remaining429 = 0;
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
