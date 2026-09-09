/**
 * Adaptador real contra la API de Cloudbeds (H15-001, primer conector). Contrato
 * verificado contra la documentacion publica de Cloudbeds API v1.3
 * (https://developers.cloudbeds.com, openapi embebido en cada pagina de referencia,
 * consultado 2026-09-09): endpoint base, forma exacta de request/response de cada
 * metodo, flujo OAuth2 (authorization_code/refresh_token) y el mecanismo real de
 * webhooks (ver el aviso de "[LIMITACION DOCUMENTADA]" mas abajo, en
 * `verifyAndNormalizeWebhook`).
 *
 * [NO VERIFICADO CONTRA EL SANDBOX REAL DE CLOUDBEDS] -- todo lo de este archivo esta
 * implementado contra el contrato PUBLICO documentado (peticiones HTTP reales, mapeo de
 * campos, manejo de 429/404, renovacion de OAuth), pero NUNCA se ha ejecutado contra un
 * property real ni contra el sandbox de partners de Cloudbeds -- sin credenciales en
 * este entorno, `status()` declara `unavailable` y ningun metodo hace la llamada de red
 * real. `packages/mcp-servers/pms/src/testing/cloudbeds-simulator.ts` (simulador HTTP
 * local fiel a este MISMO contrato documentado) SI se ejecuta de verdad en pruebas
 * (`tests/unit/mcp-servers/pms/cloudbeds-adapter-simulator.spec.ts`) -- eso prueba que
 * el codigo de este adaptador (auth, parseo, mapeo, reintentos, idempotencia,
 * concurrencia optimista) funciona contra ESE contrato, no que Cloudbeds en produccion
 * se comporte identico a su propia documentacion.
 *
 * [PENDIENTE DE CREDENCIALES PARA LA PRIMERA PRUEBA REAL] -- hace falta, de un hotel
 * piloto con cuenta Cloudbeds real (o del sandbox de partners de Cloudbeds, solicitado
 * via https://developers.cloudbeds.com -> Integrations Portal / "Become a partner"):
 *   - `CLOUDBEDS_CLIENT_ID` / `CLOUDBEDS_CLIENT_SECRET`: credenciales de la app OAuth2
 *     registrada en el portal de partners de Cloudbeds.
 *   - `CLOUDBEDS_REFRESH_TOKEN`: se obtiene UNA sola vez completando a mano el flujo
 *     `authorization_code` (redirect + `code`) contra una property real que autorice la
 *     app -- este adaptador solo consume `refresh_token` en adelante; el paso
 *     interactivo de `authorization_code` es un proceso humano de onboarding, no algo
 *     que este paquete automatice.
 *   - `CLOUDBEDS_PROPERTY_ID`: el `propertyID` de Cloudbeds del hotel piloto.
 *   - `CLOUDBEDS_WEBHOOK_SECRET`: secreto PROPIO de este repo (no algo que Cloudbeds
 *     calcule -- ver la limitacion documentada en `verifyAndNormalizeWebhook`) usado
 *     para autenticar la URL de webhook que se registre via `postWebhook`.
 */
import {
  PortUnavailableError,
  PortNotFoundError,
  PortRateLimitError,
  PortConflictError,
  PortValidationError,
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryIdempotencyStore,
  InMemoryReplayGuard,
  retryWithBackoff,
  withIdempotency,
  verifyHmacSignature,
  checkEnvCredentials,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  mapCloudbedsStatusToDomain,
  mapDomainStatusToCloudbeds,
  mapCloudbedsRoomStatusToDomain,
  mapDomainRoomStatusToCloudbeds,
  CloudbedsReservationStatus,
  CloudbedsRoomStatus,
  PmsReservation,
  PmsRatePlan,
  PmsCharge,
  PmsGuestProfile,
  PmsWebhookEvent,
  PmsRoomStatus,
  type PmsPort,
  type ApplyReservationUpdateInput,
  type CreateChargeInput,
  type UpdateHousekeepingInput,
} from "../port.ts";

