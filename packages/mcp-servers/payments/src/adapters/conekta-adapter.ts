/**
 * Adaptador real contra Conekta (segundo proveedor de pago, H15-007) -- existe
 * precisamente para probar REQ-INT-002: "cambiar de proveedor no requiere tocar la
 * lógica de negocio". Llama de verdad a la API pública de Orders documentada en
 * https://developers.conekta.com/reference/createorder (fetch nativo, sin SDK):
 * autenticación `Authorization: Bearer <CONEKTA_PRIVATE_KEY>` (Conekta documenta Bearer
 * explícitamente, ver https://developers.conekta.com/reference/autenticación), cabecera
 * de versión `Accept: application/vnd.conekta-v2.3.0+json`, reintentos con backoff ante
 * `429`. Sin credenciales, se declara `unavailable` y NINGÚN método llama a la red real.
 *
 * *** [PENDIENTE DE VERIFICACIÓN CONTRA EL PROVEEDOR REAL] ***
 * `verificadoContraReal = false` (ver export a nivel de módulo y propiedad de instancia):
 * este código hace llamadas HTTP reales cuando hay credenciales, y se probó de extremo a
 * extremo contra `tests/support/fakeConektaServer.ts` -- un simulador HTTP local
 * (node:http) que imita el MISMO contrato de Orders documentado arriba (creación con
 * `pre_authorize`, captura, reembolso, tarjeta rechazada, timeout, respuesta malformada)
 * -- pero jamás se ha ejecutado ni una sola llamada contra `api.conekta.io` con una cuenta
 * real en esta sesión (sin credenciales de sandbox disponibles en este entorno). NUNCA
 * asumas que "probablemente funciona" contra Conekta real a partir de este comentario: es
 * una suposición no verificada hasta que alguien corra la prueba real (ver "Credenciales
 * necesarias para la primera prueba real" en README.md de este paquete).
 *
 * Dos huecos DOCUMENTADOS del contrato actual (`ChargeInput`/`PreAuthorizeInput`, ver
 * `port.ts`) frente a lo que Conekta exige, deliberados y explícitos (nunca ocultos):
 * 1. `customer_info` (nombre+correo) es OBLIGATORIO en `POST /orders` y el puerto no lo
 *    expone -- se envía un valor de reserva explícito (`CONEKTA_CUSTOMER_INFO_PLACEHOLDER`)
 *    hasta que se extienda el contrato para llevar datos reales del huésped.
 * 2. `line_items` (al menos un producto) también es obligatorio -- se sintetiza un único
 *    line item genérico ("Cargo de hotel") con el monto pedido, nunca se inventa un
 *    desglose que el llamador no pidió.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `CONEKTA_PRIVATE_KEY` y `CONEKTA_WEBHOOK_SECRET`.
 */
import {
  PortUnavailableError,
  PortRateLimitError,
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryReplayGuard,
  InMemoryIdempotencyStore,
  withIdempotency,
  retryWithBackoff,
  verifyHmacSignature,
  checkEnvCredentials,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  PreAuthExpiredError,
  mapConektaStatusToDomain,
  type PaymentProviderPort,
  type ChargeInput,
  type PreAuthorizeInput,
  type PaymentResult,
  type RefundInput,
  type PaymentWebhookEvent,
  type ConektaOrderStatus,
} from "../port.ts";

const REQUIRED_ENV = ["CONEKTA_PRIVATE_KEY", "CONEKTA_WEBHOOK_SECRET"] as const;
export const CONEKTA_API_BASE = "https://api.conekta.io";
export const CONEKTA_API_VERSION = "2.3.0";
export const CONEKTA_ACCEPT_HEADER = `application/vnd.conekta-v${CONEKTA_API_VERSION}+json`;

/** Rutas reales, parametrizadas por `apiBase` para que las pruebas de contrato apunten al
 *  simulador local (`tests/support/fakeConektaServer.ts`) sin tocar lógica de negocio. */
export function conektaRoutes(apiBase: string) {
  return { orders: `${apiBase}/orders` };
}
export const CONEKTA_ROUTES = conektaRoutes(CONEKTA_API_BASE);

/** `false`, siempre -- ver cabecera de este archivo. Constante a nivel de módulo (además
 *  de la propiedad de instancia `verificadoContraReal`) para localizarlo con un grep. */
export const CONEKTA_VERIFICADO_CONTRA_REAL = false as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Ver hueco documentado (1) en la cabecera del archivo. */
export const CONEKTA_CUSTOMER_INFO_PLACEHOLDER = {
  name: "Huésped Atiende Hoteles (dato no expuesto por PaymentProviderPort)",
  email: "pagos-sin-datos-de-huesped@atiende-hoteles.invalid",
} as const;

/** Conekta cobra en centavos (documentado como "Amount to be charged in cents" en
 *  Create Charge) -- misma convención que Stripe. Solo monedas de 2 decimales. */
export function toConektaMinorUnits(amountMajorUnits: number): number {
  return Math.round(amountMajorUnits * 100);
}
function fromConektaMinorUnits(amountMinorUnits: number): number {
  return amountMinorUnits / 100;
}

