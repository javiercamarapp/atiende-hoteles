// ADR-004: toda escritura hacia un conector externo pasa por `outbox`, insertado en la
// MISMA transaccion que el cambio de dominio que lo origina (aqui, crear una reserva).
// Verifica el camino feliz (ambas filas se confirman juntas) y que un fallo del insert de
// outbox revierte tambien la reserva (atomicidad real de Postgres, no solo "buena
// intencion" de la capa de aplicacion) -- por eso corre contra embedded-postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";

describe("outbox: insercion atomica junto con la reserva que la origina", () => {
  let fixture: PgFixture;

  beforeAll(async () => {
    fixture = await createPgFixture();
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  it("reserva + evento de outbox se confirman juntos en la misma transaccion", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const roomType = hotelA.roomTypes[0]!;
    const gm = hotelA.staff.find((s) => s.role === "gm")!;

    const reservationId = await fixture.engine.withAppSession({ userId: gm.id }, async (session) => {
      const { rows } = await session.query<{ id: string }>(
        `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, total_amount)
         values ($1, $2, $3, current_date, current_date + 1, 1200)
         returning id;`,
        [fixture.seed.orgId, hotelA.id, roomType.id],
      );
      const id = rows[0]!.id;

      await session.query(
        `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
         values ($1, $2, 'reservation', $3, 'reservation.created', $4);`,
        [fixture.seed.orgId, hotelA.id, id, JSON.stringify({ reservationId: id })],
      );

      return id;
    });

    const { rows: reservationRows } = await fixture.engine.admin.query(
      "select id from public.reservation where id = $1;",
      [reservationId],
    );
    const { rows: outboxRows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.outbox where aggregate_id = $1;",
      [reservationId],
    );

    expect(reservationRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.status).toBe("pendiente");
  });

  it("si el INSERT del outbox falla, la reserva de la misma transaccion tambien se revierte", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const roomType = hotelA.roomTypes[0]!;
    const gm = hotelA.staff.find((s) => s.role === "gm")!;

    let reservationIdAttempted = "";

    await expect(
      fixture.engine.withAppSession({ userId: gm.id }, async (session) => {
        const { rows } = await session.query<{ id: string }>(
          `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, total_amount)
           values ($1, $2, $3, current_date, current_date + 1, 1200)
           returning id;`,
          [fixture.seed.orgId, hotelA.id, roomType.id],
        );
        reservationIdAttempted = rows[0]!.id;

        // aggregate_type es NOT NULL: fuerza el fallo del outbox dentro de la MISMA
        // transaccion para probar que arrastra a la reserva consigo.
        await session.query(
          `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
           values ($1, $2, null, $3, 'reservation.created', $4);`,
          [fixture.seed.orgId, hotelA.id, reservationIdAttempted, JSON.stringify({})],
        );
      }),
    ).rejects.toThrow(/null value in column "aggregate_type"|not-null/i);

    const { rows: reservationRows } = await fixture.engine.admin.query(
      "select id from public.reservation where id = $1;",
      [reservationIdAttempted],
    );
    const { rows: outboxRows } = await fixture.engine.admin.query(
      "select id from public.outbox where aggregate_id = $1;",
      [reservationIdAttempted],
    );

    expect(reservationRows).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });
});