/**
 * Endpoint base real v1.3 (confirmado por `servers[].url` del OpenAPI embebido en TODAS
 * las paginas de referencia consultadas: getReservation, access_token, getRatePlans,
 * postCharge, putReservation, postHousekeepingStatus, getGuest, getCurrencySettings).
 * La version anterior de este archivo asumia v1.2 en un host distinto sin haberlo
 * verificado contra la documentacion -- corregido.
 */
export const CLOUDBEDS_API_BASE = "https://api.cloudbeds.com/api/v1.3";

/** Paths relativos a `baseUrl` (nunca URLs absolutas): permite que las pruebas apunten
 *  el adaptador a `cloudbeds-simulator.ts` en `http://127.0.0.1:<puerto>` en vez del
 *  host real, sin duplicar la lista de rutas. */
export const CLOUDBEDS_ROUTE_PATHS = {
  accessToken: "/access_token",
  getReservation: "/getReservation",
  getRatePlans: "/getRatePlans",
  postCharge: "/postCharge",
  putReservation: "/putReservation",
  postHousekeepingStatus: "/postHousekeepingStatus",
  getGuest: "/getGuest",
  getCurrencySettings: "/getCurrencySettings",
} as const;

const OAUTH_REQUIRED_ENV = [
  "CLOUDBEDS_CLIENT_ID",
  "CLOUDBEDS_CLIENT_SECRET",
  "CLOUDBEDS_REFRESH_TOKEN",
  "CLOUDBEDS_PROPERTY_ID",
] as const;

const WEBHOOK_REQUIRED_ENV = ["CLOUDBEDS_WEBHOOK_SECRET"] as const;

