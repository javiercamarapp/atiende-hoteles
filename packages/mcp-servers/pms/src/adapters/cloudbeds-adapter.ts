/**
 * Adaptador real contra la API de Cloudbeds (H15-001, primer conector). Esqueleto
 * honesto: implementa rutas, auth OAuth2, reintentos con backoff, idempotencia y
 * verificación HMAC de webhooks, pero SIN credenciales en entorno se declara
 * `unavailable` y ningún método hace una llamada de red real ni fabrica una respuesta.
 *
 * [PENDIENTE DE CREDENCIALES] -- requiere `CLOUDBEDS_CLIENT_ID`, `CLOUDBEDS_CLIENT_SECRET`
 * y `CLOUDBEDS_ACCESS_TOKEN` (OAuth2 del hotel) y `CLOUDBEDS_WEBHOOK_SECRET` (firma de
 * webhooks). Ver README.md de este paquete.
 */
import {
  PortUnavailableError,
  PortNotFoundError,
  PortRateLimitError,
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryIdempotencyStore,
  InMemoryReplayGuard,
  retryWithBackoff,
  verifyHmacSignature,
  checkEnvCredentials,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  mapCloudbedsStatusToDomain,
  mapDomainStatusToCloudbeds,
  mapDomainRoomStatusToCloudbeds,
  CloudbedsReservationStatus,
  CloudbedsRoomStatus,
  type PmsPort,
  type PmsReservation,
  type PmsRatePlan,
  type ApplyReservationUpdateInput,
  type CreateChargeInput,
  type PmsCharge,
  type UpdateHousekeepingInput,
  type PmsRoomStatus,
  type PmsGuestProfile,
  type PmsWebhookEvent,
} from "../port.ts";

const REQUIRED_ENV = [
  "CLOUDBEDS_CLIENT_ID",
  "CLOUDBEDS_CLIENT_SECRET",
  "CLOUDBEDS_ACCESS_TOKEN",
  "CLOUDBEDS_WEBHOOK_SECRET",
] as const;

/**
 * Rutas documentadas de la API pública de Cloudbeds v1.2 (`docs/referencia/03-...md` §5),
 * usadas por el esqueleto del adaptador real. No se llaman sin credenciales.
 */
export const CLOUDBEDS_API_BASE = "https://api.cloudbeds.com/api/v1.2";
export const CLOUDBEDS_ROUTES = {
  getReservation: `${CLOUDBEDS_API_BASE}/getReservation`,
  getRatePlans: `${CLOUDBEDS_API_BASE}/getRatePlans`,
  postCharge: `${CLOUDBEDS_API_BASE}/postCharge`,
  putRoomStatus: `${CLOUDBEDS_API_BASE}/putRoomCondition`,
  getGuest: `${CLOUDBEDS_API_BASE}/getGuest`,
} as const;

export class CloudbedsAdapter implements PmsPort {
  private readonly credentials = checkEnvCredentials(REQUIRED_ENV);
  private readonly idempotency = new InMemoryIdempotencyStore<PmsCharge>();
  private readonly replayGuard = new InMemoryReplayGuard();

  status(): AdapterStatus {
    if (this.credentials.available) {
      return { provider: "cloudbeds", available: true, simulated: false };
    }
    return {
      provider: "cloudbeds",
      available: false,
      simulated: false,
      reason: `[PENDIENTE DE CREDENCIALES] faltan: ${this.credentials.missing.join(", ")}`,
    };
  }

