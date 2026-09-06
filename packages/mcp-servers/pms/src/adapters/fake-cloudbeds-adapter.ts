/**
 * `FakeCloudbedsAdapter` -- implementación simulada de `PmsPort`, etiquetada
 * explícitamente (`simulated: true`). Usada por la prueba de contrato compartida y por
 * desarrollo local sin credenciales. Los fixtures reproducen la forma documentada de la
 * respuesta pública de Cloudbeds (`docs/referencia/03-investigacion-H12-H21.md` §5), no
 * una grabación real de producción -- señalado como tal en README.md.
 */
import {
  PortNotFoundError,
  WebhookSignatureError,
  WebhookReplayError,
  InMemoryIdempotencyStore,
  InMemoryReplayGuard,
  signHmac,
  verifyHmacSignature,
  type AdapterStatus,
} from "@atiende-hoteles/mcp-shared";
import {
  mapCloudbedsStatusToDomain,
  mapCloudbedsRoomStatusToDomain,
  mapDomainRoomStatusToCloudbeds,
  type PmsPort,
  type PmsReservation,
  type PmsRatePlan,
  type CreateChargeInput,
  type PmsCharge,
  type UpdateHousekeepingInput,
  type PmsRoomStatus,
  type PmsGuestProfile,
  type PmsWebhookEvent,
} from "../port.ts";

/** Secreto fijo de pruebas -- NUNCA usar en un entorno real. */
export const FAKE_CLOUDBEDS_WEBHOOK_SECRET = "test-secret-cloudbeds-simulado";

interface FakeReservationRecord {
  externalReservationId: string;
  hotelExternalId: string;
  status: "not_confirmed" | "confirmed" | "canceled" | "checked_in" | "checked_out" | "no_show" | "pending";
  roomTypeExternalId: string;
  checkInDate: string;
  checkOutDate: string;
  guest: PmsGuestProfile;
  totalAmount: number;
  currency: string;
  externalVersion: string;
}

const FIXTURE_RESERVATIONS: FakeReservationRecord[] = [
  {
    externalReservationId: "CB-RES-1001",
    hotelExternalId: "CB-HOTEL-01",
    status: "confirmed",
    roomTypeExternalId: "CB-RT-STD",
    checkInDate: "2026-09-10",
    checkOutDate: "2026-09-13",
    guest: {
      externalGuestId: "CB-GUEST-500",
      firstName: "Renata",
      lastName: "Solis",
      email: "renata.solis@example.com",
      phone: "+5219981234567",
    },
    totalAmount: 4500,
    currency: "MXN",
    externalVersion: "v1",
  },
  {
    externalReservationId: "CB-RES-1002",
    hotelExternalId: "CB-HOTEL-01",
    status: "checked_in",
    roomTypeExternalId: "CB-RT-SUITE",
    checkInDate: "2026-09-06",
    checkOutDate: "2026-09-09",
    guest: {
      externalGuestId: "CB-GUEST-501",
      firstName: "Iker",
      lastName: "Beltran",
      email: "iker.beltran@example.com",
    },
    totalAmount: 9800,
    currency: "MXN",
    externalVersion: "v3",
  },
];

const FIXTURE_RATE_PLANS: PmsRatePlan[] = [
  {
    externalRatePlanId: "CB-RP-STD-FLEX",
    roomTypeExternalId: "CB-RT-STD",
    name: "Tarifa flexible",
    currency: "MXN",
    nightlyRate: 1500,
    date: "2026-09-10",
  },
  {
    externalRatePlanId: "CB-RP-STD-FLEX",
    roomTypeExternalId: "CB-RT-STD",
    name: "Tarifa flexible",
    currency: "MXN",
    nightlyRate: 1500,
    date: "2026-09-11",
  },
];

export class FakeCloudbedsAdapter implements PmsPort {
  readonly simulated = true as const;
  private readonly reservations = new Map<string, FakeReservationRecord>(
    FIXTURE_RESERVATIONS.map((r) => [r.externalReservationId, { ...r }]),
  );
  private readonly roomStatuses = new Map<string, PmsRoomStatus>();
  private readonly chargeIdempotency = new InMemoryIdempotencyStore<PmsCharge>();
  private readonly replayGuard = new InMemoryReplayGuard();
  private chargeSequence = 0;

