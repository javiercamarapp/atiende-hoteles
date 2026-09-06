// REQ-TEN-001: un usuario del hotel A no ve ni escribe filas del hotel B, para las 4
// operaciones (SELECT/INSERT/UPDATE/DELETE), sobre una tabla de dominio representativa
// (room_type). Corre contra PGlite (ADR-003): suficiente para probar la LOGICA de RLS,
// aunque no contencion real (eso lo cubre tests/integration).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../../support/pglite-fixture.ts";

describe("aislamiento de tenant entre hoteles (RLS, room_type)", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  function actors() {
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    const gmA = hotelA.staff.find((s) => s.role === "gm")!;
    return { hotelA, hotelB, gmA };
  }

  it("SELECT: solo devuelve filas del hotel del usuario", async () => {
    const { hotelA, hotelB, gmA } = actors();

    const rows = await fixture.engine.withSession({ userId: gmA.id }, async (session) => {
      const res = await session.query<{ hotel_id: string }>(
        "select hotel_id from public.room_type;",
      );
      return res.rows;
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.hotel_id === hotelA.id)).toBe(true);
    expect(rows.some((r) => r.hotel_id === hotelB.id)).toBe(false);
  });

  it("INSERT: rechazado con violacion de politica al escribir en el hotel ajeno", async () => {
    const { hotelB, gmA } = actors();

    await expect(
      fixture.engine.withSession({ userId: gmA.id }, async (session) => {
        await session.query(
          "insert into public.room_type (tenant_id, hotel_id, name) values ($1, $2, $3);",
          [fixture.seed.orgId, hotelB.id, "Intento cruzado"],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("UPDATE: 0 filas afectadas sobre una fila del hotel ajeno (no error de aplicacion)", async () => {
    const { hotelB, gmA } = actors();
    const target = hotelB.roomTypes[0]!;

    const updated = await fixture.engine.withSession({ userId: gmA.id }, async (session) => {
      const res = await session.query<{ id: string }>(
        "update public.room_type set name = $1 where id = $2 returning id;",
        ["Hackeado", target.id],
      );
      return res.rows;
    });

    expect(updated).toHaveLength(0);

    const { rows: check } = await fixture.engine.admin.query<{ name: string }>(
      "select name from public.room_type where id = $1;",
      [target.id],
    );
    expect(check[0]!.name).toBe(target.name);
  });

  it("DELETE: 0 filas afectadas sobre una fila del hotel ajeno (no error de aplicacion)", async () => {
    const { hotelB, gmA } = actors();
    const target = hotelB.roomTypes[1]!;

    const deleted = await fixture.engine.withSession({ userId: gmA.id }, async (session) => {
      const res = await session.query<{ id: string }>(
        "delete from public.room_type where id = $1 returning id;",
        [target.id],
      );
      return res.rows;
    });

    expect(deleted).toHaveLength(0);

    const { rows: check } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.room_type where id = $1;",
      [target.id],
    );
    expect(check).toHaveLength(1);
  });
});
