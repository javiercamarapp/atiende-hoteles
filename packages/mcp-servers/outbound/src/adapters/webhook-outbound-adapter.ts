/**
 * Adaptador HTTP real y GENÉRICO del conector outbound PMS-enterprise -- mismo criterio
 * "esqueleto honesto" que `packages/mcp-servers/payments/src/adapters/stripe-adapter.ts`:
 * puerto real, adaptador HTTP real (fetch nativo, sin SDK), Fake para pruebas,
 * `verificadoContraReal = false` explícito. A diferencia de Stripe/Conekta, este
 * adaptador no habla el contrato de UN proveedor documentado -- habla el contrato que
 * CADA hotel de cadena define para su propio sistema (HotSOS/Optii-style): un webhook
 * HTTP que recibe un POST JSON firmado por HMAC saliente. Eso es exactamente lo que
 * "genérico configurable por hotel" significa aquí: no hay una API pública fija que
 * verificar, por lo que el contrato de prueba (`tests/integration/contracts/outbound/`)
 * corre contra un servidor HTTP local que IMPLEMENTA ese contrato mínimo (verificación
 * de firma + 200 OK), no contra un proveedor real con nombre propio.
 *
 * *** [PENDIENTE DE VERIFICACIÓN CONTRA EL PROVEEDOR REAL] ***
 * `verificadoContraReal = false` (constante de módulo + propiedad de instancia): este
 * código hace POSTs HTTP reales cuando se le da una `OutboundTaskDestination`, y se
 * probó de extremo a extremo contra `tests/support/fakeOutboundTargetServer.ts` (un
 * simulador HTTP local, node:http, que verifica la firma HMAC saliente exactamente como
 * se documenta abajo) -- pero jamás se ha ejecutado ni una sola llamada contra el
 * sistema real de un hotel (HotSOS, Optii, o cualquier otro) en esta sesión, porque
 * "genérico" significa por definición que no hay un proveedor único que integrar hasta
 * que un hotel piloto provea su URL/secreto reales. NUNCA asumas que "probablemente
 * funciona" contra el sistema real de un hotel a partir de este comentario.
 *
 * Firma HMAC saliente: reutiliza `signHmac()` (packages/mcp-servers/shared/src/hmac.ts,
 * GOB-042) -- el MISMO primitivo que todos los adaptadores de este repo usan para
 * VERIFICAR webhooks entrantes (Stripe/Conekta/Cloudbeds/Meta/PAC), aplicado en la
 * dirección contraria: aquí SOMOS quien firma, para que el sistema del hotel pueda
 * verificar que el POST vino de nosotros y no fue alterado en tránsito. Header
 * `X-Atiende-Signature: sha256=<hex>` sobre el cuerpo JSON crudo (mismo formato
 * `sha256=<hex>` que Meta/GitHub, ver `HmacSignOptions` default) -- el hotel verifica
 * con `verifyHmacSignature(rawBody, header, secretCompartido)` si su sistema está en
 * este mismo stack, o con el equivalente HMAC-SHA256 estándar en cualquier otro.
 */
import {
  PortRateLimitError,
  retryWithBackoff,
  signHmac,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  OutboundDeliveryError,
  type OutboundTask,
  type OutboundTaskDestination,
  type OutboundTaskSyncPort,
  type OutboundTaskSyncResult,
} from "../port.ts";

export const OUTBOUND_SIGNATURE_HEADER = "X-Atiende-Signature";
export const OUTBOUND_EVENT_ID_HEADER = "X-Atiende-Event-Id";
export const OUTBOUND_TASK_TYPE_HEADER = "X-Atiende-Task-Type";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** `false`, siempre -- ver cabecera de este archivo. Constante a nivel de módulo (además
 *  de la propiedad de instancia `verificadoContraReal`) para que sea localizable con un
 *  simple grep/import sin instanciar la clase (mismo patrón que `STRIPE_VERIFICADO_CONTRA_REAL`). */
export const WEBHOOK_OUTBOUND_VERIFICADO_CONTRA_REAL = false as const;

export interface WebhookOutboundAdapterConfig {
  /** Timeout por request en ms (default 10s) -- override en pruebas. */
  requestTimeoutMs?: number;
  /** Máximo de intentos ante 429 del sistema del hotel (default 4, mismo default que
   *  `StripeAdapter`). Un no-2xx que NO es 429 nunca se reintenta -- puede ser un
   *  payload rechazado a propósito por el hotel, reintentar ciegamente lo empeoraría. */
  maxAttempts?: number;
}

/**
 * Genera el firmado y el cuerpo crudo de un `OutboundTask` -- exportado por separado
 * (no solo usado dentro de `pushTask`) para que `tests/support/fakeOutboundTargetServer.ts`
 * y las pruebas de contrato puedan recomputar la firma esperada sin duplicar la lógica.
 */
export function buildOutboundSignedRequest(
  task: OutboundTask,
  secret: string,
): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(task);
  return { rawBody, signature: signHmac(rawBody, secret) };
}

export class WebhookOutboundAdapter implements OutboundTaskSyncPort {
  readonly verificadoContraReal = false as const;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(config: WebhookOutboundAdapterConfig = {}) {
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxAttempts = config.maxAttempts ?? 4;
  }

  /** No depende de credenciales de proceso (ver comentario de cabecera de `port.ts`):
   *  el mecanismo de envío en sí siempre está "disponible" -- lo que puede faltar es la
   *  configuración de un hotel EN PARTICULAR, que `status()` no puede ver desde aquí. */
  status(): AdapterStatus {
    return { provider: "webhook-outbound-generico", available: true, simulated: false };
  }

  async pushTask(destination: OutboundTaskDestination, task: OutboundTask): Promise<OutboundTaskSyncResult> {
    const { rawBody, signature } = buildOutboundSignedRequest(task, destination.secret);

    const response = await retryWithBackoff(
      async () => {
        const res = await fetch(destination.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [OUTBOUND_SIGNATURE_HEADER]: signature,
            [OUTBOUND_EVENT_ID_HEADER]: task.idempotencyKey,
            [OUTBOUND_TASK_TYPE_HEADER]: task.taskType,
          },
          body: rawBody,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (res.status === 429) {
          const retryAfterHeader = res.headers.get("Retry-After");
          throw new PortRateLimitError(
            "webhook-outbound-generico",
            retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined,
          );
        }
        return res;
      },
      {
        maxAttempts: this.maxAttempts,
        isRetryable: (error) => error instanceof PortRateLimitError,
        retryAfterMs: (error) => (error instanceof PortRateLimitError ? error.retryAfterMs : undefined),
      },
    );

    const bodyText = await response.text();
    if (!response.ok) {
      throw new OutboundDeliveryError(destination.url, response.status, bodyText);
    }

    // El contrato del sistema del hotel puede (opcionalmente) devolver un id externo --
    // nunca se exige un shape específico (es genérico): un cuerpo vacío o no-JSON en una
    // respuesta 2xx sigue siendo una entrega exitosa, solo sin `externalTaskId`.
    let externalTaskId: string | undefined;
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText) as { id?: unknown; taskId?: unknown; external_id?: unknown };
        const candidate = parsed.id ?? parsed.taskId ?? parsed.external_id;
        if (typeof candidate === "string") externalTaskId = candidate;
      } catch {
        // Cuerpo 2xx no-JSON: se ignora, no es un error (ver comentario de arriba).
      }
    }

    return { delivered: true, skipped: false, statusCode: response.status, externalTaskId };
  }
}