export interface CloudbedsAdapterOptions {
  /** Host base a usar en vez de `CLOUDBEDS_API_BASE` -- SOLO para pruebas contra
   *  `cloudbeds-simulator.ts`. Nunca se pasa en produccion. */
  baseUrl?: string;
  /** Reloj inyectable para pruebas deterministas de expiracion de token/moneda cacheada. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Formas parciales del wire format REAL de Cloudbeds (solo los campos que este
// adaptador usa) -- documentadas contra el OpenAPI publico de cada endpoint, no
// inventadas. Los campos no listados aqui existen en la respuesta real pero no se
// necesitan para cumplir `PmsPort`.
// ---------------------------------------------------------------------------

interface CloudbedsGuestListEntry {
  guestID: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail?: string;
  guestPhone?: string;
  isMainGuest?: boolean;
}

interface CloudbedsAssignedRoom {
  roomTypeID: string;
}

interface CloudbedsReservationPayload {
  propertyID: string;
  reservationID: string;
  status: string;
  startDate: string;
  endDate: string;
  total: number;
  dateModified: string;
  guestList?: Record<string, CloudbedsGuestListEntry>;
  assigned?: CloudbedsAssignedRoom[];
  unassigned?: CloudbedsAssignedRoom[];
}

interface CloudbedsRateDetail {
  date: string;
  rateBase?: number | null;
  totalRate: number;
}

interface CloudbedsRatePlanPayload {
  rateID: string;
  ratePlanID?: string | null;
  ratePlanNamePublic?: string | null;
  roomRateDetailed?: CloudbedsRateDetail[] | null;
}

interface CloudbedsGuestPayload {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
}

interface CloudbedsHousekeepingStatusPayload {
  roomID: string;
  roomCondition: "dirty" | "clean" | "inspected";
}

interface CloudbedsAccessTokenPayload {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

/**
 * Notificacion de webhook real (docs/webhooks-1): un solo campo `event` que combina
 * entidad+accion ("reservation/status_changed"), `timestamp` UNIX con microsegundos, y
 * capitalizacion INCONSISTENTE de los ids segun el evento (la propia doc de Cloudbeds lo
 * advierte: "propertyID versus propertyId") -- de ahi que este tipo acepte ambas
 * variantes de cada campo.
 */
export interface CloudbedsWebhookPayload {
  version: string;
  event: string;
  timestamp: number;
  propertyID?: number | string;
  propertyId?: number | string;
  reservationID?: string;
  reservationId?: string;
  roomId?: string;
  roomID?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Mapeo evento Cloudbeds -> `PmsWebhookEvent.type` (REQ-INT-001). Solo cubre los
 * eventos de reserva/housekeeping relevantes para este puerto; cualquier otro evento
 * suscrito (custom fields, room blocks, accounting, ...) queda fuera del contrato de
 * `PmsPort` a proposito -- `normalizeCloudbedsWebhookPayload` rechaza explicitamente lo
 * que no reconoce en vez de normalizarlo a un tipo arbitrario.
 */
const CLOUDBEDS_WEBHOOK_EVENT_MAP: Record<string, PmsWebhookEvent["type"]> = {
  "reservation/created": "reservation.created",
  "reservation/status_changed": "reservation.updated",
  "reservation/dates_changed": "reservation.updated",
  "reservation/accommodation_changed": "reservation.updated",
  "reservation/accommodation_type_changed": "reservation.updated",
  "reservation/accommodation_status_changed": "reservation.updated",
  "reservation/deleted": "reservation.canceled",
  "housekeeping/room_condition_changed": "room.status_changed",
  "housekeeping/housekeeping_room_occupancy_status_changed": "room.status_changed",
};

/**
 * Normaliza un payload de webhook REAL de Cloudbeds a `PmsWebhookEvent`. Funcion pura
 * (sin I/O) exportada aparte para poder probarla directo contra ejemplos de la
 * documentacion sin pasar por HTTP/HMAC -- ver
 * `tests/unit/mcp-servers/pms/cloudbeds-adapter-simulator.spec.ts`.
 */
export function normalizeCloudbedsWebhookPayload(payload: CloudbedsWebhookPayload): PmsWebhookEvent {
  let type = CLOUDBEDS_WEBHOOK_EVENT_MAP[payload.event];
  if (payload.event === "reservation/status_changed" && payload.status === "canceled") {
    type = "reservation.canceled";
  }
  if (!type) {
    throw new PortValidationError(
      "cloudbeds",
      `evento de webhook no reconocido/soportado por este puerto: '${payload.event}' -- ver docs/webhooks-1, no se normaliza a ciegas`,
    );
  }
  if (typeof payload.timestamp !== "number") {
    throw new PortValidationError("cloudbeds", "webhook sin 'timestamp' numerico valido");
  }
  const propertyId = payload.propertyID ?? payload.propertyId;
  const reservationId = payload.reservationID ?? payload.reservationId;
  const roomId = payload.roomId ?? payload.roomID;
  const occurredAt = new Date(Math.round(payload.timestamp * 1000)).toISOString();
  // Cloudbeds NO incluye un id de deduplicacion propio en el payload (confirmado contra
  // docs/webhooks-1: no existe un campo tipo `event_id`/`delivery_id`) -- se deriva una
  // clave DETERMINISTA de (evento, propiedad, entidad, timestamp): una entrega repetida
  // del MISMO evento produce la MISMA clave (dedup real via `InMemoryReplayGuard`); una
  // entrega nueva trae un `timestamp` distinto (microsegundos) y por lo tanto una clave
  // distinta.
  const eventId = `${payload.event}:${propertyId ?? ""}:${reservationId ?? roomId ?? ""}:${payload.timestamp}`;
  return PmsWebhookEvent.parse({
    eventId,
    type,
    externalReservationId: reservationId,
    roomExternalId: roomId,
    occurredAt,
    raw: payload as Record<string, unknown>,
  });
}

export class CloudbedsAdapter implements PmsPort {
  private readonly credentials = checkEnvCredentials(OAUTH_REQUIRED_ENV);
  private readonly webhookCredentials = checkEnvCredentials(WEBHOOK_REQUIRED_ENV);
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly idempotency = new InMemoryIdempotencyStore<PmsCharge>();
  private readonly replayGuard = new InMemoryReplayGuard();
  private tokenCache: { accessToken: string; expiresAtMs: number } | null = null;
  private currentRefreshToken: string | undefined;
  private currencyCache: { code: string; expiresAtMs: number } | null = null;

  constructor(options: CloudbedsAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? CLOUDBEDS_API_BASE;
    this.now = options.now ?? Date.now;
    this.currentRefreshToken = process.env.CLOUDBEDS_REFRESH_TOKEN;
  }

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

