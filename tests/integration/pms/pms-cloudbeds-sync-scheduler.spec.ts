// H15-001/ADR-007 · prueba del planificador REAL que sincroniza tarifas de Cloudbeds
// hacia `public.rate_plan` (apps/api/src/jobs/pmsCloudbedsSyncScheduler.ts) -- el
// primer caller de produccion de `@atiende-hoteles/mcp-pms` (la auditoria confirmo 0
// antes de esto). Corre contra un Postgres real (embedded-postgres, ver
// tests/support/pg-fixture.ts), NUNCA contra Cloudbeds real: la "declaracion honesta"
// (sin credenciales -> 0 llamadas de red) se prueba con `CloudbedsAdapter` real sin
// variables de entorno; el camino feliz se prueba primero contra `FakeCloudbedsAdapter`
// y luego, de punta a punta (OAuth2 + HTTP real), contra `CloudbedsAdapter` apuntado a
// `cloudbeds-simulator.ts`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudbedsAdapter, FakeCloudbedsAdapter } from "@atiende-hoteles/mcp-pms";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../../support/pg-fixture.ts";
import {
  loadRoomTypesForCloudbedsSync,
  runPmsCloudbedsSyncTick,
} from "../../../apps/api/src/jobs/pmsCloudbedsSyncScheduler.ts";
import { CloudbedsSimulator } from "../../../packages/mcp-servers/pms/src/testing/cloudbeds-simulator.ts";

// Bug real de CI (10-sep-2026): fechas que eran literales absolutos se quedan fuera
// de la ventana de tarifa/disponibilidad sembrada por seedDev (siempre desde "hoy"
// real, 30 días) tarde o temprano -- corregidas a offsets relativos, nunca "hoy" mismo.
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}


// SYNC_NOW también era un literal absoluto ("2026-09-08") -- el "reloj" que el propio
// tick de sincronización usa para decidir su ventana [now, now+14) queda anclado a
// isoDate(-1) (mismo offset relativo que el original tenía frente a las fechas
// "2026-09-10"/"2026-09-11" de las aserciones de abajo, ahora isoDate(1)/isoDate(2)).
const SYNC_NOW = () => new Date(`${isoDate(-1)}T00:00:00Z`);