  /** Solo para pruebas: cuántas veces se "llamó al proveedor" realmente (sin contar replays). */
  chargeCallCount = 0;

  constructor(private readonly webhookSecret: string = FAKE_CLOUDBEDS_WEBHOOK_SECRET) {}

  status(): AdapterStatus {
    return { provider: "cloudbeds", available: true, simulated: true };
  }

  async getReservation(externalReservationId: string): Promise<PmsReservation> {
    const record = this.reservations.get(externalReservationId);
    if (!record) throw new PortNotFoundError("cloudbeds", `reservation ${externalReservationId}`);
    return {
      externalReservationId: record.externalReservationId,
      hotelExternalId: record.hotelExternalId,
      status: mapCloudbedsStatusToDomain(record.status),
      roomTypeExternalId: record.roomTypeExternalId,
      checkInDate: record.checkInDate,
      checkOutDate: record.checkOutDate,
      guest: record.guest,
      totalAmount: record.totalAmount,
      currency: record.currency,
      externalVersion: record.externalVersion,
    };
  }

  async listRatePlans(input: { roomTypeExternalId: string; from: string; to: string }): Promise<PmsRatePlan[]> {
    return FIXTURE_RATE_PLANS.filter(
      (rp) =>
        rp.roomTypeExternalId === input.roomTypeExternalId &&
        rp.date >= input.from &&
        rp.date <= input.to,
    );
  }

  async createCharge(input: CreateChargeInput): Promise<PmsCharge> {
    const existing = this.chargeIdempotency.get(input.idempotencyKey);
    if (existing) return existing;
    this.chargeCallCount += 1;
    this.chargeSequence += 1;
    const charge: PmsCharge = {
      externalChargeId: `CB-CHG-${this.chargeSequence}`,
      externalReservationId: input.externalReservationId,
      amount: input.amount,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
    };
    this.chargeIdempotency.set(input.idempotencyKey, charge);
    return charge;
  }

  async updateHousekeepingStatus(input: UpdateHousekeepingInput): Promise<PmsRoomStatus> {
    // round-trip por el mapeo nativo para probar que la traducción dominio<->PMS es consistente
    const nativeStatus = mapDomainRoomStatusToCloudbeds(input.status);
    const status: PmsRoomStatus = {
      roomExternalId: input.roomExternalId,
      status: mapCloudbedsRoomStatusToDomain(nativeStatus),
      updatedAt: new Date().toISOString(),
    };
    this.roomStatuses.set(input.roomExternalId, status);
    return status;
  }

  async getGuestProfile(externalGuestId: string): Promise<PmsGuestProfile> {
    const found = [...this.reservations.values()].find((r) => r.guest.externalGuestId === externalGuestId);
    if (!found) throw new PortNotFoundError("cloudbeds", `guest ${externalGuestId}`);
    return found.guest;
  }

  async verifyAndNormalizeWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<PmsWebhookEvent> {
    if (!verifyHmacSignature(rawBody, signatureHeader, this.webhookSecret)) {
      throw new WebhookSignatureError("cloudbeds");
    }
    const payload = JSON.parse(rawBody) as {
      event_id: string;
      event_type: PmsWebhookEvent["type"];
      reservation_id?: string;
      room_id?: string;
      occurred_at: string;
    };
    if (this.replayGuard.seenBefore(payload.event_id)) {
      throw new WebhookReplayError("cloudbeds", payload.event_id);
    }
    return {
      eventId: payload.event_id,
      type: payload.event_type,
      externalReservationId: payload.reservation_id,
      roomExternalId: payload.room_id,
      occurredAt: payload.occurred_at,
      raw: payload,
    };
  }

  /** Helper de pruebas: construye un payload de webhook y su firma HMAC válida. */
  static signWebhookFixture(
    payload: Record<string, unknown>,
    secret: string = FAKE_CLOUDBEDS_WEBHOOK_SECRET,
  ): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(payload);
    return { rawBody, signature: signHmac(rawBody, secret) };
  }
}