interface ConektaOrderResponse {
  id: string;
  payment_status: ConektaOrderStatus;
  amount: number;
  currency: string;
}
interface ConektaErrorBody {
  details?: Array<{ message?: string; code?: string }>;
  message?: string;
  type?: string;
}

/** HTTP no-2xx de Conekta, con el cuerpo ya parseado (o crudo) para que el llamador
 *  decida cómo mapearlo -- nunca se descarta la razón exacta que Conekta dio. */
class ConektaHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`conekta: HTTP ${status}`);
    this.name = "ConektaHttpError";
  }
}

export interface ConektaAdapterConfig {
  /** Override de `CONEKTA_API_BASE` -- SOLO para pruebas de contrato contra
   *  `tests/support/fakeConektaServer.ts`. */
  apiBase?: string;
  /** Timeout por request en ms (default 10s) -- override en pruebas. */
  requestTimeoutMs?: number;
}

export class ConektaAdapter implements PaymentProviderPort {
  readonly verificadoContraReal = false as const;
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly replayGuard = new InMemoryReplayGuard();
  private readonly apiBase: string;
  private readonly requestTimeoutMs: number;
  private readonly routes: ReturnType<typeof conektaRoutes>;
  // Salvaguarda de idempotencia LOCAL (en memoria, por instancia/proceso) -- a
  // diferencia de Stripe, la documentación pública de Conekta (ver cabecera del
  // archivo) NO expone una cabecera de idempotencia soportada por el proveedor. Esto
  // evita doble-cobro dentro del MISMO proceso pero NO es una garantía del lado de
  // Conekta: dos procesos distintos (o un reinicio) con la misma `idempotencyKey`
  // SÍ podrían crear dos órdenes reales. Documentado en README.md como limitación
  // conocida, no oculta.
  private readonly idempotency = new InMemoryIdempotencyStore<PaymentResult>();

  constructor(config: ConektaAdapterConfig = {}) {
    this.apiBase = config.apiBase ?? CONEKTA_API_BASE;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.routes = conektaRoutes(this.apiBase);
  }

  status(): AdapterStatus {
    if (this.credentials.available) return { provider: "conekta", available: true, simulated: false };
    return {
      provider: "conekta",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError("conekta", `faltan variables de entorno: ${this.credentials.missing.join(", ")}`);
    }
  }