  private parse<T>(schema: { parse: (value: unknown) => T }, value: unknown, context: string): T {
    try {
      return schema.parse(value);
    } catch (error) {
      throw new PortValidationError("cloudbeds", `${context}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Renueva el access token via OAuth2 `grant_type=refresh_token` (POST /access_token,
   * form-urlencoded -- confirmado en el OpenAPI de esa ruta). Cachea en memoria hasta
   * ~30s antes de `expires_in`. Cloudbeds puede devolver un `refresh_token` NUEVO en la
   * respuesta (rotacion) -- se usa para la siguiente renovacion de ESTE proceso;
   * persistirlo en un almacen durable para sobrevivir un reinicio (Vault/Secrets
   * Manager, ver `bootstrapProductionSecrets` de apps/api) queda pendiente, documentado
   * aqui a proposito en vez de fingir que ya esta resuelto.
   */
  private async getAccessToken(): Promise<string> {
    const marginMs = 30_000;
    if (this.tokenCache && this.tokenCache.expiresAtMs - marginMs > this.now()) {
      return this.tokenCache.accessToken;
    }
    if (!this.currentRefreshToken) {
      throw new PortUnavailableError("cloudbeds", "falta CLOUDBEDS_REFRESH_TOKEN para renovar el access token");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.CLOUDBEDS_CLIENT_ID ?? "",
      client_secret: process.env.CLOUDBEDS_CLIENT_SECRET ?? "",
      refresh_token: this.currentRefreshToken,
    });
    const payload = await retryWithBackoff(
      async () => {
        const response = await fetch(`${this.baseUrl}${CLOUDBEDS_ROUTE_PATHS.accessToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          throw new PortRateLimitError("cloudbeds", retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined);
        }
        if (!response.ok) {
          throw new Error(`cloudbeds: HTTP ${response.status} renovando access_token`);
        }
        return (await response.json()) as CloudbedsAccessTokenPayload;
      },
      {
        maxAttempts: 3,
        isRetryable: (error) => error instanceof PortRateLimitError,
        retryAfterMs: (error) => (error instanceof PortRateLimitError ? error.retryAfterMs : undefined),
      },
    );
    this.tokenCache = { accessToken: payload.access_token, expiresAtMs: this.now() + payload.expires_in * 1000 };
    if (payload.refresh_token) this.currentRefreshToken = payload.refresh_token;
    return payload.access_token;
  }

  /**
   * Envoltura HTTP real: adjunta el Bearer token vigente + `propertyID`, reintenta con
   * backoff ante `429` (respetando `Retry-After`), mapea `404` a `PortNotFoundError`, y
   * desenvuelve el sobre `{success, data, message}` que Cloudbeds usa en TODAS las
   * respuestas (confirmado en el OpenAPI de cada endpoint) -- `success: false` se trata
   * como error real, nunca como dato valido.
   */
  private async request<T>(
    path: string,
    init: { method?: "GET" | "POST" | "PUT"; params?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    this.assertAvailable();
    const method = init.method ?? "GET";
    const params: Record<string, string> = { propertyID: process.env.CLOUDBEDS_PROPERTY_ID ?? "" };
    for (const [key, value] of Object.entries(init.params ?? {})) {
      if (value !== undefined) params[key] = value;
    }

    return retryWithBackoff(
      async () => {
        const accessToken = await this.getAccessToken();
        const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
        let url = `${this.baseUrl}${path}`;
        let body: string | undefined;
        if (method === "GET") {
          url = `${url}?${new URLSearchParams(params).toString()}`;
        } else {
          headers["Content-Type"] = "application/x-www-form-urlencoded";
          body = new URLSearchParams(params).toString();
        }
        const response = await fetch(url, { method, headers, body });
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          throw new PortRateLimitError("cloudbeds", retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined);
        }
        if (response.status === 404) {
          throw new PortNotFoundError("cloudbeds", path);
        }
        if (!response.ok) {
          throw new Error(`cloudbeds: HTTP ${response.status} en ${path}`);
        }
        const json = (await response.json()) as { success: boolean; data?: T; message?: string | null };
        if (!json.success) {
          throw new Error(`cloudbeds: ${path} respondio success=false: ${json.message ?? "sin mensaje"}`);
        }
        return json.data as T;
      },
      {
        maxAttempts: 4,
        isRetryable: (error) => error instanceof PortRateLimitError,
        retryAfterMs: (error) => (error instanceof PortRateLimitError ? error.retryAfterMs : undefined),
      },
    );
  }

