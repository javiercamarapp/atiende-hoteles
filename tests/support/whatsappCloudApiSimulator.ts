// Simulador HTTP local del contrato REAL de "Send Messages" de WhatsApp Cloud API
// (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages), para
// ejercitar `MetaWhatsappAdapter` (packages/mcp-servers/whatsapp) contra un servidor
// `node:http` de verdad -- MISMO espíritu que `tests/support/fakeGoogleOAuth.ts`: nunca
// mockear `fetch`, siempre un servidor real escuchando en loopback, así la prueba
// verifica el request HTTP completo (método, headers, body) que el adaptador construye,
// no solo lo que el código *cree* que envía.
//
// `MetaWhatsappAdapter` apunta aquí en pruebas vía `WHATSAPP_GRAPH_BASE_URL_OVERRIDE`
// (ver comentario de esa constante en meta-whatsapp-adapter.ts) -- nunca en producción.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface WhatsappCloudApiSimulator {
  baseUrl: string;
  accessToken: string;
  phoneNumberId: string;
  /** Cada body JSON exacto que el adaptador mandó a `POST /{phone-number-id}/messages`
   *  -- para que la prueba pueda afirmar la forma exacta del contrato (plantilla, texto,
   *  botones interactivos), sin mockear el request. */
  readonly sentMessages: unknown[];
  /** Fuerza que la PRÓXIMA petición de envío responda 429 con `Retry-After` (segundos),
   *  para probar el backoff real de `retryWithBackoff` contra un 429 real de HTTP. */
  failNextWithRateLimit(retryAfterSeconds: number): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startWhatsappCloudApiSimulator(): Promise<WhatsappCloudApiSimulator> {
  const accessToken = "test-meta-access-token";
  const phoneNumberId = "1234567890";
  const sentMessages: unknown[] = [];
  let sequence = 0;
  let rateLimitOnceSeconds: number | undefined;

  const messagesPath = `/v21.0/${phoneNumberId}/messages`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === messagesPath) {
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${accessToken}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }));
        return;
      }

      if (rateLimitOnceSeconds !== undefined) {
        const retryAfter = rateLimitOnceSeconds;
        rateLimitOnceSeconds = undefined;
        res.writeHead(429, { "content-type": "application/json", "Retry-After": String(retryAfter) });
        res.end(JSON.stringify({ error: { message: "(#4) Application request limit reached", type: "OAuthException", code: 4 } }));
        return;
      }

      const raw = await readBody(req);
      let body: { messaging_product?: string; to?: string; type?: string };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON.", type: "GraphMethodException", code: 100 } }));
        return;
      }
      // Verificación mínima del contrato REAL de Graph API: `messaging_product` es
      // OBLIGATORIO y siempre "whatsapp" en cada request de envío -- un adaptador que lo
      // omita recibiría un 400 real de Meta, así que el simulador lo exige igual.
      if (body.messaging_product !== "whatsapp" || typeof body.to !== "string" || !body.type) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "Missing messaging_product/to/type -- no coincide con el contrato de Graph API.", type: "GraphMethodException", code: 100 },
          }),
        );
        return;
      }

      sentMessages.push(body);
      sequence += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: body.to, wa_id: body.to.replace(/^\+/, "") }],
          messages: [{ id: `wamid.SIMULADO${sequence}` }],
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Unsupported request.", type: "GraphMethodException", code: 100 } }));
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    accessToken,
    phoneNumberId,
    sentMessages,
    failNextWithRateLimit(retryAfterSeconds: number) {
      rateLimitOnceSeconds = retryAfterSeconds;
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
