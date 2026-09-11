// REQ-RES-012 (embedded-postgres real) -- criterio LITERAL de docs/ACEPTACION.md:
// "Cotización de grupo/evento generada en <15 min desde la solicitud; el precio de
// grupo consulta al motor de Revenue el costo de desplazamiento de ADR antes de
// fijarse (verificado: precio de grupo ≠ precio manual si el motor de Revenue indica
// desplazamiento distinto de cero)." Contra la API real de POST /hoteles/:hotelId/reservas
// para crear demanda real (nunca un mock del motor de Revenue) y contra la ruta real
// de cotización de grupo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

describe("cotización de grupo / room block (REQ-RES-012, embedded-postgres real)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let housekeepingToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let guestId: string;
  let dates: string[];

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id; // "Estandar", precio sembrado 1200, 5 habitaciones/noche
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
    housekeepingToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "housekeeping")!.email);

    const { rows: seededDates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc limit 8;",
      [hotelId, roomTypeId],
    );
    dates = seededDates.map((r) => r.date);

    const guestRes = await fixture.app.request(`/hoteles/${hotelId}/huespedes`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json" },
      body: JSON.stringify({ nombre: "Huésped de prueba (ocupación)" }),
    });
    expect(guestRes.status).toBe(201);
    guestId = ((await guestRes.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function reservar(checkIn: string, checkOut: string) {
    return fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${gmToken}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId, guestId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
  }

  function cotizarGrupo(body: Record<string, unknown>, token: string = gmToken) {
    return fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const baseCotizacion = (over: Record<string, unknown> = {}) => ({
    roomTypeId,
    organizerName: "Ana Torres",
    organizerEmail: "ana@planner-demo.mx",
    eventType: "boda",
    roomsRequested: 1,
    manualPrice: 1000,
    currency: "MXN",
    ...over,
  });

  it("caso positivo — alta ocupación (4/5 = 80% >= 70%): el precio de grupo NUNCA es igual al precio manual", async () => {
    // Llena 4 de las 5 habitaciones de esa noche con reservas individuales reales
    // (nunca un mock del motor de Revenue) -- deja exactamente 1 habitación libre.
    for (let i = 0; i < 4; i += 1) {
      const res = await reservar(dates[0]!, dates[1]!);
      expect(res.status).toBe(201);
    }

    const before = Date.now();
    const res = await cotizarGrupo(baseCotizacion({ checkInDate: dates[0], checkOutDate: dates[1], roomsRequested: 1 }));
    const elapsedMs = Date.now() - before;

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      displacementCost: number;
      manualPrice: number;
      groupPrice: number;
      slaMinutes: number;
      withinSla: boolean;
      nightlyDisplacement: { date: string; roomsDisplaced: number; expectedAdr: number }[];
      status: string;
    };

    // El motor de Revenue SÍ fue consultado (fila real por noche, ADR real de rate_plan).
    expect(body.nightlyDisplacement).toEqual([{ date: dates[0], roomsDisplaced: 1, expectedAdr: 1200 }]);
    expect(body.displacementCost).toBe(1200); // 1 habitación desplazada x ADR 1200
    expect(body.manualPrice).toBe(1000);
    expect(body.groupPrice).toBe(2200); // 1000 (manual) + 1200 (desplazamiento) -- NUNCA igual al manual
    expect(body.groupPrice).not.toBe(body.manualPrice);
    expect(body.status).toBe("cotizado");

    // <15 min desde la solicitud (H02-013/BP-089): la cotización se generó en el
    // mismo request síncrono -- muy por debajo del límite, y el propio backend
    // reporta slaMinutes/withinSla real (no fabricado por el test).
    expect(elapsedMs).toBeLessThan(15 * 60 * 1000);
    expect(body.slaMinutes).toBeLessThanOrEqual(1);
    expect(body.withinSla).toBe(true);
  });

  it("caso negativo — sin ocupación (0/5): el precio de grupo es EXACTAMENTE el precio manual (el motor de Revenue no encontró nada que desplazar)", async () => {
    const res = await cotizarGrupo(baseCotizacion({ checkInDate: dates[2], checkOutDate: dates[3], roomsRequested: 2, manualPrice: 5000 }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { displacementCost: number; manualPrice: number; groupPrice: number };

    expect(body.displacementCost).toBe(0);
    expect(body.groupPrice).toBe(body.manualPrice);
    expect(body.groupPrice).toBe(5000);
  });

  it("rechaza un bloque que pide más habitaciones de las que quedan libres (409)", async () => {
    // De las 5 habitaciones de dates[0]/dates[1] ya quedaron 4 ocupadas por el primer
    // test de este archivo (ejecución secuencial de vitest dentro de un mismo
    // `describe`) -- solo queda 1 libre.
    const res = await cotizarGrupo(baseCotizacion({ checkInDate: dates[0], checkOutDate: dates[1], roomsRequested: 2 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("sin_disponibilidad_suficiente");
  });

  it("rechaza fechas sin disponibilidad/tarifa configurada (fuera del horizonte sembrado)", async () => {
    const lejos1 = new Date(`${dates[0]}T00:00:00Z`);
    lejos1.setUTCDate(lejos1.getUTCDate() + 40);
    const lejos2 = new Date(lejos1);
    lejos2.setUTCDate(lejos2.getUTCDate() + 1);
    const res = await cotizarGrupo(
      baseCotizacion({ checkInDate: lejos1.toISOString().slice(0, 10), checkOutDate: lejos2.toISOString().slice(0, 10) }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("sin_inventario_configurado");
  });

  it("rechaza checkOutDate <= checkInDate (400)", async () => {
    const res = await cotizarGrupo(baseCotizacion({ checkInDate: dates[4], checkOutDate: dates[4] }));
    expect(res.status).toBe(400);
  });

  it("rechaza un tipo de habitación que no existe en el hotel (404)", async () => {
    const res = await cotizarGrupo(baseCotizacion({ roomTypeId: crypto.randomUUID(), checkInDate: dates[4], checkOutDate: dates[5] }));
    expect(res.status).toBe(404);
  });

  it("un rol sin gestión de reservaciones (housekeeping) no puede generar cotizaciones de grupo (403)", async () => {
    const res = await cotizarGrupo(baseCotizacion({ checkInDate: dates[4], checkOutDate: dates[5] }), housekeepingToken);
    expect(res.status).toBe(403);
  });

  it("GET .../cotizaciones/:id devuelve exactamente lo persistido", async () => {
    const created = await cotizarGrupo(baseCotizacion({ checkInDate: dates[6], checkOutDate: dates[7], roomsRequested: 1, manualPrice: 800 }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; groupPrice: number };

    const fetched = await fixture.app.request(`/hoteles/${hotelId}/grupos/cotizaciones/${createdBody.id}`, {
      headers: { authorization: `Bearer ${gmToken}` },
    });
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as { id: string; groupPrice: number };
    expect(fetchedBody.id).toBe(createdBody.id);
    expect(fetchedBody.groupPrice).toBe(createdBody.groupPrice);
  });
});
