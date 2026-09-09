/**
 * Adaptador real contra Stripe (modo MX), H15-007. Llama de verdad a la API pública de
 * PaymentIntents documentada en https://docs.stripe.com/api/payment_intents (fetch
 * nativo, sin SDK, mismo criterio que `packages/email/src/adapters/resendAdapter.ts`):
 * autenticación `Authorization: Bearer <STRIPE_SECRET_KEY>` (Stripe documenta Basic Auth
 * como forma primaria y Bearer como alternativa explícita para llamadas server-to-server,
 * ver https://docs.stripe.com/api/authentication), `Idempotency-Key` por request (Stripe
 * SÍ documenta esta cabecera), reintentos con backoff ante `429`, y verificación HMAC de
 * `Stripe-Signature` (formato `t=<ts>,v1=<hex>` sobre `<ts>.<body>`). Sin credenciales, se
 * declara `unavailable` y NINGÚN método llama a la red real.
 *
 * *** [PENDIENTE DE VERIFICACIÓN CONTRA EL PROVEEDOR REAL] ***
 * `verificadoContraReal = false` (ver export a nivel de módulo y propiedad de instancia):
 * este código hace llamadas HTTP reales cuando hay credenciales, y se probó de extremo a
 * extremo contra `tests/support/fakeStripeServer.ts` -- un simulador HTTP local (node:http)
 * que imita el MISMO contrato de PaymentIntents/Refunds documentado arriba (creación +
 * confirmación, captura, reembolso, tarjeta rechazada con HTTP 402, timeout, respuesta
 * malformada) -- pero jamás se ha ejecutado ni una sola llamada contra `api.stripe.com`
 * con una cuenta real en esta sesión (sin credenciales de sandbox disponibles en este
 * entorno). NUNCA asumas que "probablemente funciona" contra Stripe real a partir de este
 * comentario: es una suposición no verificada hasta que alguien corra la prueba real (ver
 * "Credenciales necesarias para la primera prueba real" en README.md de este paquete).
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`.
 */
import {
  PortUnavailableError,
  PortRateLimitError,
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryReplayGuard,
  retryWithBackoff,
  verifyHmacSignature,
  checkEnvCredentials,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  PreAuthExpiredError,
  mapStripeStatusToDomain,
  type PaymentProviderPort,
  type ChargeInput,
  type PreAuthorizeInput,
  type PaymentResult,
  type RefundInput,
  type PaymentWebhookEvent,
  type DomainPaymentStatus,
  type StripePaymentIntentStatus,
} from "../port.ts";

const REQUIRED_ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;
export const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Rutas reales, parametrizadas por `apiBase` para que las pruebas de contrato puedan
 *  apuntar al simulador local (`tests/support/fakeStripeServer.ts`) sin tocar ninguna
 *  lógica de negocio -- en producción `apiBase` es siempre `STRIPE_API_BASE`. */
export function stripeRoutes(apiBase: string) {
  return {
    paymentIntents: `${apiBase}/payment_intents`,
    refunds: `${apiBase}/refunds`,
  };
}
export const STRIPE_ROUTES = stripeRoutes(STRIPE_API_BASE);

/** Reconstruye el payload firmado que Stripe realmente firma: `${timestamp}.${rawBody}`. */
export function stripeSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** `false`, siempre -- ver cabecera de este archivo. Constante a nivel de módulo (además
 *  de la propiedad de instancia `verificadoContraReal`) para que sea localizable con un
 *  simple grep/import sin instanciar la clase. */
export const STRIPE_VERIFICADO_CONTRA_REAL = false as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Stripe cobra en la unidad mínima de la moneda (centavos para MXN/USD, monedas de 2
 *  decimales -- ver https://docs.stripe.com/currencies#zero-decimal). Este repo solo
 *  opera monedas de 2 decimales (MXN/USD); una moneda "zero-decimal" (JPY, etc.) rompería
 *  esta conversión y está fuera de alcance de H15-007. */
export function toStripeMinorUnits(amountMajorUnits: number): number {
  return Math.round(amountMajorUnits * 100);
}
function fromStripeMinorUnits(amountMinorUnits: number): number {
  return amountMinorUnits / 100;
}

interface StripePaymentIntentResponse {
  id: string;
  status: StripePaymentIntentStatus;
  amount: number;
  currency: string;
}
interface StripeRefundResponse {
  id: string;
  status: "succeeded" | "pending" | "failed" | "canceled";
  amount: number;
  currency: string;
}
interface StripeErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
    payment_intent?: { id?: string; status?: string };
  };
}

/** HTTP no-2xx de Stripe, con el cuerpo ya parseado (o crudo si no era JSON) para que el
 *  llamador decida cómo mapearlo -- nunca se descarta la razón exacta que Stripe dio. */
class StripeHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`stripe: HTTP ${status}`);
    this.name = "StripeHttpError";
  }
}

export interface StripeAdapterConfig {
  /** Override de `STRIPE_API_BASE` -- SOLO para pruebas de contrato contra
   *  `tests/support/fakeStripeServer.ts`. En producción se ignora si no se pasa. */
  apiBase?: string;
  /** Timeout por request en ms (default 10s) -- override en pruebas para ejercitar el
   *  escenario de timeout sin esperar 10s de verdad. */
  requestTimeoutMs?: number;
}

export class StripeAdapter implements PaymentProviderPort {
  readonly verificadoContraReal = false as const;
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly replayGuard = new InMemoryReplayGuard();
  private readonly apiBase: string;
  private readonly requestTimeoutMs: number;
  private readonly routes: ReturnType<typeof stripeRoutes>;

  constructor(config: StripeAdapterConfig = {}) {
    this.apiBase = config.apiBase ?? STRIPE_API_BASE;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.routes = stripeRoutes(this.apiBase);
  }

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "stripe", available: true, simulated: false };
    return {
      provider: "stripe",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError("stripe", `faltan variables de entorno: ${this.credentials.missing.join(", ")}`);
    }
  }

  /** Ejecuta una llamada real, con reintentos ante 429 (backoff+jitter) y timeout por
   *  intento. Nunca traga un cuerpo no-2xx: lo relanza como `StripeHttpError` con el
   *  cuerpo (parseado si era JSON) para que el llamador decida (p.ej. tarjeta rechazada
   *  vs. error inesperado). Una respuesta 2xx que no es JSON válido falla explícito --
   *  nunca se finge un resultado a partir de un cuerpo ilegible. */
  private async request<T>(url: string, init: RequestInit): Promise<T> {
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, {
          ...init,
          headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...init.headers },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        const rawBody = await response.text();
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          throw new PortRateLimitError("stripe", retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined);
        }
        if (!response.ok) {
          let parsedBody: unknown = rawBody;
          try {
            parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
          } catch {
            // cuerpo de error no-JSON -- se relanza crudo, nunca se fabrica un shape falso.
          }
          throw new StripeHttpError(response.status, parsedBody);
        }
        try {
          return JSON.parse(rawBody) as T;
        } catch {
          throw new Error(
            `stripe: respuesta HTTP ${response.status} no es JSON válido: ${rawBody.slice(0, 200)}`,
          );
        }
      },
      {
        maxAttempts: 4,
        isRetryable: (error) => error instanceof PortRateLimitError,
        retryAfterMs: (error) => (error instanceof PortRateLimitError ? error.retryAfterMs : undefined),
      },
    );
  }

  private toResult(
    json: StripePaymentIntentResponse,
    idempotencyKey: string,
    preAuthExpiresAt?: string,
  ): PaymentResult {
    const status = mapStripeStatusToDomain(json.status);
    const result: PaymentResult = {
      externalPaymentId: json.id,
      status,
      amount: fromStripeMinorUnits(json.amount),
      currency: json.currency.toUpperCase(),
      idempotencyKey,
    };
    if (status === "autorizado" && preAuthExpiresAt) result.preAuthExpiresAt = preAuthExpiresAt;
    return result;
  }

  /** Una tarjeta rechazada en `confirm=true` responde HTTP 402 con el PaymentIntent
   *  fallido embebido en `error.payment_intent` (documentado por Stripe) -- eso SÍ es un
   *  resultado de dominio válido (`status: "fallido"`), no un error de sistema: el pago
   *  se intentó de verdad y el proveedor lo rechazó. Cualquier otro no-2xx (401/400/500/
   *  cuerpo sin `payment_intent`) es un estado inesperado y se relanza tal cual -- nunca
   *  se disfraza de "fallido" un error que en realidad es "no sabemos qué pasó". */
  private declinedResultOrRethrow(err: unknown, amount: number, currency: string, idempotencyKey: string): PaymentResult {
    if (err instanceof StripeHttpError && err.status === 402) {
      const body = err.body as StripeErrorBody;
      const pi = body?.error?.payment_intent;
      if (pi?.id) {
        return { externalPaymentId: pi.id, status: "fallido", amount, currency, idempotencyKey };
      }
    }
    throw err;
  }

  async charge(input: ChargeInput): Promise<PaymentResult> {
    this.assertAvailable();
    const body = new URLSearchParams({
      amount: String(toStripeMinorUnits(input.amount)),
      currency: input.currency.toLowerCase(),
      payment_method: input.paymentMethodToken,
      confirm: "true",
      off_session: "true",
      capture_method: "automatic",
      error_on_requires_action: "true",
    });
    body.append("payment_method_types[]", "card");
    try {
      const json = await this.request<StripePaymentIntentResponse>(this.routes.paymentIntents, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": input.idempotencyKey },
        body: body.toString(),
      });
      return this.toResult(json, input.idempotencyKey);
    } catch (err) {
      return this.declinedResultOrRethrow(err, input.amount, input.currency, input.idempotencyKey);
    }
  }

  async preAuthorize(input: PreAuthorizeInput): Promise<PaymentResult> {
    this.assertAvailable();
    const body = new URLSearchParams({
      amount: String(toStripeMinorUnits(input.amount)),
      currency: input.currency.toLowerCase(),
      payment_method: input.paymentMethodToken,
      confirm: "true",
      off_session: "true",
      capture_method: "manual",
      error_on_requires_action: "true",
    });
    body.append("payment_method_types[]", "card");
    // Stripe no expone la ventana de "capturar antes de N" que nosotros pedimos
    // (`holdMinutes`) -- su propia política interna cancela PaymentIntents no capturados
    // (7 días por defecto, ver docs/api/payment_intents/capture). `preAuthExpiresAt` es
    // NUESTRO seguimiento de dominio (mismo cálculo que `FakeStripeAdapter`, para que
    // `purgePaymentPreauthScheduler`/REQ-H15 se comporten IGUAL sin importar el proveedor,
    // exactamente lo que REQ-INT-002 exige) -- `capturePreAuth` igual verifica el estado
    // REAL que Stripe reporte, nunca confía solo en este reloj local.
    const preAuthExpiresAt = new Date(Date.now() + input.holdMinutes * 60_000).toISOString();
    try {
      const json = await this.request<StripePaymentIntentResponse>(this.routes.paymentIntents, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": input.idempotencyKey },
        body: body.toString(),
      });
      return this.toResult(json, input.idempotencyKey, preAuthExpiresAt);
    } catch (err) {
      return this.declinedResultOrRethrow(err, input.amount, input.currency, input.idempotencyKey);
    }
  }

  async capturePreAuth(externalPaymentId: string, idempotencyKey: string): Promise<PaymentResult> {
    this.assertAvailable();
    try {
      const json = await this.request<StripePaymentIntentResponse>(
        `${this.routes.paymentIntents}/${externalPaymentId}/capture`,
        { method: "POST", headers: { "Idempotency-Key": idempotencyKey } },
      );
      return this.toResult(json, idempotencyKey);
    } catch (err) {
      if (err instanceof StripeHttpError) {
        const body = err.body as StripeErrorBody;
        const message = body?.error?.message ?? "";
        // Un PaymentIntent no capturado a tiempo pasa a `status: "canceled"` (mensaje de
        // Stripe menciona "canceled"/"already been canceled") -- eso ES nuestra
        // `PreAuthExpiredError`, nunca se captura silenciosamente algo que ya venció.
        if (/cancel/i.test(message) || body?.error?.payment_intent?.status === "canceled") {
          throw new PreAuthExpiredError(externalPaymentId);
        }
      }
      throw err;
    }
  }

  async refund(input: RefundInput): Promise<PaymentResult> {
    this.assertAvailable();
    const body = new URLSearchParams({
      payment_intent: input.externalPaymentId,
      amount: String(toStripeMinorUnits(input.amount)),
    });
    const json = await this.request<StripeRefundResponse>(this.routes.refunds, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": input.idempotencyKey },
      body: body.toString(),
    });
    const status: DomainPaymentStatus =
      json.status === "succeeded" ? "reembolsado" : json.status === "failed" || json.status === "canceled" ? "fallido" : "pendiente";
    return {
      externalPaymentId: json.id,
      status,
      amount: fromStripeMinorUnits(json.amount),
      currency: json.currency.toUpperCase(),
      idempotencyKey: input.idempotencyKey,
    };
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<PaymentWebhookEvent> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new PortUnavailableError("stripe", "falta STRIPE_WEBHOOK_SECRET para verificar webhooks");
    // Formato real: `Stripe-Signature: t=<ts>,v1=<hex>`. Se extrae ts/v1 y se recalcula
    // sobre `stripeSignedPayload(ts, rawBody)`.
    const parts = Object.fromEntries(
      (signatureHeader ?? "").split(",").map((kv) => kv.split("=") as [string, string]),
    );
    const timestamp = parts.t;
    const v1 = parts.v1;
    if (!timestamp || !v1 || !verifyHmacSignature(stripeSignedPayload(timestamp, rawBody), v1, secret, { prefix: "" })) {
      throw new WebhookSignatureError("stripe");
    }
    const payload = JSON.parse(rawBody) as { id?: string };
    const eventId = payload.id;
    if (!eventId) throw new WebhookSignatureError("stripe");
    if (this.replayGuard.seenBefore(eventId)) throw new WebhookReplayError("stripe", eventId);
    throw new PortUnavailableError("stripe", "normalización completa del payload real pendiente de credenciales");
  }
}
