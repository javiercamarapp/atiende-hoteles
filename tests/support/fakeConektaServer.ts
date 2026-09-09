// H15-007 · Simulador HTTP local (node:http) del contrato REAL de la API de Conekta
// documentado públicamente (https://developers.conekta.com/reference/createorder,
// .../orderrefund) -- mismo patrón que `tests/support/fakeStripeServer.ts`/
// `fakeGoogleOAuth.ts` para poder probar `ConektaAdapter` (fetch real) de extremo a
// extremo sin hablar con `api.conekta.io` y sin credenciales reales.
//
// Contrato que reproduce, con las MISMAS rutas/formas de Conekta real:
//   POST /orders                    -- crear orden (+cargo con card token_id)
//   POST /orders/:id/capture        -- capturar una orden pre-autorizada (pending_payment)
//   POST /orders/:id/refunds        -- reembolsar
// Escenarios de prueba deterministas por `token_id` (mismo espíritu que las "test cards"
// de Conekta), ver `TEST_CARD_TOKENS`.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

export const TEST_CARD_TOKENS = {
  VISA_OK: "tok_test_visa_ok",
  /** Fuerza `payment_status: "declined"` con HTTP 402 (mismo shape que Conekta real). */
  VISA_DECLINED: "tok_test_visa_declined",
  /** El servidor nunca responde -- para el escenario de timeout. */
  VISA_TIMEOUT: "tok_test_visa_timeout",
} as const;

const CONEKTA_ACCEPT_HEADER = "application/vnd.conekta-v2.3.0+json";

interface StoredOrder {
  id: string;
  payment_status: string;
  amount: number;
  currency: string;
  expired: boolean;
}

export interface FakeConektaServer {
  baseUrl: string;
  apiBase: string;
  privateKey: string;
  /** Marca una orden pre-autorizada como vencida -- para probar `PreAuthExpiredError`. */
  expireOrder(id: string): void;
  /** Fuerza que la SIGUIENTE respuesta 2xx tenga un cuerpo no-JSON. */
  corruptNextResponse(): void;
  close(): Promise<void>;
}

export async function startFakeConektaServer(): Promise<FakeConektaServer> {
  const privateKey = `key_test_fake_${randomBytes(8).toString("hex")}`;
  const orders = new Map<string, StoredOrder>();
  let corruptNext = false;
  let sequence = 0;

  async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
    if (corruptNext) {
      corruptNext = false;
      res.writeHead(status, { "content-type": CONEKTA_ACCEPT_HEADER });
      res.end("{ esto no es json valido ");
      return;
    }
    res.writeHead(status, { "content-type": CONEKTA_ACCEPT_HEADER });
    res.end(JSON.stringify(body));
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": CONEKTA_ACCEPT_HEADER });
      res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
    });
  });

  async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${privateKey}`) {
      sendJson(res, 401, { message: "llave privada inválida", type: "authentication_error" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/orders") {
      const raw = await readBody(req);
      const payload = JSON.parse(raw) as {
        currency: string;
        pre_authorize?: boolean;
        charges: Array<{ amount: number; payment_method: { token_id: string } }>;
      };
      const tokenId = payload.charges?.[0]?.payment_method?.token_id ?? "";
      const amount = payload.charges?.[0]?.amount ?? 0;

      if (tokenId === TEST_CARD_TOKENS.VISA_TIMEOUT) {
        return; // nunca responde
      }

      sequence += 1;
      const id = `ord_fake_${sequence}`;
      if (tokenId === TEST_CARD_TOKENS.VISA_DECLINED) {
        sendJson(res, 402, {
          id,
          payment_status: "declined",
          amount,
          currency: payload.currency,
          details: [{ message: "La tarjeta fue rechazada por el banco emisor", code: "card_declined" }],
        });
        return;
      }

      const paymentStatus = payload.pre_authorize ? "pending_payment" : "paid";
      orders.set(id, { id, payment_status: paymentStatus, amount, currency: payload.currency, expired: false });
      sendJson(res, 200, { id, payment_status: paymentStatus, amount, currency: payload.currency });
      return;
    }

    const captureMatch = url.pathname.match(/^\/orders\/([^/]+)\/capture$/);
    if (req.method === "POST" && captureMatch?.[1]) {
      const id = captureMatch[1];
      const order = orders.get(id);
      if (!order) {
        sendJson(res, 404, { message: `No se encontró la orden ${id}`, type: "resource_not_found" });
        return;
      }
      if (order.expired) {
        sendJson(res, 422, { message: "La orden ya expiró y no puede capturarse", type: "processing_error" });
        return;
      }
      order.payment_status = "paid";
      sendJson(res, 200, { id: order.id, payment_status: order.payment_status, amount: order.amount, currency: order.currency });
      return;
    }

    const refundMatch = url.pathname.match(/^\/orders\/([^/]+)\/refunds$/);
    if (req.method === "POST" && refundMatch?.[1]) {
      const id = refundMatch[1];
      const raw = await readBody(req);
      const payload = JSON.parse(raw) as { amount: number };
      const order = orders.get(id);
      if (!order) {
        sendJson(res, 404, { message: `No se encontró la orden ${id}`, type: "resource_not_found" });
        return;
      }
      const fullyRefunded = payload.amount >= order.amount;
      order.payment_status = fullyRefunded ? "refunded" : "partially_refunded";
      sendJson(res, 200, { id: order.id, payment_status: order.payment_status, amount: payload.amount, currency: order.currency });
      return;
    }

    sendJson(res, 404, { message: "not_found", type: "resource_not_found" });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    apiBase: baseUrl,
    privateKey,
    expireOrder(id: string) {
      const order = orders.get(id);
      if (order) order.expired = true;
    },
    corruptNextResponse() {
      corruptNext = true;
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
