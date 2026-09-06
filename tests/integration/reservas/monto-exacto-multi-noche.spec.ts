// H4 · auditoría-1/pruebas [CRÍTICO]: "no existe ninguna prueba que verifique el monto
// exacto de una reserva multi-noche (un bug de -50% en
// apps/api/src/routes/reservas.ts:175 pasó toda la suite en verde, verificado por
// mutación)". La única aserción existente hasta ahora sobre el total de una reserva
// creada por la API era `expect(created.total).toBeGreaterThan(0)`
// (tests/integration/api/reservas-y-folios.spec.ts) -- un bug que calculara la mitad,
// el doble, o sumara solo la primera noche seguiría pasando esa aserción. Esta prueba
// fija 3 tarifas DISTINTAS (una por temporada/día) vía la API real de tarifas
// (PUT /tarifas, sin tocar la tabla directamente) y compara el total PERSISTIDO en
// `reservation.total_amount` contra la suma exacta esperada.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

function nightAfter(d: string, n: number): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

describe("monto exacto de una reserva de 3 noches con tarifas distintas por noche (auditoría-1/pruebas CRÍTICO)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function auth() {
    return { authorization: `Bearer ${gmToken}`, "content-type": "application/json" };
  }

  it("3 noches × tarifas distintas por temporada (baja/alta/media) + impuestos parametrizados: el total persistido coincide EXACTO con la suma esperada", async () => {
    const { rows: seededDates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    const checkIn = seededDates[7]!.date;
    const noche1 = checkIn;
    const noche2 = nightAfter(checkIn, 1);
    const noche3 = nightAfter(checkIn, 2);
    const checkOut = nightAfter(checkIn, 3);

    // 3 tarifas DISTINTAS, cada una con una sola llamada PUT (desde === hasta): simula
    // temporada baja / alta / media en 3 noches consecutivas -- un bug que sume solo la
    // primera noche, o que calcule con un factor incorrecto, produce un total distinto
    // de 1000 + 2400 + 1800 = 5200.
    const tarifas: [string, number][] = [
      [noche1, 1000], // temporada baja
      [noche2, 2400], // temporada alta
      [noche3, 1800], // temporada media
    ];
    for (const [fecha, precio] of tarifas) {
      const res = await fixture.app.request(`/hoteles/${hotelId}/tarifas`, {
        method: "PUT",
        headers: auth(),
        body: JSON.stringify({ roomTypeId, desde: fecha, hasta: fecha, price: precio }),
      });
      expect(res.status).toBe(200);
    }

    const totalEsperado = 1000 + 2400 + 1800; // 5200, NETO (sin impuestos, ver comentario de reservas.ts)

    const creada = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(creada.status).toBe(201);
    const { id, total } = (await creada.json()) as { id: string; total: number };
    expect(total).toBe(totalEsperado);

    const { rows: persisted } = await fixture.engine.admin.query<{ total_amount: string }>(
      "select total_amount::text as total_amount from public.reservation where id = $1;",
      [id],
    );
    expect(Number(persisted[0]!.total_amount)).toBe(totalEsperado);

    // El motor de cotización (POST /quotes) debe reportar el MISMO neto y, además, el
    // desglose de impuestos calculado con los parámetros reales del hotel (nunca una
    // tasa fija en el código) -- confirma que reserva y cotización usan el MISMO motor.
    const cotizacion = await fixture.app.request(`/hoteles/${hotelId}/quotes`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(cotizacion.status).toBe(200);
    const cotizacionBody = (await cotizacion.json()) as { netAmount: number; totalAmount: number; ivaAmount: number; ishAmount: number };
    expect(cotizacionBody.netAmount).toBe(totalEsperado);
    // Tasas sembradas: IVA 16%, ISH 3% (packages/db/src/seed.ts) -- 5200 * 0.16 = 832,
    // 5200 * 0.03 = 156, total bruto 6188.
    expect(cotizacionBody.ivaAmount).toBe(832);
    expect(cotizacionBody.ishAmount).toBe(156);
    expect(cotizacionBody.totalAmount).toBe(6188);
  });

  it("una noche sin tarifa configurada en el rango rechaza la reserva en vez de cobrarla en $0 (auditoría-1/backend CRÍTICO C2)", async () => {
    const { rows: seededDates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    // Fecha fuera del horizonte de 30 días sembrado por seedDev: tiene `availability`
    // NO, así que en vez de eso forzamos un hueco DENTRO del horizonte borrando la fila
    // de rate_plan de una noche intermedia (un hueco real de carga de tarifas, no un
    // caso de laboratorio -- ver docs/auditoria-1/backend.md).
    const checkIn = seededDates[20]!.date;
    const huecoNoche = nightAfter(checkIn, 1);
    const checkOut = nightAfter(checkIn, 2);

    await fixture.engine.admin.query(
      "delete from public.rate_plan where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, huecoNoche],
    );

    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: { ...auth(), "idempotency-key": randomUUID() },
      body: JSON.stringify({ roomTypeId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("sin_tarifa");

    // Ninguna reserva a $0 (ni de ningún monto) debe haber quedado creada.
    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.reservation where hotel_id = $1 and room_type_id = $2 and check_in_date = $3;",
      [hotelId, roomTypeId, checkIn],
    );
    expect(rows[0]!.count).toBe("0");

    // Tampoco debe haber quedado inventario "reservado" huérfano de la noche que SÍ
    // tenía tarifa (book_availability corre antes de descubrir el hueco de tarifa para
    // la noche siguiente -- si la reserva se rechaza, ese cupo debe seguir libre).
    const { rows: availRows } = await fixture.engine.admin.query<{ booked_rooms: number }>(
      "select booked_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, checkIn],
    );
    expect(availRows[0]!.booked_rooms).toBe(0);
  });
});
