// REQ-TEN-001/ADR-004: el limite de aislamiento multi-tenant es el `org` (tenant), no el
// `hotel` (scope secundario, cubierto por tests/unit/rls/tenant-isolation.spec.ts). Este
// spec crea un SEGUNDO org independiente (no el que ya siembra el fixture compartido,
// que a proposito modela 2 hoteles bajo el MISMO org) para probar el limite real de
// "sesion de tenant B" que exige REQ-TEN-001, no solo el scope de hotel dentro del mismo
// tenant.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../../support/pglite-fixture.ts";

interface OtherOrg {
  orgId: string;
  hotelId: string;
  roomTypeId: string;
  gmUserId: string;
}

async function seedIndependentOrg(fixture: PgliteFixture): Promise<OtherOrg> {
  const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
    "insert into public.org (name) values ($1) returning id;",
    ["Tenant B — org totalmente distinto"],
  );
  const orgId = orgRows[0]!.id;

  const { rows: locationRows } = await fixture.engine.admin.query<{ id: string }>(
    "insert into public.location (org_id, kind, name) values ($1, 'hotel', $2) returning id;",
    [orgId, "Hotel Tenant B"],
  );
  const hotelId = locationRows[0]!.id;
  await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [hotelId, orgId]);

  const { rows: roomTypeRows } = await fixture.engine.admin.query<{ id: string }>(
    "insert into public.room_type (tenant_id, hotel_id, name) values ($1, $2, $3) returning id;",
    [orgId, hotelId, "Estandar B"],
  );
  const roomTypeId = roomTypeRows[0]!.id;

  const { rows: userRows } = await fixture.engine.admin.query<{ id: string }>(
    "insert into public.staff_user (email, full_name) values ($1, $2) returning id;",
    ["gm@tenant-b.demo", "GM Tenant B"],
  );
  const gmUserId = userRows[0]!.id;
  await fixture.engine.admin.query(
    "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'gm');",
    [orgId, hotelId, gmUserId],
  );

  return { orgId, hotelId, roomTypeId, gmUserId };
}

describe("aislamiento entre ORGS (tenants) distintos, no solo entre hoteles del mismo org", () => {
  let fixture: PgliteFixture;
  let otherOrg: OtherOrg;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
    otherOrg = await seedIndependentOrg(fixture);
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("SELECT: un usuario del org compartido del fixture no ve nada del org independiente", async () => {
    const gmSeedOrg = fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!;

    const rows = await fixture.engine.withSession({ userId: gmSeedOrg.id }, async (session) => {
      const res = await session.query<{ id: string }>(
        "select id from public.room_type where id = $1;",
        [otherOrg.roomTypeId],
      );
      return res.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("SELECT: un usuario del org independiente tampoco ve el org compartido del fixture", async () => {
    const seedRoomType = fixture.seed.hotels[0]!.roomTypes[0]!;

    const rows = await fixture.engine.withSession({ userId: otherOrg.gmUserId }, async (session) => {
      const res = await session.query<{ id: string }>(
        "select id from public.room_type where id = $1;",
        [seedRoomType.id],
      );
      return res.rows;
    });

    expect(rows).toHaveLength(0);
  });

  it("current_tenant_ids() del usuario del org independiente NO incluye el org del fixture", async () => {
    const tenantIds = await fixture.engine.withSession({ userId: otherOrg.gmUserId }, async (session) => {
      const res = await session.query<{ ids: string[] }>("select current_tenant_ids() as ids;");
      return res.rows[0]!.ids;
    });

    expect(tenantIds).toEqual([otherOrg.orgId]);
    expect(tenantIds).not.toContain(fixture.seed.orgId);
  });

  it("INSERT: rechazado al intentar escribir en el hotel de otro org", async () => {
    const gmSeedOrg = fixture.seed.hotels[0]!.staff.find((s) => s.role === "gm")!;

    await expect(
      fixture.engine.withSession({ userId: gmSeedOrg.id }, async (session) => {
        await session.query(
          "insert into public.room_type (tenant_id, hotel_id, name) values ($1, $2, $3);",
          [otherOrg.orgId, otherOrg.hotelId, "Intento cross-org"],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});
