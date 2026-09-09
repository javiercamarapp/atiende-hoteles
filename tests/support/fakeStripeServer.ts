// H15-007 · Simulador HTTP local (node:http) del contrato REAL de la API de Stripe
// documentado públicamente (https://docs.stripe.com/api/payment_intents,
// https://docs.stripe.com/api/refunds) -- mismo patrón que
// `tests/support/fakeGoogleOAuth.ts` (servidor real en 127.0.0.1, puerto aleatorio, sin
// red externa) para poder probar `StripeAdapter` (fetch real) de extremo a extremo SIN
// hablar con `api.stripe.com` y sin credenciales reales.
//
// Contrato que reproduce, con las MISMAS rutas/formas de Stripe real:
//   POST /v1/payment_intents                     -- crear (+confirmar si confirm=true)
//   POST /v1/payment_intents/:id/capture          -- capturar una pre-auth vigente
//   POST /v1/refunds                              -- reembolsar
// Escenarios de prueba controlados por el `payment_method` que el cliente envía
// (`setTestScenario`/token mágico), documentados en `TEST_CARD_TOKENS` abajo -- MISMA
// convención que Stripe real usa con sus "test cards" (tokens especiales que fuerzan un
// resultado), para que las pruebas de contrato no dependan de estado oculto del servidor.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";

/** Tokens especiales (mismo espíritu que las "test cards" reales de Stripe) que fuerzan
 *  un resultado determinista, sin depender de estado oculto entre requests. */
export const TEST_CARD_TOKENS = {
  /** Confirma con éxito inmediato (`succeeded` / `requires_capture` según capture_method). */
  VISA_OK: "pm_test_visa_ok",
  /** Fuerza HTTP 402 "card_declined", con el PaymentIntent fallido embebido (igual que Stripe real). */
  VISA_DECLINED: "pm_test_visa_declined",
  /** El servidor tarda más que cualquier timeout razonable de prueba -- para el escenario de timeout. */
  VISA_TIMEOUT: "pm_test_visa_timeout",
} as const;

interface StoredIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  captured: boolean;
  canceled: boolean;
}

export interface FakeStripeServer {
  baseUrl: string;
  apiBase: string;
  secretKey: string;
  /** Marca un PaymentIntent (por id) como ya cancelado por el propio Stripe -- simula el
   *  auto-cancel de una pre-auth vencida (7 días) para probar `PreAuthExpiredError`. */
  expireIntent(id: string): void;
  /** Fuerza que la SIGUIENTE respuesta 2xx tenga un cuerpo no-JSON (bytes crudos) --
   *  escenario "respuesta malformada". */
  corruptNextResponse(): void;
  close(): Promise<void>;
}

export async function startFakeStripeServer(): Promise<FakeStripeServer> {
  const secretKey = `sk_test_fake_${randomBytes(8).toString("hex")}`;
  const intents = new Map<string, StoredIntent>();
  const idempotencyResponses = new Map<string, unknown>();
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
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{ esto no es json valido ");
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
    });
  });

  async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${secretKey}`) {
      sendJson(res, 401, { error: { type: "authentication_error", message: "clave inválida" } });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/payment_intents") {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const idempotencyKey = req.headers["idempotency-key"];
      if (typeof idempotencyKey === "string" && idempotencyResponses.has(idempotencyKey)) {
        sendJson(res, 200, idempotencyResponses.get(idempotencyKey));
        return;
      }
      const paymentMethod = params.get("payment_method") ?? "";
      const amount = Number(params.get("amount") ?? "0");
      const currency = params.get("currency") ?? "mxn";
      const captureMethod = params.get("capture_method") ?? "automatic";

      if (paymentMethod === TEST_CARD_TOKENS.VISA_TIMEOUT) {
        // Nunca responde -- el cliente debe cortar por su propio timeout (AbortSignal).
        return;
      }

      sequence += 1;
      const id = `pi_fake_${sequence}`;
      if (paymentMethod === TEST_CARD_TOKENS.VISA_DECLINED) {
        const body = {
          error: {
            type: "card_error",
            code: "card_declined",
            decline_code: "generic_decline",
            message: "Your card was declined.",
            payment_intent: { id, status: "requires_payment_method" },
          },
        };
        if (typeof idempotencyKey === "string") idempotencyResponses.set(idempotencyKey, body);
        sendJson(res, 402, body);
        return;
      }

      const status = captureMethod === "manual" ? "requires_capture" : "succeeded";
      const intent: StoredIntent = { id, status, amount, currency, captured: status === "succeeded", canceled: false };
      intents.set(id, intent);
      const body = { id, object: "payment_intent", status, amount, currency };
      if (typeof idempotencyKey === "string") idempotencyResponses.set(idempotencyKey, body);
      sendJson(res, 200, body);
      return;
    }

    const captureMatch = url.pathname.match(/^\/v1\/payment_intents\/([^/]+)\/capture$/);
    if (req.method === "POST" && captureMatch?.[1]) {
      const id = captureMatch[1];
      const intent = intents.get(id);
      if (!intent) {
        sendJson(res, 404, { error: { type: "invalid_request_error", message: `No such payment_intent: '${id}'` } });
        return;
      }
      if (intent.canceled) {
        sendJson(res, 400, {
          error: {
            type: "invalid_request_error",
            message: `This PaymentIntent could not be captured because it has already been canceled.`,
            payment_intent: { id, status: "canceled" },
          },
        });
        return;
      }
      intent.status = "succeeded";
      intent.captured = true;
      sendJson(res, 200, { id, object: "payment_intent", status: intent.status, amount: intent.amount, currency: intent.currency });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/refunds") {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      const paymentIntentId = params.get("payment_intent") ?? "";
      const amount = Number(params.get("amount") ?? "0");
      const intent = intents.get(paymentIntentId);
      sequence += 1;
      const id = `re_fake_${sequence}`;
      sendJson(res, 200, { id, object: "refund", status: "succeeded", amount, currency: intent?.currency ?? "mxn", payment_intent: paymentIntentId });
      return;
    }

    sendJson(res, 404, { error: { type: "invalid_request_error", message: "not_found" } });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    apiBase: `${baseUrl}/v1`,
    secretKey,
    expireIntent(id: string) {
      const intent = intents.get(id);
      if (intent) intent.canceled = true;
    },
    corruptNextResponse() {
      corruptNext = true;
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