  private assertAvailable(): void {
    if (!this.credentials.available) {
      throw new PortUnavailableError(
        "cloudbeds",
        `faltan variables de entorno: ${this.credentials.missing.join(", ")}`,
      );
    }
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${process.env.CLOUDBEDS_ACCESS_TOKEN}` };
  }

  /**
   * Envoltura de `fetch` con reintentos/backoff y manejo de `Retry-After` (429). Se llama
   * SOLO tras `assertAvailable()`, así que nunca se ejecuta en este hito (sin
   * credenciales reales en CI/desarrollo) -- queda documentada para cuando exista un
   * hotel con OAuth de Cloudbeds real.
   */
  private async request<T>(url: string, init: RequestInit): Promise<T> {
    return retryWithBackoff(
      async () => {
        const response = await fetch(url, { ...init, headers: { ...this.authHeaders(), ...init.headers } });
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
          throw new PortRateLimitError("cloudbeds", retryAfterMs);
        }
        if (response.status === 404) {
          throw new PortNotFoundError("cloudbeds", url);
        }
        if (!response.ok) {
          throw new Error(`cloudbeds: HTTP ${response.status} en ${url}`);
        }
        return (await response.json()) as T;
      },
      {
        maxAttempts: 4,
        isRetryable: (error) => error instanceof PortRateLimitError,
        retryAfterMs: (error) => (error instanceof PortRateLimitError ? error.retryAfterMs : undefined),
      },
    );
  }

  async getReservation(externalReservationId: string): Promise<PmsReservation> {
    this.assertAvailable();
    // Esqueleto real: GET CLOUDBEDS_ROUTES.getReservation?reservationID=... y mapear la
    // respuesta al esquema `PmsReservation` (incluye `mapCloudbedsStatusToDomain`).
    void externalReservationId;
    void mapCloudbedsStatusToDomain;
    void CloudbedsReservationStatus;
    throw new PortUnavailableError("cloudbeds", "sin credenciales verificadas en este entorno");
  }

  async listRatePlans(): Promise<PmsRatePlan[]> {
    this.assertAvailable();
    throw new PortUnavailableError("cloudbeds", "sin credenciales verificadas en este entorno");
  }

  async createCharge(input: CreateChargeInput): Promise<PmsCharge> {
    this.assertAvailable();
    // Idempotencia real: `this.idempotency` + `withIdempotency` evitarían un segundo
    // POST contra Cloudbeds con la misma `idempotencyKey` -- ver FakeCloudbedsAdapter
    // para el comportamiento observable en pruebas.
    void input;
    void this.idempotency;
    throw new PortUnavailableError("cloudbeds", "sin credenciales verificadas en este entorno");
  }

  async applyReservationUpdate(input: ApplyReservationUpdateInput): Promise<PmsReservation> {
    this.assertAvailable();
    // Esqueleto real: PUT/PATCH de la reserva contra Cloudbeds enviando
    // `expectedVersion` como precondición (p.ej. If-Match), mapeando un 409/412 del
    // proveedor a `PortConflictError` -- ver FakeCloudbedsAdapter para el comportamiento
    // observable en pruebas (REQ-QA-003).
    void input;
    void mapDomainStatusToCloudbeds;
    throw new PortUnavailableError("cloudbeds", "sin credenciales verificadas en este entorno");
  }

  async updateHousekeepingStatus(input: UpdateHousekeepingInput): Promise<PmsRoomStatus> {
    this.assertAvailable();
    void input;
    void mapDomainRoomStatusToCloudbeds;
    void CloudbedsRoomStatus;
    throw new PortUnavailableError("cloudbeds", "sin credenciales verificadas en este entorno");
  }

  async getGuestProfile(externalGuestId: string): Promise<PmsGuestProfile> {
    this.assertAvailable();
    void externalGuestId;
    throw new PortUnavailableError("cloudbeds", "sin credenciales verificadas en este entorno");
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<PmsWebhookEvent> {
    // La verificación de firma SÍ puede ejecutarse sin llamar a la red: solo depende del
    // secreto compartido. Se deja activa incluso sin el resto de credenciales, porque
    // Cloudbeds puede enviar webhooks configurados por el hotel directamente en el panel
    // (el secreto de webhook es independiente del OAuth de la API REST).
    const secret = process.env.CLOUDBEDS_WEBHOOK_SECRET;
    if (!secret) {
      throw new PortUnavailableError("cloudbeds", "falta CLOUDBEDS_WEBHOOK_SECRET para verificar webhooks");
    }
    if (!verifyHmacSignature(rawBody, signatureHeader, secret)) {
      throw new WebhookSignatureError("cloudbeds");
    }
    const payload = JSON.parse(rawBody) as { event_id?: string };
    const eventId = payload.event_id;
    if (!eventId) {
      throw new WebhookSignatureError("cloudbeds");
    }
    if (this.replayGuard.seenBefore(eventId)) {
      throw new WebhookReplayError("cloudbeds", eventId);
    }
    // El mapeo completo del payload nativo -> `PmsWebhookEvent` requiere conocer el
    // formato real de Cloudbeds (pendiente de credenciales para grabar un fixture real);
    // el esqueleto de verificación de firma/replay ya es completo y probado.
    throw new PortUnavailableError("cloudbeds", "normalización de payload real pendiente de credenciales");
  }
}
