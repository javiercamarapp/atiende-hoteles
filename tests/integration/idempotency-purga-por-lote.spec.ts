// auditoria-1/datos [MEDIO] pendiente: purga por lote de `idempotency_key` expirada
// (docs/auditoria-1/correccion-bd.md: "no se implementó todavía un job de purga por
// lote ... documentado como siguiente paso, no simulado"). Prueba contra
// embedded-postgres real: filas vencidas se borran en lotes; filas vigentes NUNCA se
// tocan.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";
import { purgeExpiredIdempotencyKeys } from "../../apps/api/src/jobs/purgeIdempotencyKeys.ts";

describe("purgeExpiredIdempotencyKeys: purga por lote de idempotency_key expirada", () => {
  let fixture: PgFixture;
  let orgId: string;

  beforeAll(async () => {
    fixture = await createPgFixture();
    orgId = fixture.seed.orgId;
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  async function insertarLlave(scope: string, key: string, expiresAtSql: string) {
    await fixture.engine.admin.query(
      `insert into public.idempotency_key (tenant_id, scope, key, request_hash, response, expires_at)
       values ($1, $2, $3, 'hash', '{}'::jsonb, ${expiresAtSql});`,
      [orgId, scope, key],
    );
  }

  it("borra SOLO las filas con expires_at < now(), en más de un lote si excede batchSize", async () => {
    for (let i = 0; i < 7; i++) {
      await insertarLlave("purga-test-vencidas", `vencida-${i}`, "now() - interval '1 day'");
    }
    for (let i = 0; i < 3; i++) {
      await insertarLlave("purga-test-vigentes", `vigente-${i}`, "now() + interval '7 days'");
    }

    const resultado = await purgeExpiredIdempotencyKeys(fixture.engine.admin, { batchSize: 3 });

    expect(resultado.deletedTotal).toBe(7);
    expect(resultado.batches).toBe(3); // 3 + 3 + 1

    const { rows: vencidasRestantes } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.idempotency_key where scope = 'purga-test-vencidas';",
    );
    expect(vencidasRestantes[0]!.count).toBe("0");

    const { rows: vigentesRestantes } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.idempotency_key where scope = 'purga-test-vigentes';",
    );
    expect(vigentesRestantes[0]!.count).toBe("3");
  });

  it("sin filas vencidas, no borra nada y reporta 0 lotes", async () => {
    await insertarLlave("purga-test-sin-vencidas", "unica", "now() + interval '1 day'");
    const resultado = await purgeExpiredIdempotencyKeys(fixture.engine.admin, { batchSize: 500 });
    expect(resultado.deletedTotal).toBe(0);
    expect(resultado.batches).toBe(0);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.idempotency_key where scope = 'purga-test-sin-vencidas';",
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("rechaza un batchSize inválido", async () => {
    await expect(purgeExpiredIdempotencyKeys(fixture.engine.admin, { batchSize: 0 })).rejects.toThrow(/batch_size_invalido/);
  });
});
