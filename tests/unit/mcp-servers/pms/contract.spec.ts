// Prueba de contrato de PmsPort (REQ-INT-001). Corre siempre contra FakeCloudbedsAdapter
// (fixtures realistas de la forma pública documentada de Cloudbeds); contra
// CloudbedsAdapter (real) solo si hay credenciales -- se salta explícitamente, nunca
// finge verde. Ver docs/ACEPTACION.md fila REQ-INT-001.
import { describe, expect, it } from "vitest";
import {
  CloudbedsAdapter,
  FakeCloudbedsAdapter,
  mapCloudbedsStatusToDomain,
  mapDomainStatusToCloudbeds,
  PmsReservation,
  type PmsPort,
} from "@atiende-hoteles/mcp-pms";
import { PortNotFoundError, PortUnavailableError, WebhookSignatureError, WebhookReplayError } from "@atiende-hoteles/mcp-shared";

const realAdapter = new CloudbedsAdapter();
const realCredentialsAvailable = realAdapter.status().available;

describe("mapeo de estados Cloudbeds <-> dominio", () => {
  it("mapea los 7 estados nativos de Cloudbeds a un estado de dominio válido", () => {
    expect(mapCloudbedsStatusToDomain("not_confirmed")).toBe("cotizada");
    expect(mapCloudbedsStatusToDomain("pending")).toBe("cotizada");
    expect(mapCloudbedsStatusToDomain("confirmed")).toBe("confirmada");
    expect(mapCloudbedsStatusToDomain("checked_in")).toBe("en_estancia");
    expect(mapCloudbedsStatusToDomain("checked_out")).toBe("check_out");
    expect(mapCloudbedsStatusToDomain("canceled")).toBe("cancelada");
    expect(mapCloudbedsStatusToDomain("no_show")).toBe("no_show");
  });

  it("el mapeo inverso reproduce el estado nativo original para los estados con equivalente", () => {
    expect(mapDomainStatusToCloudbeds("confirmada")).toBe("confirmed");
    expect(mapDomainStatusToCloudbeds("en_estancia")).toBe("checked_in");
    expect(mapDomainStatusToCloudbeds("cancelada")).toBe("canceled");
  });

  it("'cerrada' (solo interno, post-checkout) no tiene equivalente nativo -- lanza en vez de inventar uno", () => {
    expect(() => mapDomainStatusToCloudbeds("cerrada")).toThrow();
  });
});

/** Suite de contrato reutilizable contra cualquier implementación de `PmsPort`. */
function runPmsPortContract(label: string, getPort: () => PmsPort) {
  describe(`contrato PmsPort -- ${label}`, () => {
    // contrato-capacidad-pms: cloudbeds:getReservation
    it("getReservation retorna una reserva válida contra el esquema Zod", async () => {
      const reservation = await getPort().getReservation("CB-RES-1001");
      expect(() => PmsReservation.parse(reservation)).not.toThrow();
      expect(reservation.status).toBe("confirmada");
    });

    it("getReservation de un id desconocido lanza PortNotFoundError", async () => {
      await expect(getPort().getReservation("NO-EXISTE")).rejects.toBeInstanceOf(PortNotFoundError);
    });

    // contrato-capacidad-pms: cloudbeds:createCharge
    it("createCharge es idempotente: la misma clave no genera un segundo cargo", async () => {
      const port = getPort() as FakeCloudbedsAdapter;
      const input = {
        externalReservationId: "CB-RES-1001",
        description: "Consumo minibar",
        amount: 250,
        currency: "MXN",
        idempotencyKey: "idem-charge-1",
      };
      const first = await port.createCharge(input);
      const second = await port.createCharge(input);
      expect(second.externalChargeId).toBe(first.externalChargeId);
      expect(port.chargeCallCount).toBe(1);
    });

    // contrato-capacidad-pms: cloudbeds:updateHousekeepingStatus
    it("updateHousekeepingStatus hace el round-trip dominio -> nativo -> dominio de forma consistente", async () => {
      const status = await getPort().updateHousekeepingStatus({ roomExternalId: "CB-ROOM-101", status: "limpia" });
      expect(status.status).toBe("limpia");
    });
  });
}

runPmsPortContract("FakeCloudbedsAdapter (simulado)", () => new FakeCloudbedsAdapter());

describe.skipIf(!realCredentialsAvailable)("contrato PmsPort -- CloudbedsAdapter (real, requiere credenciales)", () => {
  it("se salta si no hay credenciales; corre igual que el fake si las hay", async () => {
    const reservation = await realAdapter.getReservation("CB-RES-1001");
    expect(() => PmsReservation.parse(reservation)).not.toThrow();
  });
});