  /**
   * `getReservation`/`getRatePlans` no devuelven `currency` en su respuesta (verificado
   * contra el OpenAPI de ambos endpoints -- a diferencia de `postCharge`, que SI recibe
   * `currency` como entrada nuestra). Se asume la moneda default de la property
   * (`getCurrencySettings.default`), cacheada 5 minutos -- si un hotel operara
   * multi-moneda por reserva esto requeriria revision adicional, no verificada aqui.
   */
  private async getPropertyCurrency(): Promise<string> {
    if (this.currencyCache && this.currencyCache.expiresAtMs > this.now()) {
      return this.currencyCache.code;
    }
    const data = await this.request<{ default: string }>(CLOUDBEDS_ROUTE_PATHS.getCurrencySettings, { method: "GET" });
    this.currencyCache = { code: data.default, expiresAtMs: this.now() + 5 * 60_000 };
    return data.default;
  }

  private async mapReservationPayload(data: CloudbedsReservationPayload): Promise<PmsReservation> {
    const guests = Object.values(data.guestList ?? {});
    const mainGuest = guests.find((g) => g.isMainGuest) ?? guests[0];
    if (!mainGuest) {
      throw new PortValidationError("cloudbeds", `getReservation ${data.reservationID}: guestList vacio`);
    }
    const room = data.assigned?.[0] ?? data.unassigned?.[0];
    if (!room) {
      throw new PortValidationError(
        "cloudbeds",
        `getReservation ${data.reservationID}: sin habitacion asignada ni pendiente -- no se puede derivar roomTypeExternalId`,
      );
    }
    const currency = await this.getPropertyCurrency();
    const status = this.parse(CloudbedsReservationStatus, data.status, `getReservation ${data.reservationID}: status`);
    return this.parse(
      PmsReservation,
      {
        externalReservationId: data.reservationID,
        hotelExternalId: data.propertyID,
        status: mapCloudbedsStatusToDomain(status),
        roomTypeExternalId: room.roomTypeID,
        checkInDate: data.startDate,
        checkOutDate: data.endDate,
        guest: {
          externalGuestId: mainGuest.guestID,
          firstName: mainGuest.guestFirstName,
          lastName: mainGuest.guestLastName,
          email: mainGuest.guestEmail || undefined,
          phone: mainGuest.guestPhone || undefined,
        },
        totalAmount: data.total,
        currency,
        externalVersion: data.dateModified,
      },
      `getReservation ${data.reservationID}: mapeo a PmsReservation`,
    );
  }

  async getReservation(externalReservationId: string): Promise<PmsReservation> {
    const data = await this.request<CloudbedsReservationPayload>(CLOUDBEDS_ROUTE_PATHS.getReservation, {
      method: "GET",
      params: { reservationID: externalReservationId },
    });
    return this.mapReservationPayload(data);
  }

  async listRatePlans(input: { roomTypeExternalId: string; from: string; to: string }): Promise<PmsRatePlan[]> {
    // `getRatePlans` real no pagina (devuelve, para un solo `roomTypeID`, un arreglo con
    // el detalle diario completo del rango pedido en `roomRateDetailed`) -- no aplica
    // `pageNumber`/`pageSize` aqui, a diferencia de los endpoints de listado plural
    // (`getReservations`, `getGuestList`, que SI paginan; ver README de este paquete).
    const currency = await this.getPropertyCurrency();
    const data = await this.request<CloudbedsRatePlanPayload[]>(CLOUDBEDS_ROUTE_PATHS.getRatePlans, {
      method: "GET",
      params: {
        roomTypeID: input.roomTypeExternalId,
        startDate: input.from,
        endDate: input.to,
        detailedRates: "true",
      },
    });
    const plans: PmsRatePlan[] = [];
    for (const rate of data ?? []) {
      for (const detail of rate.roomRateDetailed ?? []) {
        plans.push(
          this.parse(
            PmsRatePlan,
            {
              externalRatePlanId: rate.ratePlanID ?? rate.rateID,
              roomTypeExternalId: input.roomTypeExternalId,
              name: rate.ratePlanNamePublic ?? "Tarifa base",
              currency,
              nightlyRate: detail.rateBase ?? detail.totalRate,
              date: detail.date,
            },
            `getRatePlans ${input.roomTypeExternalId} ${detail.date}: mapeo a PmsRatePlan`,
          ),
        );
      }
    }
    return plans;
  }

