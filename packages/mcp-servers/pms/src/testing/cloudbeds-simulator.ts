/**
 * Simulador HTTP local del contrato PUBLICO documentado de Cloudbeds API v1.3 (mismas
 * rutas, forma de request/response y sobre `{success, data, message}` que
 * `cloudbeds-adapter.ts` consume -- ver el docstring de ese archivo para las fuentes
 * exactas consultadas). Sirve para probar de VERDAD el codigo del adaptador real (auth
 * OAuth2 con renovacion, parseo de campos, manejo de 429/404, idempotencia, concurrencia
 * optimista) sin red real ni credenciales de Cloudbeds -- nunca sustituye una prueba
 * contra el sandbox real (`CloudbedsAdapter (real, requiere credenciales)` en
 * contract.spec.ts sigue siendo la unica que valida eso, y sigue en skip sin
 * credenciales).
 *
 * [SIMULADO, NO VERIFICADO CONTRA CLOUDBEDS REAL] Dos decisiones de este simulador NO
 * estan confirmadas por la documentacion publica (que no las especifica) y son
 * SUPOSICIONES razonables, marcadas aqui explicitamente:
 *   1. HTTP status de una reserva/guest inexistente: se usa 404 (patron REST comun,
 *      igual que el resto de adaptadores de este repo) -- Cloudbeds podria en realidad
 *      responder 200 con `success:false`, no hay forma de confirmarlo sin credenciales
 *      reales.
 *   2. Formato exacto del error 429: se copia el patron `Retry-After` en segundos
 *      (estandar HTTP, usado por el resto del repo) -- no confirmado especificamente
 *      para Cloudbeds.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface CloudbedsSimulatorReservationFixture {
  reservationID: string;
  propertyID: string;
  status: string;
  startDate: string;
  endDate: string;
  total: number;
  dateModified: string;
  roomTypeID: string;
  guest: { guestID: string; firstName: string; lastName: string; email?: string; phone?: string };
}

export interface CloudbedsSimulatorOptions {
  clientId?: string;
  clientSecret?: string;
  /** Refresh token inicial valido. Rota en cada renovacion (mismo comportamiento real
   *  documentado) -- `currentRefreshToken()` expone el vigente para que la prueba pueda
   *  seguirlo si quiere. */
  initialRefreshToken?: string;
  propertyId?: string;
  defaultCurrency?: string;
  accessTokenTtlSeconds?: number;
  reservations?: CloudbedsSimulatorReservationFixture[];
}

/** Servidor HTTP real (en localhost, puerto efimero) que imita Cloudbeds v1.3. */
export class CloudbedsSimulator {
  private server: Server | null = null;
  private port = 0;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private refreshToken: string;
  private readonly propertyId: string;
  private readonly defaultCurrency: string;
  private readonly accessTokenTtlSeconds: number;
  private currentAccessToken: string | null = null;
  private readonly reservations: Map<string, CloudbedsSimulatorReservationFixture>;
  private readonly roomConditions = new Map<string, "dirty" | "clean" | "inspected">();
  private paymentSequence = 0;
  /** Cuando > 0, la PROXIMA llamada a cualquier ruta autenticada responde 429 y
   *  decrementa el contador -- usado para probar `retryWithBackoff` de verdad. */
  private forcedRateLimitCount = 0;
  /** Llamadas reales recibidas por ruta (para aserciones de "se reintento N veces"). */
  readonly requestLog: { method: string; path: string }[] = [];

