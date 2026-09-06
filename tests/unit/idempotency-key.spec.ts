// ADR-004: toda mutacion con efecto externo exige idempotency_key unico por
// (tenant_id, scope, key). Verifica el constraint UNIQUE y el patron
// INSERT ... ON CONFLICT DO NOTHING que evita duplicar el efecto.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../support/pglite-fixture.ts";

describe("idempotency_key: unicidad por (tenant_id, scope, key)", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("un INSERT plano con la misma clave dos veces es rechazado por el constraint UNIQUE", async () => {
    const orgId = fixture.seed.orgId;

    await fixture.engine.admin.query(
      "insert into public.idempotency_key (tenant_id, scope, key) values ($1, $2, $3);",
      [orgId, "reservation.create", "clave-abc"],
    );

    await expect(
      fixture.engine.admin.query(
        "insert into public.idempotency_key (tenant_id, scope, key) values ($1, $2, $3);",
        [orgId, "reservation.create", "clave-abc"],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("INSERT ... ON CONFLICT DO NOTHING con la misma clave no duplica la fila (patron real de la app)", async () => {
    const orgId = fixture.seed.orgId;
    const sql = `
      insert into public.idempotency_key (tenant_id, scope, key, resource_id)
      values ($1, $2, $3, $4)
      on conflict (tenant_id, scope, key) do nothing
      returning id;
    `;
    const resourceId1 = "11111111-1111-1111-1111-111111111111";
    const resourceId2 = "22222222-2222-2222-2222-222222222222";

    const first = await fixture.engine.admin.query(sql, [orgId, "reservation.create", "clave-xyz", resourceId1]);
    const second = await fixture.engine.admin.query(sql, [orgId, "reservation.create", "clave-xyz", resourceId2]);

    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(0);

    const { rows } = await fixture.engine.admin.query<{ resource_id: string; count: string }>(
      "select resource_id, count(*)::text as count from public.idempotency_key where tenant_id = $1 and scope = $2 and key = $3 group by resource_id;",
      [orgId, "reservation.create", "clave-xyz"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe("1");
    expect(rows[0]!.resource_id).toBe(resourceId1);
  });

  it("la misma clave en dos tenants distintos NO colisiona (unicidad es por tenant)", async () => {
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ($1) returning id;",
      ["Otro Grupo"],
    );
    const secondOrgId = orgRows[0]!.id;

    await fixture.engine.admin.query(
      "insert into public.idempotency_key (tenant_id, scope, key) values ($1, $2, $3);",
      [fixture.seed.orgId, "reservation.create", "misma-clave"],
    );

    await expect(
      fixture.engine.admin.query(
        "insert into public.idempotency_key (tenant_id, scope, key) values ($1, $2, $3);",
        [secondOrgId, "reservation.create", "misma-clave"],
      ),
    ).resolves.toBeDefined();
  });
});