  async createCharge(input: CreateChargeInput): Promise<PmsCharge> {
    const { result } = await withIdempotency(this.idempotency, input.idempotencyKey, async () => {
      const data = await this.request<{ paymentID: string }>(CLOUDBEDS_ROUTE_PATHS.postCharge, {
        method: "POST",
        params: {
          reservationID: input.externalReservationId,
          amount: input.amount.toFixed(2),
          currency: input.currency,
          description: input.description,
        },
      });
      return this.parse(
        PmsCharge,
        {
          externalChargeId: data.paymentID,
          externalReservationId: input.externalReservationId,
          amount: input.amount,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
        },
        `postCharge ${input.externalReservationId}: mapeo a PmsCharge`,
      );
    });
    return result;
  }

  /**
   * REQ-QA-003: `putReservation` real no acepta una precondicion tipo `If-Match`
   * (verificado contra su OpenAPI -- no existe ningun parametro de version esperada).
   * La concurrencia optimista la impone ESTE metodo: relee `getReservation` primero y
   * compara `dateModified` (usado como `externalVersion`) contra `expectedVersion`
   * ANTES de escribir -- si no coincide, lanza `PortConflictError` sin llamar a
   * `putReservation`. Tras escribir, vuelve a leer la reserva para devolver la version
   * REAL que Cloudbeds asigno (nunca se asume que coincide con `input.newVersion`: el
   * timestamp de `dateModified` lo pone Cloudbeds, no el llamador).
   */
  async applyReservationUpdate(input: ApplyReservationUpdateInput): Promise<PmsReservation> {
    const current = await this.getReservation(input.externalReservationId);
    if (current.externalVersion !== input.expectedVersion) {
      throw new PortConflictError(
        "cloudbeds",
        `reservation ${input.externalReservationId}`,
        input.expectedVersion,
        current.externalVersion,
      );
    }
    await this.request(CLOUDBEDS_ROUTE_PATHS.putReservation, {
      method: "PUT",
      params: {
        reservationID: input.externalReservationId,
        status: mapDomainStatusToCloudbeds(input.status),
      },
    });
    return this.getReservation(input.externalReservationId);
  }

  async updateHousekeepingStatus(input: UpdateHousekeepingInput): Promise<PmsRoomStatus> {
    const nativeStatus = mapDomainRoomStatusToCloudbeds(input.status);
    if (nativeStatus === "out_of_order") {
      // `postHousekeepingStatus.roomCondition` real solo acepta dirty|clean|inspected
      // (verificado contra su OpenAPI) -- "fuera de servicio" en Cloudbeds se modela
      // como un ROOM BLOCK (`POST /postRoomBlock`), un recurso distinto que este metodo
      // no cubre. Se documenta el limite en vez de fingir un mapeo que la API real no
      // ofrece.
      throw new PortValidationError(
        "cloudbeds",
        "'fuera_de_servicio' requiere /postRoomBlock (room block), no postHousekeepingStatus -- fuera del alcance de updateHousekeepingStatus",
      );
    }
    const data = await this.request<CloudbedsHousekeepingStatusPayload>(CLOUDBEDS_ROUTE_PATHS.postHousekeepingStatus, {
      method: "POST",
      params: { roomID: input.roomExternalId, roomCondition: nativeStatus },
    });
    const status = this.parse(
      CloudbedsRoomStatus,
      data.roomCondition,
      `postHousekeepingStatus ${input.roomExternalId}: roomCondition`,
    );
    return this.parse(
      PmsRoomStatus,
      {
        roomExternalId: data.roomID,
        status: mapCloudbedsRoomStatusToDomain(status),
        // Cloudbeds devuelve solo la FECHA (no hora) del ultimo cambio de condicion --
        // se usa el instante real de esta llamada (que ocurre ese mismo dia) en vez de
        // sintetizar una medianoche ficticia para cumplir el `datetime` del puerto.
        updatedAt: new Date(this.now()).toISOString(),
      },
      `postHousekeepingStatus ${input.roomExternalId}: mapeo a PmsRoomStatus`,
    );
  }

