// REQ-RES-020 (embedded-postgres real): reporte de atribución de canal/agente de
// origen para comisión y room-nights directas + configuración de comisión por canal.
//
// El canal 'ota_test' de este archivo se escribe MANUALMENTE vía el cliente admin
// (nunca por la API pública, que hoy solo produce 'directo' -- REQ-RES-022/H15-006
// siguen prohibiendo conectividad OTA propia) — mismo criterio exacto que
// tests/integration/reservas/overbooking-controlado.spec.ts usa para dejar el
// inventario en un estado concreto vía SQL directo: se ejercita el CÁLCULO del
// reporte sobre datos reales de Postgres, sin simular que existe una integración OTA
// que este repo no construye.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, crearFolioConfirmado, type ApiFixture } from "../../support/api-fixture.ts";

describe("atribución de canal y comisión (REQ-RES-020, embedded-postgres real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let accountantToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let desde: string;
  let hasta: string;
  let reservaDirectaId: string;
  let reservaOtaId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    accountantToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "accountant")!.email);
    frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);

    const { rows: seededDates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc limit 4;",
      [hotelId, roomTypeId],
    );
    const checkIn1 = seededDates[0]!.date;
    const checkOut1 = seededDates[1]!.date;
    const checkIn2 = seededDates[2]!.date;
    const checkOut2 = seededDates[3]!.date;
    desde = checkIn1;
    hasta = checkIn2;

    // Reserva 1: queda 'directo' (default de la app, migración 0014) -- 1 noche.
    const r1 = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: checkIn1,
      checkOutDate: checkOut1,
    });
    reservaDirectaId = r1.reservationId;

    // Reserva 2: creada igual por la API real (channel='directo'), y luego
    // reetiquetada a 'ota_test' vía admin -- simula el dato que un channel manager
    // certificado escribiría el día que exista (fuera de alcance de este cierre),
    // para poder probar el reporte sobre una fila con canal distinto de 'directo' de
    // verdad en la base.
    const r2 = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: checkIn2,
      checkOutDate: checkOut2,
    });
    reservaOtaId = r2.reservationId;
    await fixture.engine.admin.query("update public.reservation set channel = 'ota_test' where id = $1;", [reservaOtaId]);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("sin config de comisión, el reporte agrupa por canal con comisión 0 en todos", async () => {
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/atribucion-canal?desde=${desde}&hasta=${hasta}`,
      { headers: { authorization: `Bearer ${gmToken}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channels: { channel: string; roomNights: number; netRevenue: number; commissionPct: number; commissionAmount: number }[];
      totalReservations: number;
      totalRoomNights: number;
      directRoomNights: number;
      directRoomNightsPct: number;
      totalCommissionAmount: number;
    };

    expect(body.totalReservations).toBe(2);
    expect(body.totalRoomNights).toBe(2); // 1 noche cada reserva
    expect(body.directRoomNights).toBe(1);
    expect(body.directRoomNightsPct).toBe(50);
    expect(body.totalCommissionAmount).toBe(0);

    const directo = body.channels.find((c) => c.channel === "directo")!;
    const ota = body.channels.find((c) => c.channel === "ota_test")!;
    expect(directo.roomNights).toBe(1);
    expect(directo.commissionAmount).toBe(0);
    expect(ota.roomNights).toBe(1);
    expect(ota.commissionPct).toBe(0); // sin fila de config todavía -> fail-closed a 0%
    expect(ota.commissionAmount).toBe(0);
  });

  it("owner/gm puede dar de alta la comisión del canal 'ota_test' y el reporte la refleja", async () => {
    const put = await fixture.app.request(`/hoteles/${hotelId}/comision-canal`, {
      method: "PUT",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "ota_test", commissionPct: 20 }),
    });
    expect(put.status).toBe(200);

    const listado = await fixture.app.request(`/hoteles/${hotelId}/comision-canal`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(listado.status).toBe(200);
    const listadoBody = (await listado.json()) as { canales: { channel: string; commissionPct: number }[] };
    expect(listadoBody.canales).toEqual([{ channel: "ota_test", commissionPct: 20 }]);

    const res = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/atribucion-canal?desde=${desde}&hasta=${hasta}`,
      { headers: { authorization: `Bearer ${gmToken}` } },
    );
    const body = (await res.json()) as {
      channels: { channel: string; netRevenue: number; commissionPct: number; commissionAmount: number }[];
      totalCommissionAmount: number;
    };
    const ota = body.channels.find((c) => c.channel === "ota_test")!;
    expect(ota.commissionPct).toBe(20);
    expect(ota.commissionAmount).toBeCloseTo(ota.netRevenue * 0.2, 2);
    expect(body.totalCommissionAmount).toBeCloseTo(ota.commissionAmount, 2);
  });

  it("rechaza configurar comisión para 'directo' con 400 (nunca paga comisión)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/comision-canal`, {
      method: "PUT",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "directo", commissionPct: 5 }),
    });
    expect(res.status).toBe(400);
  });

  it("accountant puede LEER el reporte y la config, pero NO escribir la comisión (403)", async () => {
    const getReport = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/atribucion-canal?desde=${desde}&hasta=${hasta}`,
      { headers: { authorization: `Bearer ${accountantToken}` } },
    );
    expect(getReport.status).toBe(200);

    const put = await fixture.app.request(`/hoteles/${hotelId}/comision-canal`, {
      method: "PUT",
      headers: { authorization: `Bearer ${accountantToken}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "ota_test", commissionPct: 30 }),
    });
    expect(put.status).toBe(403);
  });

  it("frontdesk NO puede ver el reporte financiero (403, fuera de PL_ROLES)", async () => {
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/atribucion-canal?desde=${desde}&hasta=${hasta}`,
      { headers: { authorization: `Bearer ${frontdeskToken}` } },
    );
    expect(res.status).toBe(403);
  });

  it("valida que 'desde'/'hasta' sean obligatorios y con formato correcto (400)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reportes/atribucion-canal`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(400);

    const res2 = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/atribucion-canal?desde=${hasta}&hasta=${desde}`,
      { headers: { authorization: `Bearer ${gmToken}` } },
    );
    expect(res2.status).toBe(400);
  });

  it("una reserva 'cancelada' fuera del filtro no infla el reporte (excluida del cálculo)", async () => {
    // Cancela la reserva directa recién creada y confirma que el total de reservas del
    // reporte baja en 1 -- verifica el filtro real de estados contra la BD, no solo
    // la lógica pura ya cubierta por tests/unit.
    const cancel = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservaDirectaId}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cancel.status).toBe(200);

    const res = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/atribucion-canal?desde=${desde}&hasta=${hasta}`,
      { headers: { authorization: `Bearer ${gmToken}` } },
    );
    const body = (await res.json()) as { totalReservations: number; directRoomNights: number };
    expect(body.totalReservations).toBe(1);
    expect(body.directRoomNights).toBe(0);
    void reservaOtaId;
  });
});