  constructor(options: CloudbedsSimulatorOptions = {}) {
    this.clientId = options.clientId ?? "sim-client-id";
    this.clientSecret = options.clientSecret ?? "sim-client-secret";
    this.refreshToken = options.initialRefreshToken ?? "sim-refresh-token-1";
    this.propertyId = options.propertyId ?? "SIM-PROPERTY-1";
    this.defaultCurrency = options.defaultCurrency ?? "MXN";
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600;
    this.reservations = new Map(
      (
        options.reservations ?? [
          {
            reservationID: "SIM-RES-1",
            propertyID: this.propertyId,
            status: "confirmed",
            startDate: "2026-10-10",
            endDate: "2026-10-13",
            total: 4500,
            dateModified: "2026-09-01T10:00:00Z",
            roomTypeID: "SIM-RT-STD",
            guest: { guestID: "SIM-GUEST-1", firstName: "Ana", lastName: "Reyes", email: "ana@example.com" },
          },
        ]
      ).map((r) => [r.reservationID, { ...r }]),
    );
  }

  currentRefreshToken(): string {
    return this.refreshToken;
  }

  forceRateLimitOnce(times = 1): void {
    this.forcedRateLimitCount += times;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("cloudbeds-simulator: no se pudo obtener el puerto");
    this.port = address.port;
    return this.url();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((err) => (err ? reject(err) : resolve())));
    this.server = null;
  }

  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
  }

  private requireBearer(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    return !!auth && !!this.currentAccessToken && auth === `Bearer ${this.currentAccessToken}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url() || "http://127.0.0.1");
    const path = url.pathname;
    this.requestLog.push({ method: req.method ?? "GET", path });

    if (path === "/access_token" && req.method === "POST") {
      return this.handleAccessToken(req, res);
    }

    // Toda ruta que no sea /access_token requiere Bearer valido + limite de tasa
    // simulado ANTES de cualquier logica de negocio (mismo orden que un backend real).
    if (this.forcedRateLimitCount > 0) {
      this.forcedRateLimitCount -= 1;
      res.setHeader("Retry-After", "0");
      return this.json(res, 429, { success: false, message: "rate limited (simulado)" });
    }
    if (!this.requireBearer(req)) {
      return this.json(res, 401, { success: false, message: "token invalido o ausente" });
    }

    if (path === "/getReservation" && req.method === "GET") return this.handleGetReservation(url, res);
    if (path === "/getRatePlans" && req.method === "GET") return this.handleGetRatePlans(url, res);
    if (path === "/postCharge" && req.method === "POST") return this.handlePostCharge(req, res);
    if (path === "/putReservation" && req.method === "PUT") return this.handlePutReservation(req, res);
    if (path === "/postHousekeepingStatus" && req.method === "POST") return this.handlePostHousekeeping(req, res);
    if (path === "/getGuest" && req.method === "GET") return this.handleGetGuest(url, res);
    if (path === "/getCurrencySettings" && req.method === "GET") {
      return this.json(res, 200, { success: true, data: { default: this.defaultCurrency, acceptable: [this.defaultCurrency] } });
    }

    return this.json(res, 404, { success: false, message: `ruta no soportada por el simulador: ${path}` });
  }

  private async handleAccessToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.readBody(req);
    const form = new URLSearchParams(raw);
    if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret) {
      return this.json(res, 401, { error: "invalid_client" });
    }
    if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== this.refreshToken) {
      return this.json(res, 400, { error: "invalid_grant" });
    }
    this.currentAccessToken = `sim-access-${randomUUID()}`;
    // Rotacion de refresh_token (documentada como posible en la doc real de
    // access_token) -- el simulador SIEMPRE rota, para forzar que el adaptador la
    // maneje en vez de asumir que el refresh_token nunca cambia.
    this.refreshToken = `sim-refresh-token-${randomUUID()}`;
    this.json(res, 200, {
      access_token: this.currentAccessToken,
      token_type: "bearer",
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: this.refreshToken,
      resources: [{ type: "property", id: this.propertyId }],
    });
  }

  private handleGetReservation(url: URL, res: ServerResponse): void {
    const id = url.searchParams.get("reservationID");
    const record = id ? this.reservations.get(id) : undefined;
    if (!record) return this.json(res, 404, { success: false, message: "reservation not found" });
    this.json(res, 200, {
      success: true,
      data: {
        propertyID: record.propertyID,
        reservationID: record.reservationID,
        status: record.status,
        startDate: record.startDate,
        endDate: record.endDate,
        total: record.total,
        dateModified: record.dateModified,
        // OJO: `guestList` (dentro de getReservation) usa los nombres de campo
        // `guestFirstName`/`guestLastName`/`guestEmail`/`guestPhone` -- DISTINTOS de
        // `getGuest` (que usa `firstName`/`lastName`/`email`/`phone`, ver
        // `handleGetGuest` mas abajo). Confirmado contra el OpenAPI real de ambos
        // endpoints: son dos formas de nombrar al mismo guest en dos respuestas
        // distintas, no un typo de este simulador.
        guestList: {
          [record.guest.guestID]: {
            guestID: record.guest.guestID,
            guestFirstName: record.guest.firstName,
            guestLastName: record.guest.lastName,
            guestEmail: record.guest.email,
            guestPhone: record.guest.phone,
            isMainGuest: true,
          },
        },
        assigned: [{ roomTypeID: record.roomTypeID }],
        unassigned: [],
      },
    });
  }

  private handleGetRatePlans(url: URL, res: ServerResponse): void {
    const roomTypeID = url.searchParams.get("roomTypeID") ?? "SIM-RT-STD";
    const startDate = url.searchParams.get("startDate")!;
    const endDate = url.searchParams.get("endDate")!;
    const dates: string[] = [];
    for (let d = new Date(`${startDate}T00:00:00Z`); d <= new Date(`${endDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    this.json(res, 200, {
      success: true,
      data: [
        {
          rateID: "SIM-RATE-1",
          ratePlanID: "SIM-RP-FLEX",
          ratePlanNamePublic: "Tarifa flexible (simulada)",
          roomRateDetailed: dates.map((date) => ({ date, rateBase: 1500, totalRate: 1500 })),
        },
      ],
      roomTypeID,
    });
  }

  private async handlePostCharge(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.readBody(req);
    this.paymentSequence += 1;
    this.json(res, 200, {
      success: true,
      data: { paymentID: `SIM-PAY-${this.paymentSequence}`, transactionID: `SIM-TXN-${this.paymentSequence}`, paymentStatus: "succeeded", paymentType: "cards" },
    });
  }

  private async handlePutReservation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.readBody(req);
    const form = new URLSearchParams(raw);
    const id = form.get("reservationID");
    const record = id ? this.reservations.get(id) : undefined;
    if (!record) return this.json(res, 404, { success: false, message: "reservation not found" });
    const status = form.get("status");
    if (status) record.status = status;
    record.dateModified = new Date().toISOString();
    this.json(res, 200, { success: true, data: null });
  }

  private async handlePostHousekeeping(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.readBody(req);
    const form = new URLSearchParams(raw);
    const roomID = form.get("roomID") ?? "";
    const roomCondition = (form.get("roomCondition") ?? "clean") as "dirty" | "clean" | "inspected";
    this.roomConditions.set(roomID, roomCondition);
    this.json(res, 200, {
      success: true,
      data: { date: new Date().toISOString().slice(0, 10), roomID, roomCondition },
    });
  }

  private handleGetGuest(url: URL, res: ServerResponse): void {
    const guestId = url.searchParams.get("guestID");
    const reservationId = url.searchParams.get("reservationID");
    let match: CloudbedsSimulatorReservationFixture["guest"] | undefined;
    for (const record of this.reservations.values()) {
      if (record.guest.guestID === guestId || record.reservationID === reservationId) {
        match = record.guest;
        break;
      }
    }
    if (!match) return this.json(res, 404, { success: false, message: "guest not found" });
    this.json(res, 200, { success: true, data: { firstName: match.firstName, lastName: match.lastName, email: match.email, phone: match.phone } });
  }
}