  async getGuestProfile(externalGuestId: string): Promise<PmsGuestProfile> {
    const data = await this.request<CloudbedsGuestPayload>(CLOUDBEDS_ROUTE_PATHS.getGuest, {
      method: "GET",
      params: { guestID: externalGuestId },
    });
    // `getGuest` real no reecha el `guestID` en su respuesta (verificado contra su
    // OpenAPI: `GetGuestResponse.data` no tiene campo `guestID`) -- se reusa el id de
    // entrada, que es exactamente el que el llamador ya conoce.
    return this.parse(
      PmsGuestProfile,
      {
        externalGuestId,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email || undefined,
        phone: data.phone || undefined,
      },
      `getGuest ${externalGuestId}: mapeo a PmsGuestProfile`,
    );
  }

  /**
   * [LIMITACION DOCUMENTADA -- verificado contra developers.cloudbeds.com/docs/webhooks-1,
   * 2026-09-09] Cloudbeds NO firma sus webhooks con HMAC: su documentacion publica no
   * define ningun header de firma (a diferencia de Meta/Stripe, que si lo hacen y que
   * inspiraron el contrato `verifyAndNormalizeWebhook(rawBody, signatureHeader)` de
   * `PmsPort`). El unico mecanismo de autenticidad nativo que Cloudbeds ofrece es la
   * discrecion de la URL registrada via `POST /postWebhook` (opcionalmente con un query
   * param propio, ej. `?secret=...&propertyID=...` -- ver seccion "Subscribing to
   * events" de esa doc).
   *
   * Este metodo MANTIENE la verificacion HMAC contra `CLOUDBEDS_WEBHOOK_SECRET` porque
   * (a) el contrato `PmsPort` la exige (mismo patron fail-closed que el adaptador de
   * WhatsApp/Meta) y (b) exigir un secreto compartido en la URL de suscripcion y
   * verificarlo aqui SIGUE siendo una defensa real (un tercero que no conozca el
   * secreto no puede producir un `signatureHeader` valido) -- pero ese secreto y su
   * firma son una CONVENCION DE ESTE REPO, nunca algo que Cloudbeds calcule o envie:
   * quien exponga la ruta HTTP publica (apps/api) debe construir `signatureHeader` a
   * partir de ese mismo secreto compartido al recibir el POST (o extraerlo del query
   * param con el que se registro la URL), no esperar que venga ya puesto por Cloudbeds.
   * Documentado explicitamente para no fingir una garantia de autenticidad nativa que el
   * proveedor no ofrece.
   */
  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<PmsWebhookEvent> {
    if (!this.webhookCredentials.available) {
      throw new PortUnavailableError(
        "cloudbeds",
        `faltan variables de entorno: ${this.webhookCredentials.missing.join(", ")}`,
      );
    }
    const secret = process.env.CLOUDBEDS_WEBHOOK_SECRET as string;
    if (!verifyHmacSignature(rawBody, signatureHeader, secret)) {
      throw new WebhookSignatureError("cloudbeds");
    }
    let payload: CloudbedsWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as CloudbedsWebhookPayload;
    } catch {
      throw new WebhookSignatureError("cloudbeds");
    }
    const normalized = normalizeCloudbedsWebhookPayload(payload);
    if (this.replayGuard.seenBefore(normalized.eventId)) {
      throw new WebhookReplayError("cloudbeds", normalized.eventId);
    }
    return normalized;
  }
}
