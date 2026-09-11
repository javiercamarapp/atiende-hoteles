// REQ-OBS-008 (embedded-postgres real): % de room-nights generadas directamente por el
// agente de IA propio del hotel, como métrica de producto periódica.
//
// El `origin_actor = 'agente_ia'` de este archivo se escribe MANUALMENTE vía el
// cliente admin (nunca por la API pública, que hoy solo produce 'manual' -- ningún
// flujo conversacional de este repo crea reservas de forma autónoma todavía, ver
// migración 0130) -- mismo criterio exacto que
// tests/integration/reservas/atribucion-canal.spec.ts usa para 'ota_test': se ejercita
// el CÁLCULO del reporte sobre datos reales de Postgres, sin simular que existe un
// flujo de reserva agéntica que este repo no construye.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, crearFolioConfirmado, type ApiFixture } from "../../support/api-fixture.ts";

describe("% de room-nights por origen agéntico (REQ-OBS-008, embedded-postgres real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let frontdeskToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let desde: string;
  let hasta: string;
  let reservaManualId: string;
  let reservaAgenticaId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
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

    // Reserva 1: queda 'manual' (default de la app, migración 0130) -- 1 noche.
    const r1 = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: checkIn1,
      checkOutDate: checkOut1,
    });
    reservaManualId = r1.reservationId;

    // Reserva 2: creada igual por la API real (origin_actor='manual'), y luego
    // reetiquetada a 'agente_ia' vía admin -- simula el dato que un flujo de reserva
    // conversacional directa escribiría el día que exista (fuera de alcance de este
    // cierre), para poder probar el reporte sobre una fila con actor agéntico real en
    // la base.
    const r2 = await crearFolioConfirmado(fixture.app, gmToken, hotelId, {
      roomTypeId,
      checkInDate: checkIn2,
      checkOutDate: checkOut2,
    });
    reservaAgenticaId = r2.reservationId;
    await fixture.engine.admin.query("update public.reservation set origin_actor = 'agente_ia' where id = $1;", [
      reservaAgenticaId,
    ]);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("reproduce exactamente el % de room-nights agénticas sobre el dataset sintético (1 de 2 -> 50%)", async () => {
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/room-nights-directas?desde=${desde}&hasta=${hasta}`,
      { headers: { authorization: `Bearer ${gmToken}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      origins: { originActor: string; reservationCount: number; roomNights: number }[];
      totalReservations: number;
      totalRoomNights: number;
      agenticRoomNights: number;
      agenticRoomNightsPct: number;
    };

    expect(body.totalReservations).toBe(2);
    expect(body.totalRoomNights).toBe(2); // 1 noche cada reserva
    expect(body.agenticRoomNights).toBe(1);
    expect(body.agenticRoomNightsPct).toBe(50);

    const manual = body.origins.find((o) => o.originActor === "manual")!;
    const agentico = body.origins.find((o) => o.originActor === "agente_ia")!;
    expect(manual.roomNights).toBe(1);
    expect(agentico.roomNights).toBe(1);
  });

  it("cualquier miembro del hotel (no solo PL_ROLES) puede leer esta métrica de producto", async () => {
    const res = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/room-nights-directas?desde=${desde}&hasta=${hasta}`,
      { headers: { authorization: `Bearer ${frontdeskToken}` } },
    );
    expect(res.status).toBe(200);
  });

  it("valida que 'desde'/'hasta' sean obligatorios y con formato correcto (400)", async () => {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reportes/room-nights-directas`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(res.status).toBe(400);

    const res2 = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/room-nights-directas?desde=${hasta}&hasta=${desde}`,
      { headers: { authorization: `Bearer ${gmToken}` } },
    );
    expect(res2.status).toBe(400);
  });

  it("una reserva 'cancelada' fuera del filtro no infla el reporte (excluida del cálculo)", async () => {
    // Cancela la reserva manual recién creada y confirma que el total de reservas del
    // reporte baja en 1 y que la reserva agéntica sigue siendo el 100% de lo que queda.
    const cancel = await fixture.app.request(`/hoteles/${hotelId}/reservas/${reservaManualId}/cancelar`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cancel.status).toBe(200);

    const res = await fixture.app.request(
      `/hoteles/${hotelId}/reportes/room-nights-directas?desde=${desde}&hasta=${hasta}`,
      { headers: { authorization: `Bearer ${gmToken}` } },
    );
    const body = (await res.json()) as { totalReservations: number; agenticRoomNights: number; agenticRoomNightsPct: number };
    expect(body.totalReservations).toBe(1);
    expect(body.agenticRoomNights).toBe(1);
    expect(body.agenticRoomNightsPct).toBe(100);
  });
});
