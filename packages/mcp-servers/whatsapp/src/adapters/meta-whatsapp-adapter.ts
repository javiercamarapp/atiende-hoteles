/**
 * Adaptador real contra WhatsApp Cloud API (Meta Graph API), H15-012.
 *
 * [NO VERIFICADO CONTRA META REAL] -- este archivo implementa la llamada HTTP real
 * (fetch a `graph.facebook.com`, Bearer token, contrato exacto documentado por Meta para
 * enviar mensajes y para normalizar webhooks entrantes) y tiene una prueba de CONTRATO
 * real contra un simulador HTTP local (`tests/support/whatsappCloudApiSimulator.ts`,
 * ejercitado por `tests/unit/mcp-servers/whatsapp/meta-adapter-real.spec.ts`) que imita
 * ESE MISMO contrato -- pero, sin credenciales de una app de Meta for Developers
 * disponibles en este entorno, este código NUNCA se ha ejecutado contra
 * `graph.facebook.com` de verdad. No se afirma "funciona": se afirma "implementa el
 * contrato documentado y pasa la prueba de contrato contra el simulador". Ver
 * `README.md` §"Primera prueba real" para los pasos exactos (cuenta Meta Business, Tech
 * Provider, número de WhatsApp Business verificado, configurar el webhook) que hacen
 * falta para pasar de "implementado" a "verificado".
 *
 * Sin credenciales (`WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`/
 * `WHATSAPP_APP_SECRET`), `status()` declara `unavailable` y ningún método llama a la
 * red real -- `apps/api/src/lib/messaging.ts` selecciona este adaptador SOLO cuando las
 * credenciales de envío están presentes (mismo patrón que `resolveEmailPort`), igual que
 * antes de este fix nunca se llamaba (H6b lo dejó hardcodeado al Fake).
 */
import { randomUUID } from "node:crypto";
import {
  PortUnavailableError,
  PortRateLimitError,
  PortValidationError,
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryReplayGuard,
  InMemoryIdempotencyStore,
  withIdempotency,
  retryWithBackoff,
  verifyHmacSignature,
  signHmac,
  checkEnvCredentials,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  mapMetaStatusToDomain,
  type MessagingPort,
  type MetaMessageStatus,
  type SendInteractiveButtonsInput,
  type SendTemplateMessageInput,
  type SendTextMessageInput,
  type SentMessage,
  type WhatsappWebhookEvent,
} from "../port.ts";

const REQUIRED_ENV = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET"] as const;

export const GRAPH_API_VERSION = "v21.0";

/**
 * `WHATSAPP_GRAPH_BASE_URL_OVERRIDE` -- SOLO para pruebas: apunta el fetch de este
 * adaptador a `tests/support/whatsappCloudApiSimulator.ts` (un servidor `node:http`
 * local que imita el contrato de Graph API) en vez de `https://graph.facebook.com`.
 * Nunca se documenta en `.env.example` ni se lee en ningún flujo de producción --
 * definirla fuera de una prueba sería exactamente el tipo de "parecer verificado sin
 * estarlo" que ADR-006/007 prohíben, así que además de no promoverla en documentación de
 * despliegue, un valor puesto aquí solo cambia A DÓNDE se manda la llamada real, nunca
 * si se manda o no (eso lo sigue decidiendo únicamente `checkEnvCredentials`).
 */
function graphBaseUrl(): string {
  return process.env.WHATSAPP_GRAPH_BASE_URL_OVERRIDE?.trim() || "https://graph.facebook.com";
}