  /** Ejecuta una llamada real, con reintentos ante 429 y timeout por intento. Nunca traga
   *  un cuerpo no-2xx: lo relanza como `ConektaHttpError` con el cuerpo (parseado si era
   *  JSON). Una respuesta 2xx que no es JSON válido falla explícito. */
  private async request<T>(url: string, init: RequestInit): Promise<T> {
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${process.env.CONEKTA_PRIVATE_KEY}`,
            Accept: CONEKTA_ACCEPT_HEADER,
            "Accept-Language": "es",
            ...init.headers,
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        const rawBody = await response.text();
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          throw new PortRateLimitError("conekta", retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined);
        }
        if (!response.ok) {
          let parsedBody: unknown = rawBody;
          try {
            parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
          } catch {
            // cuerpo de error no-JSON -- se relanza crudo.
          }
          throw new ConektaHttpError(response.status, parsedBody);
        }
        try {
          return JSON.parse(rawBody) as T;
        } catch {
          throw new Error(
            `conekta: respuesta HTTP ${response.status} no es JSON válido: ${rawBody.slice(0, 200)}`,
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

  private async createOrder(input: ChargeInput, preAuthorize: boolean): Promise<ConektaOrderResponse> {
    const amountMinor = toConektaMinorUnits(input.amount);
    const body = {
      currency: input.currency,
      customer_info: CONEKTA_CUSTOMER_INFO_PLACEHOLDER,
      line_items: [{ name: "Cargo de hotel", unit_price: amountMinor, quantity: 1 }],
      charges: [{ amount: amountMinor, payment_method: { type: "card", token_id: input.paymentMethodToken } }],
      pre_authorize: preAuthorize,
    };
    try {
      return await this.request<ConektaOrderResponse>(this.routes.orders, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Tarjeta rechazada: Conekta responde con la orden ya creada en estado
      // `payment_status: "declined"` (HTTP 402, documentado en createorder.md) -- eso es
      // un resultado de dominio válido, no un error de sistema. Cualquier otro no-2xx sin
      // un `id` de orden en el cuerpo es un estado inesperado y se relanza tal cual.
      if (err instanceof ConektaHttpError && err.status === 402) {
        const body402 = err.body as Partial<ConektaOrderResponse>;
        if (body402?.id) return body402 as ConektaOrderResponse;
      }
      throw err;
    }
  }

  async charge(input: ChargeInput): Promise<PaymentResult> {
    this.assertAvailable();
    const { result } = await withIdempotency(this.idempotency, input.idempotencyKey, async () => {
      const order = await this.createOrder(input, false);
      return {
        externalPaymentId: order.id,
        status: mapConektaStatusToDomain(order.payment_status),
        amount: input.amount,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
      } satisfies PaymentResult;
    });
    return result;
  }

  async preAuthorize(input: PreAuthorizeInput): Promise<PaymentResult> {
    this.assertAvailable();
    const { result } = await withIdempotency(this.idempotency, input.idempotencyKey, async () => {
      const order = await this.createOrder(input, true);
      // El enum público `payment_status` de Conekta (pending_payment/paid/declined/
      // expired/refunded/partially_refunded) NO tiene un estado "autorizado" separado
      // (ver README.md, tabla de mapeo, fila ya documentada antes de este cambio): una
      // orden pre-autorizada y aún sin capturar queda en `pending_payment`. Interpretar
      // ESE `pending_payment` como dominio "autorizado" es válido AQUÍ (y solo aquí,
      // nunca en `mapConektaStatusToDomain` genérico) porque nosotros pedimos
      // `pre_authorize: true` y sabemos por contexto qué significa -- no es una
      // invención: es la misma orden, con la misma información que Conekta documenta,
      // interpretada con el contexto de la llamada que hicimos. `declined`/`expired`
      // pasan por el mapeo genérico normal (fallido/expirado), nunca se disfrazan de
      // autorizado.
      const status =
        order.payment_status === "pending_payment" ? "autorizado" : mapConektaStatusToDomain(order.payment_status);
      const result: PaymentResult = {
        externalPaymentId: order.id,
        status,
        amount: input.amount,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
      };
      if (status === "autorizado") {
        // Mismo criterio que StripeAdapter: Conekta no nos devuelve una expiración de
        // pre-auth parametrizable por `holdMinutes` -- es NUESTRO seguimiento de dominio
        // (idéntico cálculo que `FakeConektaAdapter`), para paridad de comportamiento
        // entre proveedores (REQ-INT-002). `capturePreAuth` igual valida el estado REAL
        // que Conekta reporte al capturar, nunca confía solo en este reloj local.
        result.preAuthExpiresAt = new Date(Date.now() + input.holdMinutes * 60_000).toISOString();
      }
      return result;
    });
    return result;
  }

  async capturePreAuth(externalPaymentId: string, idempotencyKey: string): Promise<PaymentResult> {
    this.assertAvailable();
    const { result } = await withIdempotency(this.idempotency, idempotencyKey, async () => {
      try {
        const order = await this.request<ConektaOrderResponse>(`${this.routes.orders}/${externalPaymentId}/capture`, {
          method: "POST",
        });
        return {
          externalPaymentId: order.id,
          status: mapConektaStatusToDomain(order.payment_status),
          amount: fromConektaMinorUnits(order.amount),
          currency: order.currency.toUpperCase(),
          idempotencyKey,
        } satisfies PaymentResult;
      } catch (err) {
        if (err instanceof ConektaHttpError) {
          const body = err.body as ConektaErrorBody;
          const message = body?.message ?? body?.details?.[0]?.message ?? "";
          // No hay un código de error documentado y confirmado en esta sesión para
          // "pre-auth vencida" en Conekta -- se detecta por texto ("expir...") en el
          // mensaje, mismo criterio honesto que StripeAdapter. Si Conekta cambia su
          // redacción exacta, este `regex` puede dejar de matchear -- por eso sigue sin
          // `verificadoContraReal`.
          if (/expir/i.test(message)) {
            throw new PreAuthExpiredError(externalPaymentId);
          }
        }
        throw err;
      }
    });
    return result;
  }

  async refund(input: RefundInput): Promise<PaymentResult> {
    this.assertAvailable();
    const { result } = await withIdempotency(this.idempotency, input.idempotencyKey, async () => {
      const order = await this.request<ConektaOrderResponse>(`${this.routes.orders}/${input.externalPaymentId}/refunds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "requested_by_client" es el motivo por defecto documentado en la mayoría de
        // integraciones Conekta para reembolsos iniciados por la plataforma (no por el
        // titular de la tarjeta) -- ver README.md para la nota de verificación pendiente.
        body: JSON.stringify({ amount: toConektaMinorUnits(input.amount), reason: "requested_by_client" }),
      });
      return {
        externalPaymentId: order.id,
        status: mapConektaStatusToDomain(order.payment_status),
        amount: fromConektaMinorUnits(order.amount),
        currency: order.currency.toUpperCase(),
        idempotencyKey: input.idempotencyKey,
      } satisfies PaymentResult;
    });
    return result;
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<PaymentWebhookEvent> {
    const secret = process.env.CONEKTA_WEBHOOK_SECRET;
    if (!secret) throw new PortUnavailableError("conekta", "falta CONEKTA_WEBHOOK_SECRET para verificar webhooks");
    if (!verifyHmacSignature(rawBody, signatureHeader, secret)) throw new WebhookSignatureError("conekta");
    const payload = JSON.parse(rawBody) as { id?: string };
    const eventId = payload.id;
    if (!eventId) throw new WebhookSignatureError("conekta");
    if (this.replayGuard.seenBefore(eventId)) throw new WebhookReplayError("conekta", eventId);
    throw new PortUnavailableError("conekta", "normalización completa del payload real pendiente de credenciales");
  }
}
