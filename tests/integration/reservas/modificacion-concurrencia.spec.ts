// H4 · Modificar fechas bajo concurrencia real (embedded-postgres, dos conexiones de
// sistema operativo distintas): dos reservas EXISTENTES intentando moverse a la MISMA
// última noche disponible deben resolver en exactamente una ganadora (200) y una
// rechazada (409) — el mismo criterio de contención que ya prueba
// tests/integration/availability-concurrency.spec.ts para la creación, ahora para
// PATCH .../fechas (release + book dentro de la MISMA transacción/advisory lock).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

function nightAfter(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

describe("modificación de fechas bajo concurrencia real (embedded-postgres)", () => {
  let fixture: ApiFixture;
  let gmToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let targetDate: string; // única noche en disputa
  let dateA: string;
  let dateB: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    gmToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "gm")!.email);

    // Fechas leídas del inventario YA sembrado (horizonte de 30 días desde "hoy",
    // packages/db/src/seed.ts): un literal fijo podría caer fuera de ese horizonte
    // según cuándo corra la prueba y producir "no existe inventario", ajeno a lo que
    // esta prueba quiere verificar (ver overbooking-controlado.spec.ts, mismo criterio).
    const { rows: seededDates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    targetDate = seededDates[0]!.date;
    dateA = seededDates[10]!.date;
    dateB = seededDates[15]!.date;

    // La noche en disputa solo tiene 1 habitación disponible.
    await fixture.engine.admin.query(
      "update public.availability set total_rooms = 1, booked_rooms = 0 where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, targetDate],
    );
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function crearReserva(checkInDate: string, checkOutDate: string): Promise<string> {
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gmToken}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ roomTypeId, checkInDate, checkOutDate }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  it("dos modificaciones concurrentes a la misma noche: exactamente una 200, la otra 409, sin sobreventa", async () => {
    // Dos reservas en fechas SIN conflicto entre sí, cada una en un tipo/fecha con
    // inventario propio de sobra, que luego intentan moverse a la MISMA noche disputada.
    const reservaA = await crearReserva(dateA, nightAfter(dateA));
    const reservaB = await crearReserva(dateB, nightAfter(dateB));

    const modificar = (reservationId: string) =>
      fixture.app.request(`/hoteles/${hotelId}/reservas/${reservationId}/fechas`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${gmToken}`,
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ checkInDate: targetDate, checkOutDate: nightAfter(targetDate) }),
      });

    const [resA, resB] = await Promise.all([modificar(reservaA), modificar(reservaB)]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const ganadora = resA.status === 200 ? resA : resB;
    const perdedora = resA.status === 200 ? resB : resA;
    const ganadoraBody = (await ganadora.json()) as { checkInDate?: string; estado: string };
    expect(ganadoraBody.estado).toBe("cotizada");
    const perdedoraBody = (await perdedora.json()) as { code: string };
    expect(perdedoraBody.code).toBe("sin_disponibilidad");

    const { rows } = await fixture.engine.admin.query<{ booked_rooms: number; total_rooms: number }>(
      "select booked_rooms, total_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, targetDate],
    );
    // Ni sobreventa (booked > total) ni la reserva "perdida" (0 cuando debería ser 1).
    expect(rows[0]!.booked_rooms).toBe(1);
    expect(rows[0]!.total_rooms).toBe(1);

    // La reserva perdedora conserva sus fechas ORIGINALES (la transacción revirtió
    // también la liberación de su inventario propio, no solo el intento de reservar).
    const perdedoraId = resA.status === 200 ? reservaB : reservaA;
    const { rows: perdedoraRows } = await fixture.engine.admin.query<{ check_in_date: string }>(
      "select check_in_date::text as check_in_date from public.reservation where id = $1;",
      [perdedoraId],
    );
    expect(perdedoraRows[0]!.check_in_date).not.toBe(targetDate);
  });
});