export function graphMessagesUrl(phoneNumberId: string): string {
  return `${graphBaseUrl()}/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;
}

// ---------------------------------------------------------------------------
// Forma documentada del payload de webhook entrante de WhatsApp Cloud API
// (https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components). Se usa
// un tipo laxo (campos opcionales, sin rechazar campos desconocidos) a propósito: Meta
// agrega campos nuevos sin previo aviso y este adaptador no debe romperse por un campo
// que no usa -- lo que SÍ es estricto es `normalizeMetaWebhookPayload`: si falta la
// forma mínima que necesita (`entry[0].changes[0].value` con `messages` o `statuses`),
// lanza en vez de inventar un evento.
// ---------------------------------------------------------------------------
interface MetaInteractiveButtonReply {
  type: "button_reply";
  button_reply: { id: string; title: string };
}
interface MetaInteractiveNfmReply {
  type: "nfm_reply";
  nfm_reply: { name?: string; response_json: string };
}

interface MetaIncomingMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  /** Formato LEGADO de botón de plantilla ("quick reply" de plantilla, distinto del
   *  Interactive Reply Button que REQ-UX-006 usa realmente). */
  button?: { text: string; payload: string };
  interactive?: MetaInteractiveButtonReply | MetaInteractiveNfmReply | { type: string };
}

interface MetaStatusUpdate {
  id: string;
  status: MetaMessageStatus;
  timestamp: string;
  recipient_id: string;
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        messages?: MetaIncomingMessage[];
        statuses?: MetaStatusUpdate[];
      };
    }>;
  }>;
}

/** Meta manda `from`/`wa_id` como dígitos puros (sin "+"); el resto del dominio (Fake
 *  incluido, `port.ts` `to: z.string().min(8)`) usa siempre E.164 con "+" -- se normaliza
 *  aquí, en el único punto que traduce el formato nativo de Meta al del dominio. */
function toE164(phoneDigits: string): string {
  return phoneDigits.startsWith("+") ? phoneDigits : `+${phoneDigits}`;
}

/** Meta manda epoch en SEGUNDOS (string) tanto en `messages[].timestamp` como en
 *  `statuses[].timestamp`; el dominio (`WhatsappWebhookEvent.occurredAt`) exige ISO-8601. */
function unixSecondsToIso(timestampSeconds: string): string {
  const seconds = Number(timestampSeconds);
  if (!Number.isFinite(seconds)) {
    throw new PortValidationError("meta-whatsapp", `timestamp de webhook no numérico: "${timestampSeconds}"`);
  }
  return new Date(seconds * 1000).toISOString();
}

/**
 * Normaliza el payload REAL de un webhook de WhatsApp Cloud API (ya verificado por HMAC)
 * al `WhatsappWebhookEvent` que el resto del sistema consume. Fail-closed sobre la
 * FORMA del payload: si no trae ni `messages` ni `statuses` en el primer `entry`/`change`
 * (la única forma documentada), lanza `PortValidationError` en vez de fabricar un evento
 * -- nunca se inventa un `eventId`/`from` que Meta no mandó.
 *
 * Corrige un bug real de la versión anterior de este archivo: usaba `entry[0].id` (el ID
 * de la WABA, CONSTANTE para todos los eventos de ese número) como `eventId` de replay
 * -- con eso, el SEGUNDO evento real de cualquier conversación habría sido rechazado como
 * replay del primero. El identificador único real es el `id` del mensaje
 * (`messages[0].id`, un `wamid...` único de Meta) o, para actualizaciones de estado,
 * `statuses[0].id` compuesto con el estado (`sent`/`delivered`/`read`/`failed`) porque el
 * MISMO `wamid` recibe varias actualizaciones de estado en su ciclo de vida y cada una es
 * un evento distinto que sí debe procesarse.
 */
export function normalizeMetaWebhookPayload(payload: MetaWebhookPayload): WhatsappWebhookEvent {
  const value = payload.entry?.[0]?.changes?.[0]?.value;
  if (!value) {
    throw new PortValidationError(
      "meta-whatsapp",
      "payload de webhook sin entry[0].changes[0].value -- no coincide con el contrato documentado de WhatsApp Cloud API",
    );
  }

  const message = value.messages?.[0];
  if (message) {
    const from = toE164(message.from);
    const occurredAt = unixSecondsToIso(message.timestamp);
    const raw = payload as unknown as Record<string, unknown>;

    if (message.type === "interactive" && message.interactive && "button_reply" in message.interactive) {
      return {
        eventId: message.id,
        type: "interactive.button_clicked",
        from,
        buttonId: message.interactive.button_reply.id,
        occurredAt,
        raw,
      };
    }
    if (message.type === "interactive" && message.interactive && "nfm_reply" in message.interactive) {
      return {
        eventId: message.id,
        type: "flow.completed",
        from,
        textBody: message.interactive.nfm_reply.response_json,
        occurredAt,
        raw,
      };
    }
    if (message.type === "button" && message.button) {
      // Botón de plantilla LEGADO (no Interactive Reply Button) -- se normaliza igual
      // como clic de botón para que `aprobacionesWhatsapp.ts` funcione sin importar cuál
      // de los dos mecanismos de botón use la plantilla real configurada en Meta.
      return {
        eventId: message.id,
        type: "interactive.button_clicked",
        from,
        buttonId: message.button.payload,
        occurredAt,
        raw,
      };
    }
    return {
      eventId: message.id,
      type: "message.received",
      from,
      textBody: message.text?.body,
      occurredAt,
      raw,
    };
  }

  const status = value.statuses?.[0];
  if (status) {
    return {
      // Compuesto id+status: el mismo wamid pasa por varios estados (sent -> delivered ->
      // read); cada transición es un evento real distinto, nunca un replay del anterior.
      eventId: `${status.id}:${status.status}`,
      type: "message.status_updated",
      externalMessageId: status.id,
      status: mapMetaStatusToDomain(status.status),
      occurredAt: unixSecondsToIso(status.timestamp),
      raw: payload as unknown as Record<string, unknown>,
    };
  }

  throw new PortValidationError(
    "meta-whatsapp",
    "payload de webhook sin messages ni statuses en value -- tipo de evento no reconocido",
  );
}

/** Firma un fixture de payload REAL (forma documentada de Meta) con el App Secret --
 *  para pruebas de contrato contra este adaptador (`meta-adapter-real.spec.ts`), nunca
 *  usado en código de producción. Mismo espíritu que
 *  `FakeWhatsappAdapter.signWebhookFixture`, pero firmando la forma real de Meta en vez
 *  de la forma simplificada del simulador. */
export function signMetaWebhookFixture(
  payload: MetaWebhookPayload,
  secret: string,
): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(payload);
  return { rawBody, signature: signHmac(rawBody, secret) };
}

/** Construye el fixture de un mensaje de texto entrante, forma real documentada por Meta. */
export function buildMetaTextMessageWebhookPayload(params: {
  wabaId?: string;
  phoneNumberId?: string;
  from: string;
  text: string;
  messageId?: string;
  timestampSeconds?: number;
}): MetaWebhookPayload {
  const from = params.from.replace(/^\+/, "");
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: params.wabaId ?? "waba-simulada-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: params.phoneNumberId ?? "1234567890", display_phone_number: "15550001111" },
              messages: [
                {
                  id: params.messageId ?? `wamid.${randomUUID()}`,
                  from,
                  timestamp: String(params.timestampSeconds ?? Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: params.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Construye el fixture de un clic de Interactive Reply Button (REQ-UX-006), forma real. */
export function buildMetaButtonReplyWebhookPayload(params: {
  wabaId?: string;
  phoneNumberId?: string;
  from: string;
  buttonId: string;
  buttonTitle?: string;
  messageId?: string;
  timestampSeconds?: number;
}): MetaWebhookPayload {
  const from = params.from.replace(/^\+/, "");
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: params.wabaId ?? "waba-simulada-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: params.phoneNumberId ?? "1234567890", display_phone_number: "15550001111" },
              messages: [
                {
                  id: params.messageId ?? `wamid.${randomUUID()}`,
                  from,
                  timestamp: String(params.timestampSeconds ?? Math.floor(Date.now() / 1000)),
                  type: "interactive",
                  interactive: { type: "button_reply", button_reply: { id: params.buttonId, title: params.buttonTitle ?? "Aprobar" } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Construye el fixture de una actualización de estado de entrega, forma real de Meta. */
export function buildMetaStatusWebhookPayload(params: {
  wabaId?: string;
  phoneNumberId?: string;
  messageId: string;
  status: MetaMessageStatus;
  recipientId: string;
  timestampSeconds?: number;
}): MetaWebhookPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: params.wabaId ?? "waba-simulada-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: params.phoneNumberId ?? "1234567890", display_phone_number: "15550001111" },
              statuses: [
                {
                  id: params.messageId,
                  status: params.status,
                  timestamp: String(params.timestampSeconds ?? Math.floor(Date.now() / 1000)),
                  recipient_id: params.recipientId.replace(/^\+/, ""),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export class MetaWhatsappAdapter implements MessagingPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly replayGuard = new InMemoryReplayGuard();
  private readonly sendIdempotency = new InMemoryIdempotencyStore<SentMessage>();

  status(): AdapterStatus {
    if (this.credentials.available) {
      return { provider: "meta-whatsapp", available: true, simulated: false };
    }
    return {
      provider: "meta-whatsapp",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError(
        "meta-whatsapp",
        `faltan variables de entorno: ${this.credentials.missing.join(", ")}`,
      );
    }
  }

  /** Llamada real con backoff/rate-limit contra `POST /{phone-number-id}/messages`
   *  (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages). */
  private async postMessage(body: unknown): Promise<{ messages?: Array<{ id: string }> }> {
    const url = graphMessagesUrl(process.env.WHATSAPP_PHONE_NUMBER_ID!);
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          throw new PortRateLimitError(
            "meta-whatsapp",
            retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined,
          );
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`meta-whatsapp: HTTP ${response.status}${detail ? ` -- ${detail}` : ""}`);
        }
        return (await response.json()) as { messages?: Array<{ id: string }> };
      },
      {
        maxAttempts: 4,
        isRetryable: (error) => error instanceof PortRateLimitError,
        retryAfterMs: (error) => (error instanceof PortRateLimitError ? error.retryAfterMs : undefined),
      },
    );
  }

  private extractSentMessage(response: { messages?: Array<{ id: string }> }, to: string, clientMessageId: string): SentMessage {
    const externalMessageId = response.messages?.[0]?.id;
    if (!externalMessageId) {
      throw new PortValidationError(
        "meta-whatsapp",
        `respuesta de Graph API sin messages[0].id: ${JSON.stringify(response)}`,
      );
    }
    // Graph API solo confirma que ACEPTÓ el mensaje para envío -- el estado real
    // (entregado/leído/fallido) llega después por webhook (`message.status_updated`).
    // "enviado" aquí es honesto: es literalmente lo único que esta respuesta certifica.
    return { externalMessageId, to, clientMessageId, status: "enviado" };
  }

  async sendTemplateMessage(input: SendTemplateMessageInput): Promise<SentMessage> {
    this.assertAvailable();
    const { result } = await withIdempotency(this.sendIdempotency, input.clientMessageId, async () => {
      const body = {
        messaging_product: "whatsapp",
        to: input.to,
        type: "template",
        template: {
          name: input.templateName,
          language: { code: input.languageCode },
          ...(input.parameters.length > 0
            ? { components: [{ type: "body", parameters: input.parameters.map((text) => ({ type: "text", text })) }] }
            : {}),
        },
      };
      const response = await this.postMessage(body);
      return this.extractSentMessage(response, input.to, input.clientMessageId);
    });
    return result;
  }

  async sendTextMessage(input: SendTextMessageInput): Promise<SentMessage> {
    this.assertAvailable();
    const { result } = await withIdempotency(this.sendIdempotency, input.clientMessageId, async () => {
      const body = {
        messaging_product: "whatsapp",
        to: input.to,
        type: "text",
        text: { body: input.body, preview_url: false },
      };
      const response = await this.postMessage(body);
      return this.extractSentMessage(response, input.to, input.clientMessageId);
    });
    return result;
  }

  async sendInteractiveButtonsMessage(input: SendInteractiveButtonsInput): Promise<SentMessage> {
    this.assertAvailable();
    const { result } = await withIdempotency(this.sendIdempotency, input.clientMessageId, async () => {
      const body = {
        messaging_product: "whatsapp",
        to: input.to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: input.body },
          action: { buttons: input.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      };
      const response = await this.postMessage(body);
      return this.extractSentMessage(response, input.to, input.clientMessageId);
    });
    return result;
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<WhatsappWebhookEvent> {
    // Fail-closed (mismo criterio que REQ-AB-012 y el resto de webhooks de este repo):
    // sin `WHATSAPP_APP_SECRET` configurado, o con firma ausente/inválida, SIEMPRE se
    // rechaza -- nunca se acepta en silencio ni se cae a un secreto por defecto.
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) {
      throw new PortUnavailableError("meta-whatsapp", "falta WHATSAPP_APP_SECRET para verificar webhooks");
    }
    if (!verifyHmacSignature(rawBody, signatureHeader, secret)) {
      throw new WebhookSignatureError("meta-whatsapp");
    }
    let payload: MetaWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as MetaWebhookPayload;
    } catch {
      // La firma pasó pero el cuerpo no es JSON válido: tratarlo como firma inválida
      // (fail-closed) en vez de un 500 -- no hay forma honesta de "normalizar" esto.
      throw new WebhookSignatureError("meta-whatsapp");
    }
    const event = normalizeMetaWebhookPayload(payload);
    if (this.replayGuard.seenBefore(event.eventId)) {
      throw new WebhookReplayError("meta-whatsapp", event.eventId);
    }
    return event;
  }
}
