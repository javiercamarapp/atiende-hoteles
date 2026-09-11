// Corre el adaptador REAL (`CloudbedsAdapter`, no el Fake) contra
// `cloudbeds-simulator.ts` -- un servidor HTTP real en localhost que imita el contrato
// PUBLICO documentado de Cloudbeds v1.3 (ver docstrings de ambos archivos). A diferencia
// del bloque `describe.skipIf(!realCredentialsAvailable)` de contract.spec.ts (que
// necesita credenciales REALES de Cloudbeds y por eso sigue en skip), esta suite corre
// SIEMPRE -- prueba que el codigo del adaptador (OAuth2 con renovacion y rotacion de
// refresh_token, parseo de campos, reintentos ante 429, 404 -> PortNotFoundError,
// idempotencia, concurrencia optimista) funciona de verdad contra ESE contrato, sin
// necesitar red real ni credenciales de Cloudbeds.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloudbedsAdapter, PmsReservation } from "@atiende-hoteles/mcp-pms";
import { PortConflictError, PortNotFoundError, PortValidationError } from "@atiende-hoteles/mcp-shared";
import { CloudbedsSimulator } from "../../../../packages/mcp-servers/pms/src/testing/cloudbeds-simulator.ts";

const ENV_KEYS = [
  "CLOUDBEDS_CLIENT_ID",
  "CLOUDBEDS_CLIENT_SECRET",
  "CLOUDBEDS_REFRESH_TOKEN",
  "CLOUDBEDS_PROPERTY_ID",
  "CLOUDBEDS_WEBHOOK_SECRET",
] as const;