describe("pmsCloudbedsSyncScheduler (integracion, Postgres real)", () => {
  let fixture: PgFixture;
  let hotelId: string;
  let tenantId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createPgFixture();
    const hotel = fixture.seed.hotels[0]!;
    hotelId = hotel.id;
    tenantId = fixture.seed.orgId;
    roomTypeId = hotel.roomTypes[0]!.id;
    await fixture.engine.admin.query(
      "update public.room_type set cloudbeds_room_type_id = $1 where id = $2;",
      ["CB-RT-STD", roomTypeId],
    );
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  it("loadRoomTypesForCloudbedsSync solo trae room_type con cloudbeds_room_type_id configurado", async () => {
    const roomTypes = await loadRoomTypesForCloudbedsSync(fixture.engine.admin);
    expect(roomTypes).toHaveLength(1);
    expect(roomTypes[0]).toMatchObject({ roomTypeId, hotelId, tenantId, cloudbedsRoomTypeId: "CB-RT-STD" });
  });

  it("[PENDIENTE DE CREDENCIALES] sin OAuth de Cloudbeds: 0 llamadas de red, 0 filas escritas, declara la razon exacta", async () => {
    delete process.env.CLOUDBEDS_CLIENT_ID;
    delete process.env.CLOUDBEDS_CLIENT_SECRET;
    delete process.env.CLOUDBEDS_REFRESH_TOKEN;
    delete process.env.CLOUDBEDS_PROPERTY_ID;
    const realAdapterSinCredenciales = new CloudbedsAdapter();
    const roomTypes = await loadRoomTypesForCloudbedsSync(fixture.engine.admin);

    const before = await fixture.engine.admin.query(`select count(*)::int as n from public.rate_plan where room_type_id = $1 and date between '${isoDate(-1)}' and '${isoDate(12)}';`, [roomTypeId]);

    const results = await runPmsCloudbedsSyncTick(fixture.engine.admin, realAdapterSinCredenciales, roomTypes, { now: SYNC_NOW });

    expect(results).toEqual([
      expect.objectContaining({
        roomTypeId,
        synced: false,
        skippedReason: "pms_unavailable",
        error: expect.stringMatching(/PENDIENTE DE CREDENCIALES/),
      }),
    ]);
    const after = await fixture.engine.admin.query<{ n: number }>(`select count(*)::int as n from public.rate_plan where room_type_id = $1 and date between '${isoDate(-1)}' and '${isoDate(12)}';`, [roomTypeId]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("con un PmsPort disponible (FakeCloudbedsAdapter) sincroniza las tarifas reales del rango hacia rate_plan", async () => {
    const fake = new FakeCloudbedsAdapter();
    const roomTypes = await loadRoomTypesForCloudbedsSync(fixture.engine.admin);

    const results = await runPmsCloudbedsSyncTick(fixture.engine.admin, fake, roomTypes, { now: SYNC_NOW });

    expect(results).toEqual([expect.objectContaining({ roomTypeId, synced: true, ratesWritten: 2 })]);

    const { rows } = await fixture.engine.admin.query<{ date: string; price: string; currency: string }>(
      `select date::text as date, price, currency from public.rate_plan where room_type_id = $1 and date in ('${isoDate(1)}','${isoDate(2)}') order by date;`,
      [roomTypeId],
    );
    expect(rows).toEqual([
      { date: isoDate(1), price: "1500.00", currency: "MXN" },
      { date: isoDate(2), price: "1500.00", currency: "MXN" },
    ]);
  });

  it("una segunda corrida actualiza el precio en vez de duplicar la fila (upsert real por room_type_id+date)", async () => {
    const fake = new FakeCloudbedsAdapter();
    // Cambia el precio devuelto por el Fake para simular una tarifa nueva en Cloudbeds.
    const originalListRatePlans = fake.listRatePlans.bind(fake);
    fake.listRatePlans = async (input) => (await originalListRatePlans(input)).map((r) => ({ ...r, nightlyRate: 1800 }));

    const roomTypes = await loadRoomTypesForCloudbedsSync(fixture.engine.admin);
    await runPmsCloudbedsSyncTick(fixture.engine.admin, fake, roomTypes, { now: SYNC_NOW });

    const { rows } = await fixture.engine.admin.query<{ n: number }>(
      `select count(*)::int as n from public.rate_plan where room_type_id = $1 and date in ('${isoDate(1)}','${isoDate(2)}');`,
      [roomTypeId],
    );
    expect(rows[0]!.n).toBe(2); // sigue habiendo exactamente 2 filas, no 4

    const { rows: prices } = await fixture.engine.admin.query<{ price: string }>(
      `select price from public.rate_plan where room_type_id = $1 and date = '${isoDate(1)}';`,
      [roomTypeId],
    );
    expect(prices[0]!.price).toBe("1800.00");
  });

  it("de punta a punta (OAuth2 + HTTP real) contra CloudbedsAdapter + cloudbeds-simulator", async () => {
    const simulator = new CloudbedsSimulator({
      propertyId: "SIM-PROPERTY-E2E",
      reservations: [
        {
          reservationID: "SIM-RES-E2E",
          propertyID: "SIM-PROPERTY-E2E",
          status: "confirmed",
          startDate: isoDate(1),
          endDate: isoDate(2),
          total: 1000,
          dateModified: "2026-09-01T00:00:00Z",
          roomTypeID: "CB-RT-STD",
          guest: { guestID: "G1", firstName: "Ana", lastName: "Reyes" },
        },
      ],
    });
    const baseUrl = await simulator.start();
    process.env.CLOUDBEDS_CLIENT_ID = "sim-client-id";
    process.env.CLOUDBEDS_CLIENT_SECRET = "sim-client-secret";
    process.env.CLOUDBEDS_REFRESH_TOKEN = simulator.currentRefreshToken();
    process.env.CLOUDBEDS_PROPERTY_ID = "SIM-PROPERTY-E2E";
    try {
      const adapter = new CloudbedsAdapter({ baseUrl });
      const roomTypes = await loadRoomTypesForCloudbedsSync(fixture.engine.admin);
      const results = await runPmsCloudbedsSyncTick(fixture.engine.admin, adapter, roomTypes, { now: SYNC_NOW });
      expect(results).toEqual([expect.objectContaining({ roomTypeId, synced: true })]);
      expect(results[0]!.ratesWritten).toBeGreaterThan(0);

      const { rows } = await fixture.engine.admin.query<{ price: string }>(
        `select price from public.rate_plan where room_type_id = $1 and date = '${isoDate(1)}';`,
        [roomTypeId],
      );
      expect(rows[0]!.price).toBe("1500.00");
    } finally {
      await simulator.stop();
      delete process.env.CLOUDBEDS_CLIENT_ID;
      delete process.env.CLOUDBEDS_CLIENT_SECRET;
      delete process.env.CLOUDBEDS_REFRESH_TOKEN;
      delete process.env.CLOUDBEDS_PROPERTY_ID;
    }
  });
});
