// H4 · REQ-RES-008/H02-012: job de no-show (jobs/noShow.ts) vía
// POST /hoteles/:hotelId/reservas/procesar-no-show. Una reserva 'confirmada' cuya
// fecha de llegada ya pasó se marca 'no_show', libera su inventario y calcula el cargo
// de política — una segunda corrida del mismo job no la vuelve a procesar (idempotente).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../support/api-fixture.ts";

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

describe("job de no-show idempotente (REQ-RES-008)", () => {
  let fixture: ApiFixture;
  let ownerToken: string;
  let hotelId: string;
  let roomTypeId: string;
  let reservationId: string;
  const checkIn = isoDate(-2); // ya pasó
  const checkOut = isoDate(-1);

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;
    ownerToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "owner")!.email);

    // Inventario de una fecha pasada: el seed solo siembra desde "hoy" en adelante.
    await fixture.engine.admin.query(
      `insert into public.availability (tenant_id, hotel_id, room_type_id, date, total_rooms, booked_rooms)
       values ($1, $2, $3, $4, 5, 1)
       on conflict (hotel_id, room_type_id, date) do update set booked_rooms = 1;`,
      [fixture.seed.orgId, hotelId, roomTypeId, checkIn],
    );

    const { rows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, total_amount)
       values ($1, $2, $3, $4, $5, 1500)
       returning id;`,
      [fixture.seed.orgId, hotelId, roomTypeId, checkIn, checkOut],
    );
    reservationId = rows[0]!.id;
    await fixture.engine.admin.query("update public.reservation set status = 'confirmada' where id = $1;", [reservationId]);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function dispararJob() {
    return fixture.app.request(`/hoteles/${hotelId}/reservas/procesar-no-show`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  }

  it("primera corrida: marca no_show, libera inventario y calcula el cargo (100% del total, política sembrada)", async () => {
    const res = await dispararJob();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { procesados: { id: string; montoCargo: number }[] };
    expect(body.procesados.map((p) => p.id)).toContain(reservationId);
    const procesado = body.procesados.find((p) => p.id === reservationId)!;
    expect(procesado.montoCargo).toBe(1500); // no_show_pct = 100 (seed)

    const { rows } = await fixture.engine.admin.query<{ status: string }>(
      "select status from public.reservation where id = $1;",
      [reservationId],
    );
    expect(rows[0]!.status).toBe("no_show");

    const { rows: availRows } = await fixture.engine.admin.query<{ booked_rooms: number }>(
      "select booked_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, checkIn],
    );
    expect(availRows[0]!.booked_rooms).toBe(0);
  });

  it("segunda corrida: idempotente, no vuelve a procesar la misma reserva ni libera inventario dos veces", async () => {
    const res = await dispararJob();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { procesados: { id: string }[] };
    expect(body.procesados.map((p) => p.id)).not.toContain(reservationId);

    const { rows: availRows } = await fixture.engine.admin.query<{ booked_rooms: number }>(
      "select booked_rooms from public.availability where hotel_id = $1 and room_type_id = $2 and date = $3;",
      [hotelId, roomTypeId, checkIn],
    );
    expect(availRows[0]!.booked_rooms).toBe(0); // nunca negativo, nunca vuelve a bajar
  });

  it("frontdesk/reservations NO pueden disparar el job (solo owner/gm, ADMIN_ROLES)", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const frontdeskToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "frontdesk")!.email);
    const res = await fixture.app.request(`/hoteles/${hotelId}/reservas/procesar-no-show`, {
      method: "POST",
      headers: { authorization: `Bearer ${frontdeskToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});
