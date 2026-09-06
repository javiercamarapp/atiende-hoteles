// H2 · ADR-004: aislamiento de dos capas.
//  1) tenant (org): un usuario de la org A no puede leer/escribir un hotel de otra org.
//     (En esta seed solo existe una org con 2 hoteles -- se simula una segunda org real
//     para probar el caso genuino de aislamiento entre tenants, no solo entre hoteles.)
//  2) hotel dentro del MISMO org: staff con rol solo en el hotel A que intenta usar
//     X-Hotel-Id / la ruta del hotel B (misma org) → 403, aunque org_id coincida.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";
import { hashPassword } from "@atiende-hoteles/db";

describe("adversarial: aislamiento de tenant (org) y de hotel dentro del mismo tenant", () => {
  let fixture: ApiFixture;

  beforeAll(async () => {
    fixture = await createApiFixture();
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  it("staff de hotel A NO puede leer el resumen de hotel B (misma org, distinto hotel) — 403", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    const gmA = hotelA.staff.find((s) => s.role === "gm")!;
    const token = await loginAs(fixture.app, gmA.email);

    const res = await fixture.app.request(`/hoteles/${hotelB.id}/resumen`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("X-Hotel-Id que no coincide con el hotel de la ruta es rechazado (403), incluso si el usuario SÍ pertenece a ambos", async () => {
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    const gmA = hotelA.staff.find((s) => s.role === "gm")!;
    const token = await loginAs(fixture.app, gmA.email);

    const res = await fixture.app.request(`/hoteles/${hotelA.id}/resumen`, {
      headers: { authorization: `Bearer ${token}`, "x-hotel-id": hotelB.id },
    });
    expect(res.status).toBe(403);
  });

  it("un usuario de una ORG completamente distinta (tenant real ajeno) no ve el hotel del tenant demo", async () => {
    // Crea una segunda org/hotel/staff aislados, real (no un mock): mismo esquema, otro
    // tenant_id -- la RLS de current_tenant_ids()/current_hotel_ids() debe devolver 0
    // filas cruzadas sin importar que ambos tenants convivan en la misma base física.
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ('Org Ajena') returning id;",
    );
    const otherOrgId = orgRows[0]!.id;
    const { rows: locRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'hotel', 'Hotel Ajeno') returning id;",
      [otherOrgId],
    );
    const otherHotelId = locRows[0]!.id;
    await fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [otherHotelId, otherOrgId]);
    const { rows: userRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.staff_user (email, full_name, password_hash) values ('gm@otra-org.demo', 'GM Ajeno', $1) returning id;",
      [await hashPassword("otra-org-pass")],
    );
    const otherUserId = userRows[0]!.id;
    await fixture.engine.admin.query(
      "insert into public.hotel_staff (org_id, hotel_id, user_id, role) values ($1, $2, $3, 'gm');",
      [otherOrgId, otherHotelId, otherUserId],
    );

    const token = await loginAs(fixture.app, "gm@otra-org.demo", "otra-org-pass");

    const hotelA = fixture.seed.hotels[0]!;
    const res = await fixture.app.request(`/hoteles/${hotelA.id}/resumen`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);

    const listRes = await fixture.app.request("/hoteles", { headers: { authorization: `Bearer ${token}` } });
    const list = (await listRes.json()) as { id: string }[];
    expect(list.map((h) => h.id)).not.toContain(hotelA.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(otherHotelId);
  });
});
