// El rol `housekeeping` no puede leer (ni escribir) folio/charge/payment; `gm` si puede.
// Cubre la restriccion de roles de ADR-004 sobre las tablas de dinero de ADR-005.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../../support/pglite-fixture.ts";

async function seedFolioForHotelA(fixture: PgliteFixture) {
  const hotelA = fixture.seed.hotels[0]!;
  const roomType = hotelA.roomTypes[0]!;

  const { rows: reservationRows } = await fixture.engine.admin.query<{ id: string }>(
    `insert into public.reservation (tenant_id, hotel_id, room_type_id, check_in_date, check_out_date, total_amount)
     values ($1, $2, $3, current_date, current_date + 1, 1200)
     returning id;`,
    [fixture.seed.orgId, hotelA.id, roomType.id],
  );
  const reservationId = reservationRows[0]!.id;

  const { rows: folioRows } = await fixture.engine.admin.query<{ id: string }>(
    "insert into public.folio (tenant_id, hotel_id, reservation_id) values ($1, $2, $3) returning id;",
    [fixture.seed.orgId, hotelA.id, reservationId],
  );
  const folioId = folioRows[0]!.id;

  await fixture.engine.admin.query(
    "insert into public.charge (tenant_id, hotel_id, folio_id, description, amount) values ($1, $2, $3, $4, $5);",
    [fixture.seed.orgId, hotelA.id, folioId, "Noche de hotel", 1200],
  );
  await fixture.engine.admin.query(
    "insert into public.payment (tenant_id, hotel_id, folio_id, amount, method) values ($1, $2, $3, $4, $5);",
    [fixture.seed.orgId, hotelA.id, folioId, 1200, "tarjeta"],
  );

  return { hotelA, folioId };
}

describe("acceso a dinero restringido por rol (folio/charge/payment)", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("housekeeping no puede leer folio", async () => {
    const { hotelA } = await seedFolioForHotelA(fixture);
    const hk = hotelA.staff.find((s) => s.role === "housekeeping")!;

    const rows = await fixture.engine.withSession({ userId: hk.id }, async (session) => {
      const res = await session.query("select * from public.folio;");
      return res.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("housekeeping no puede leer charge ni payment", async () => {
    const { hotelA } = await seedFolioForHotelA(fixture);
    const hk = hotelA.staff.find((s) => s.role === "housekeeping")!;

    const [charges, payments] = await fixture.engine.withSession({ userId: hk.id }, async (session) => {
      const c = await session.query("select * from public.charge;");
      const p = await session.query("select * from public.payment;");
      return [c.rows, p.rows];
    });

    expect(charges).toHaveLength(0);
    expect(payments).toHaveLength(0);
  });

  it("housekeeping no puede insertar un payment", async () => {
    const { hotelA, folioId } = await seedFolioForHotelA(fixture);
    const hk = hotelA.staff.find((s) => s.role === "housekeeping")!;

    await expect(
      fixture.engine.withSession({ userId: hk.id }, async (session) => {
        await session.query(
          "insert into public.payment (tenant_id, hotel_id, folio_id, amount, method) values ($1, $2, $3, $4, $5);",
          [fixture.seed.orgId, hotelA.id, folioId, 500, "efectivo"],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("gm (rol con acceso a dinero) si puede leer folio/charge/payment de su hotel", async () => {
    const { hotelA } = await seedFolioForHotelA(fixture);
    const gm = hotelA.staff.find((s) => s.role === "gm")!;

    const [folios, charges, payments] = await fixture.engine.withSession(
      { userId: gm.id },
      async (session) => {
        const f = await session.query("select * from public.folio;");
        const c = await session.query("select * from public.charge;");
        const p = await session.query("select * from public.payment;");
        return [f.rows, c.rows, p.rows];
      },
    );

    expect(folios.length).toBe(1);
    expect(charges.length).toBe(1);
    expect(payments.length).toBe(1);
  });
});
