// ADR-005: reservation.status solo se mueve por las transiciones declaradas en
// reservation_status_transition; cualquier salto invalido se rechaza por trigger, y cada
// transicion valida queda registrada en reservation_status_event (append-only).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../support/pglite-fixture.ts";

async function createReservation(fixture: PgliteFixture): Promise<string> {
  const hotelA = fixture.seed.hotels[0]!;
  const roomType = hotelA.roomTypes[0]!;
  const { rows } = await fixture.engine.admin.query<{ id: string }>(
    `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, total_amount)
     values ($1, $2, $3, current_date, current_date + 2, 2400)
     returning id;`,
    [fixture.seed.orgId, hotelA.id, roomType.id],
  );
  return rows[0]!.id;
}

describe("maquina de estados de reservation", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("una reserva nueva arranca en 'cotizada' y queda registrada en el evento inicial", async () => {
    const id = await createReservation(fixture);
    const { rows } = await fixture.engine.admin.query<{ from_status: string | null; to_status: string }>(
      "select from_status, to_status from public.reservation_status_event where reservation_id = $1;",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from_status).toBeNull();
    expect(rows[0]!.to_status).toBe("cotizada");
  });

  it("permite la cadena de transiciones valida completa", async () => {
    const id = await createReservation(fixture);
    const chain = ["confirmada", "check_in", "en_estancia", "check_out", "cerrada"];

    for (const status of chain) {
      await fixture.engine.admin.query("update public.reservation set status = $1 where id = $2;", [status, id]);
    }

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.reservation where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("cerrada");

    const { rows: events } = await fixture.engine.admin.query<{ to_status: string }>(
      "select to_status from public.reservation_status_event where reservation_id = $1 order by created_at asc;",
      [id],
    );
    expect(events.map((e) => e.to_status)).toEqual(["cotizada", ...chain]);
  });

  it("rechaza un salto invalido (cotizada -> en_estancia, saltandose confirmada/check_in)", async () => {
    const id = await createReservation(fixture);

    await expect(
      fixture.engine.admin.query("update public.reservation set status = $1 where id = $2;", ["en_estancia", id]),
    ).rejects.toThrow(/transicion_invalida/);

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.reservation where id = $1;",
      [id],
    );
    expect(rows[0]!.status).toBe("cotizada");
  });

  it("rechaza reabrir una reserva cerrada (estado terminal)", async () => {
    const id = await createReservation(fixture);
    for (const status of ["confirmada", "check_in", "en_estancia", "check_out", "cerrada"]) {
      await fixture.engine.admin.query("update public.reservation set status = $1 where id = $2;", [status, id]);
    }

    await expect(
      fixture.engine.admin.query("update public.reservation set status = $1 where id = $2;", ["confirmada", id]),
    ).rejects.toThrow(/transicion_invalida/);
  });

  it("rechaza confirmar una reserva ya cancelada", async () => {
    const id = await createReservation(fixture);
    await fixture.engine.admin.query("update public.reservation set status = 'cancelada' where id = $1;", [id]);

    await expect(
      fixture.engine.admin.query("update public.reservation set status = 'confirmada' where id = $1;", [id]),
    ).rejects.toThrow(/transicion_invalida/);
  });
});