describe("CloudbedsAdapter (real) sin credenciales -- declaración honesta", () => {
  it("status() reporta unavailable con la razón exacta cuando faltan credenciales", () => {
    if (realCredentialsAvailable) return; // entorno con credenciales reales, no aplica esta aserción
    const status = realAdapter.status();
    expect(status.available).toBe(false);
    expect(status.simulated).toBe(false);
    expect(status.reason).toMatch(/PENDIENTE DE CREDENCIALES/);
  });

  it("getReservation lanza PortUnavailableError en vez de inventar una reserva", async () => {
    if (realCredentialsAvailable) return;
    await expect(realAdapter.getReservation("CB-RES-1001")).rejects.toBeInstanceOf(PortUnavailableError);
  });
});

// Forma REAL del payload de webhook (docs/webhooks-1, ver cloudbeds-adapter.ts): un
// campo `event` combinado ("entidad/accion"), `timestamp` unix (con microsegundos) y
// SIN id de deduplicación propio -- ya no se usan los campos ficticios
// `event_id`/`event_type`/`occurred_at` de la versión anterior de este archivo.
describe("webhook de Cloudbeds -- firma HMAC + replay", () => {
  // contrato-capacidad-pms: cloudbeds:verifyAndNormalizeWebhook
  it("firma válida se acepta y normaliza el evento", async () => {
    const fake = new FakeCloudbedsAdapter();
    const { rawBody, signature } = FakeCloudbedsAdapter.signWebhookFixture({
      version: "1.0",
      event: "reservation/status_changed",
      timestamp: 1735000000.123456,
      propertyID: "CB-HOTEL-01",
      reservationID: "CB-RES-1001",
      status: "confirmed",
    });
    const event = await fake.verifyAndNormalizeWebhook(rawBody, signature);
    expect(event.eventId).toBe("reservation/status_changed:CB-HOTEL-01:CB-RES-1001:1735000000.123456");
    expect(event.type).toBe("reservation.updated");
    expect(event.externalReservationId).toBe("CB-RES-1001");
  });

  it("un evento reservation/status_changed con status=canceled se normaliza a reservation.canceled", async () => {
    const fake = new FakeCloudbedsAdapter();
    const { rawBody, signature } = FakeCloudbedsAdapter.signWebhookFixture({
      version: "1.0",
      event: "reservation/status_changed",
      timestamp: 1735000001,
      propertyID: "CB-HOTEL-01",
      reservationID: "CB-RES-1002",
      status: "canceled",
    });
    const event = await fake.verifyAndNormalizeWebhook(rawBody, signature);
    expect(event.type).toBe("reservation.canceled");
  });

  it("firma inválida se rechaza (WebhookSignatureError), nunca procesa el payload", async () => {
    const fake = new FakeCloudbedsAdapter();
    const { rawBody } = FakeCloudbedsAdapter.signWebhookFixture({
      version: "1.0",
      event: "reservation/status_changed",
      timestamp: 1735000002,
      propertyID: "CB-HOTEL-01",
      reservationID: "CB-RES-1001",
      status: "confirmed",
    });
    await expect(fake.verifyAndNormalizeWebhook(rawBody, "sha256=firma-invalida")).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });

  it("firma ausente se rechaza", async () => {
    const fake = new FakeCloudbedsAdapter();
    const { rawBody } = FakeCloudbedsAdapter.signWebhookFixture({
      version: "1.0",
      event: "reservation/status_changed",
      timestamp: 1735000003,
      propertyID: "CB-HOTEL-01",
      reservationID: "CB-RES-1001",
      status: "confirmed",
    });
    await expect(fake.verifyAndNormalizeWebhook(rawBody, undefined)).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("un evento no reconocido por el puerto se rechaza en vez de normalizarse a ciegas", async () => {
    const fake = new FakeCloudbedsAdapter();
    const { rawBody, signature } = FakeCloudbedsAdapter.signWebhookFixture({
      version: "1.0",
      event: "accounting/transaction",
      timestamp: 1735000004,
      propertyID: "CB-HOTEL-01",
    });
    await expect(fake.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toThrow();
  });

  it("la misma entrega repetida (mismo evento/entidad/timestamp) se rechaza como replay", async () => {
    const fake = new FakeCloudbedsAdapter();
    const { rawBody, signature } = FakeCloudbedsAdapter.signWebhookFixture({
      version: "1.0",
      event: "housekeeping/room_condition_changed",
      timestamp: 1735000005,
      propertyID: "CB-HOTEL-01",
      roomId: "CB-ROOM-101",
    });
    const first = await fake.verifyAndNormalizeWebhook(rawBody, signature);
    expect(first.type).toBe("room.status_changed");
    expect(first.roomExternalId).toBe("CB-ROOM-101");
    await expect(fake.verifyAndNormalizeWebhook(rawBody, signature)).rejects.toBeInstanceOf(WebhookReplayError);
  });
});
