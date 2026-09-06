// ADR-003/ADR-004: dos conexiones REALES (procesos backend distintos, dos pg.Client
// separados) compitiendo por la ULTIMA habitacion disponible deben resolver en
// exactamente un ganador. Solo tiene valor probatorio contra `embedded-postgres`
// (Postgres real, concurrencia real) -- en PGlite toda concurrencia se serializa
// (docs/referencia/07-stack-viabilidad.md, riesgo 1), por lo que este test NO se
// duplica ahi: correrlo en PGlite no probaria contencion real, solo daria un falso
// positivo de seguridad.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";

describe("concurrencia real: reservar la ultima habitacion disponible (embedded-postgres)", () => {
  let fixture: PgFixture;

  beforeAll(async () => {
    fixture = await createPgFixture();
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  it("exactamente una de dos conexiones concurrentes gana la ultima habitacion; la otra recibe un error controlado", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const roomType = hotelA.roomTypes[0]!;
    const gm = hotelA.staff.find((s) => s.role === "gm")!;

    const { rows: availRows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc limit 1;",
      [hotelA.id, roomType.id],
    );
    const date = availRows[0]!.date;

    // Fuerza el escenario "ultima habitacion": deja solo 1 disponible y 0 reservadas.
    await fixture.engine.admin.query(
      "update public.availability set total_rooms = 1, booked_rooms = 0 where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelA.id, roomType.id, date],
    );

    const attemptBooking = () =>
      fixture.engine.withAppSession({ userId: gm.id }, async (session) => {
        // OJO: `select (fn()).*` re-evalua una funcion VOLATILE una vez por columna del
        // tipo compuesto (gotcha documentado de Postgres) -- aqui duplicaria la reserva
        // dentro de la misma sentencia. `select * from fn(...)` evalua una sola vez.
        const res = await session.query<{ booked_rooms: number; total_rooms: number }>(
          "select * from public.book_availability($1, $2, $3, 1);",
          [hotelA.id, roomType.id, date],
        );
        return res.rows[0];
      });

    // Promise.all lanza las dos conexiones al mismo tiempo: son dos procesos de sistema
    // operativo distintos disputando el mismo pg_advisory_xact_lock (ver
    // packages/db/src/engines.ts, withAppSession abre un pg.Client nuevo por llamada).
    const results = await Promise.allSettled([attemptBooking(), attemptBooking()]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ booked_rooms: number; total_rooms: number }> =>
        r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0]!.reason as Error).message)).toMatch(/sin_disponibilidad/);

    const { rows: finalState } = await fixture.engine.admin.query<{
      booked_rooms: number;
      total_rooms: number;
    }>(
      "select booked_rooms, total_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelA.id, roomType.id, date],
    );

    // Ni sobreventa (booked > total) ni la reserva "perdida" (booked se quedo en 0).
    expect(finalState[0]!.booked_rooms).toBe(1);
    expect(finalState[0]!.total_rooms).toBe(1);
  });
});