describe("CloudbedsAdapter (real) contra el simulador local", () => {
  let simulator: CloudbedsSimulator;
  let baseUrl: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    simulator = new CloudbedsSimulator({
      clientId: "sim-client-id",
      clientSecret: "sim-client-secret",
      initialRefreshToken: "sim-refresh-token-1",
      propertyId: "SIM-PROPERTY-1",
      defaultCurrency: "MXN",
    });
    baseUrl = await simulator.start();
  });

  afterAll(async () => {
    await simulator.stop();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  beforeEach(() => {
    process.env.CLOUDBEDS_CLIENT_ID = "sim-client-id";
    process.env.CLOUDBEDS_CLIENT_SECRET = "sim-client-secret";
    process.env.CLOUDBEDS_REFRESH_TOKEN = simulator.currentRefreshToken();
    process.env.CLOUDBEDS_PROPERTY_ID = "SIM-PROPERTY-1";
    process.env.CLOUDBEDS_WEBHOOK_SECRET = "sim-webhook-secret";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("status() reporta available:true cuando las 4 variables OAuth estan presentes", () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    expect(adapter.status()).toEqual({ provider: "cloudbeds", available: true, simulated: false });
  });

  it("getReservation hace el flujo OAuth completo (access_token + getReservation + getCurrencySettings) y mapea al contrato", async () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    const reservation = await adapter.getReservation("SIM-RES-1");
    expect(() => PmsReservation.parse(reservation)).not.toThrow();
    expect(reservation.status).toBe("confirmada");
    expect(reservation.roomTypeExternalId).toBe("SIM-RT-STD");
    expect(reservation.currency).toBe("MXN");
    expect(reservation.guest.firstName).toBe("Ana");
  });

  it("getReservation de un id desconocido lanza PortNotFoundError (simulador responde 404)", async () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    await expect(adapter.getReservation("NO-EXISTE")).rejects.toBeInstanceOf(PortNotFoundError);
  });

  // contrato-capacidad-pms: cloudbeds:listRatePlans
  it("listRatePlans devuelve una tarifa por cada fecha del rango, con la moneda default de la property", async () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    const plans = await adapter.listRatePlans({ roomTypeExternalId: "SIM-RT-STD", from: "2026-10-10", to: "2026-10-12" });
    expect(plans).toHaveLength(3);
    expect(plans.every((p) => p.currency === "MXN" && p.nightlyRate === 1500)).toBe(true);
    expect(plans.map((p) => p.date)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
  });

  it("createCharge es idempotente: la segunda llamada con la misma clave NO vuelve a golpear /postCharge", async () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    const input = {
      externalReservationId: "SIM-RES-1",
      description: "Consumo minibar",
      amount: 250,
      currency: "MXN",
      idempotencyKey: "idem-sim-1",
    };
    const before = simulator.requestLog.filter((r) => r.path === "/postCharge").length;
    const first = await adapter.createCharge(input);
    const second = await adapter.createCharge(input);
    const after = simulator.requestLog.filter((r) => r.path === "/postCharge").length;
    expect(second.externalChargeId).toBe(first.externalChargeId);
    expect(after - before).toBe(1);
  });

  // contrato-capacidad-pms: cloudbeds:applyReservationUpdate
  it("applyReservationUpdate detecta conflicto de version real (409) sin escribir, y aplica cuando la version coincide", async () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    const before = await adapter.getReservation("SIM-RES-1");

    await expect(
      adapter.applyReservationUpdate({
        externalReservationId: "SIM-RES-1",
        status: "cancelada",
        expectedVersion: "version-vieja-que-no-coincide",
        newVersion: "v-nueva",
      }),
    ).rejects.toBeInstanceOf(PortConflictError);

    const updated = await adapter.applyReservationUpdate({
      externalReservationId: "SIM-RES-1",
      status: "cancelada",
      expectedVersion: before.externalVersion,
      newVersion: "ignorada-cloudbeds-asigna-la-suya",
    });
    expect(updated.status).toBe("cancelada");
    expect(updated.externalVersion).not.toBe(before.externalVersion);
  });

  it("updateHousekeepingStatus hace el round-trip dominio -> nativo -> dominio contra el simulador", async () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    const status = await adapter.updateHousekeepingStatus({ roomExternalId: "SIM-ROOM-1", status: "limpia" });
    expect(status.status).toBe("limpia");
    expect(status.roomExternalId).toBe("SIM-ROOM-1");
  });

  it("updateHousekeepingStatus con 'fuera_de_servicio' lanza PortValidationError sin llamar a la red (Cloudbeds real usa room blocks para eso)", async () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    const before = simulator.requestLog.length;
    await expect(
      adapter.updateHousekeepingStatus({ roomExternalId: "SIM-ROOM-1", status: "fuera_de_servicio" }),
    ).rejects.toBeInstanceOf(PortValidationError);
    expect(simulator.requestLog.length).toBe(before);
  });

  // contrato-capacidad-pms: cloudbeds:getGuestProfile
  it("getGuestProfile devuelve el huesped del fixture", async () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    const guest = await adapter.getGuestProfile("SIM-GUEST-1");
    expect(guest).toEqual({ externalGuestId: "SIM-GUEST-1", firstName: "Ana", lastName: "Reyes", email: "ana@example.com" });
  });

  it("renueva el access token cuando expira y sigue el refresh_token rotado por el simulador", async () => {
    // `requestLog` es del simulador COMPARTIDO por todo este archivo (acumula llamadas
    // de pruebas anteriores) -- se mide por DELTA, no por conteo absoluto, mismo patron
    // que la prueba de idempotencia de `createCharge` arriba.
    const countTokenCalls = () => simulator.requestLog.filter((r) => r.path === "/access_token").length;
    let simulatedNow = Date.now();
    const adapter = new CloudbedsAdapter({ baseUrl, now: () => simulatedNow });

    const before = countTokenCalls();
    await adapter.getReservation("SIM-RES-1");
    expect(countTokenCalls() - before).toBe(1);

    // El simulador rota el refresh_token en CADA renovacion (ver cloudbeds-simulator.ts)
    // -- si el adaptador no guardara el nuevo refresh_token devuelto en la primera
    // renovacion, esta segunda renovacion fallaria (400 invalid_grant) contra el
    // simulador por usar el refresh_token viejo, ya invalido.
    simulatedNow += 3600 * 1000 + 60_000; // pasa el TTL default (1h) + margen
    await adapter.getReservation("SIM-RES-1");
    expect(countTokenCalls() - before).toBe(2);
  });

  it("reintenta automaticamente ante un 429 del proveedor y termina en exito (retryWithBackoff real)", async () => {
    const adapter = new CloudbedsAdapter({ baseUrl });
    simulator.forceRateLimitOnce(1);
    const reservation = await adapter.getReservation("SIM-RES-1");
    expect(reservation.externalReservationId).toBe("SIM-RES-1");
  });
});
