// ADR-005/GOB-026: audit_log es append-only y encadenado por hash. Verifica (a) que la
// cadena de hash es reconstruible/verificable, y (b) que UPDATE/DELETE se rechazan
// siempre, incluso ejecutados con el rol admin/dueño de la tabla.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../support/pglite-fixture.ts";

interface AuditRow {
  id: string;
  tenant_id: string;
  hotel_id: string | null;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  payload: unknown;
  prev_hash: string | null;
  hash: string;
  created_at: string;
}

// Recalcula el hash de una fila leyendo unicamente sus columnas persistidas (prev_hash,
// created_at, etc.) con la MISMA formula que el trigger `audit_log_set_hash()`
// (migrations/0008_audit_log.sql), pero evaluada del lado de Postgres para no depender
// de como el driver de JS formatee `timestamptz` (evita falsos negativos de precision).
const RECOMPUTE_HASH_SQL = `
  select
    hash,
    encode(
      sha256(convert_to(
        coalesce(prev_hash, '<genesis>')
          || '|' || tenant_id::text
          || '|' || coalesce(hotel_id::text, '')
          || '|' || coalesce(actor_user_id::text, '')
          || '|' || action
          || '|' || entity_type
          || '|' || coalesce(entity_id::text, '')
          || '|' || payload::text
          || '|' || created_at::text,
        'UTF8'
      )),
      'hex'
    ) as recomputed
  from public.audit_log
  where id = $1;
`;

describe("audit_log: append-only + cadena de hash", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("cada fila referencia el hash de la fila anterior del mismo tenant y el primero no tiene prev_hash", async () => {
    const orgId = fixture.seed.orgId;
    const hotelA = fixture.seed.hotels[0]!;

    for (const action of ["accion_1", "accion_2", "accion_3"]) {
      await fixture.engine.admin.query(
        "select public.record_audit_log($1, $2, $3, $4, null, $5);",
        [orgId, hotelA.id, action, "test_entity", JSON.stringify({ action })],
      );
    }

    const { rows } = await fixture.engine.admin.query<AuditRow>(
      "select * from public.audit_log where tenant_id = $1 order by created_at asc, id asc;",
      [orgId],
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]!.prev_hash).toBeNull();
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.hash);
  });

  it("el hash almacenado es verificable de forma independiente (recalculado desde las columnas persistidas coincide)", async () => {
    const orgId = fixture.seed.orgId;
    const hotelA = fixture.seed.hotels[0]!;

    await fixture.engine.admin.query("select public.record_audit_log($1, $2, $3, $4, null, $5);", [
      orgId,
      hotelA.id,
      "verificar_hash",
      "test_entity",
      JSON.stringify({ ok: true }),
    ]);

    const { rows } = await fixture.engine.admin.query<AuditRow>(
      "select id from public.audit_log where tenant_id = $1 order by created_at desc limit 1;",
      [orgId],
    );
    const id = rows[0]!.id;

    const { rows: verifyRows } = await fixture.engine.admin.query<{ hash: string; recomputed: string }>(
      RECOMPUTE_HASH_SQL,
      [id],
    );
    expect(verifyRows[0]!.recomputed).toBe(verifyRows[0]!.hash);
  });

  it("una alteracion manual del payload rompe la verificacion del hash (detectada, no silenciosa)", async () => {
    // audit_log bloquea UPDATE por trigger; para probar que la verificacion SI detecta
    // manipulacion, se compara contra un payload alterado sin tocar la fila real (no se
    // puede alterar de verdad: eso es justamente lo que la inmutabilidad impide).
    const orgId = fixture.seed.orgId;
    const hotelA = fixture.seed.hotels[0]!;

    await fixture.engine.admin.query("select public.record_audit_log($1, $2, $3, $4, null, $5);", [
      orgId,
      hotelA.id,
      "accion_original",
      "test_entity",
      JSON.stringify({ monto: 100 }),
    ]);

    const { rows } = await fixture.engine.admin.query<AuditRow>(
      "select id from public.audit_log where tenant_id = $1 order by created_at desc limit 1;",
      [orgId],
    );
    const id = rows[0]!.id;

    const { rows: tamperedRows } = await fixture.engine.admin.query<{
      hash: string;
      recomputed: string;
    }>(
      `select
        hash,
        encode(sha256(convert_to(
          coalesce(prev_hash, '<genesis>')
            || '|' || tenant_id::text
            || '|' || coalesce(hotel_id::text, '')
            || '|' || coalesce(actor_user_id::text, '')
            || '|' || action
            || '|' || entity_type
            || '|' || coalesce(entity_id::text, '')
            || '|' || '{"monto": 999999}'
            || '|' || created_at::text,
          'UTF8'
        )), 'hex') as recomputed
      from public.audit_log where id = $1;`,
      [id],
    );

    expect(tamperedRows[0]!.recomputed).not.toBe(tamperedRows[0]!.hash);
  });

  it("rechaza UPDATE incluso ejecutado con el rol admin/propietario", async () => {
    const orgId = fixture.seed.orgId;
    const hotelA = fixture.seed.hotels[0]!;

    const { rows } = await fixture.engine.admin.query<AuditRow>(
      "select (public.record_audit_log($1, $2, $3, $4, null, $5)).id as id;",
      [orgId, hotelA.id, "intento_editar", "test_entity", JSON.stringify({})],
    );
    const id = (rows[0] as unknown as { id: string }).id;

    await expect(
      fixture.engine.admin.query("update public.audit_log set action = 'editado' where id = $1;", [id]),
    ).rejects.toThrow(/audit_log_append_only/);
  });

  it("rechaza DELETE incluso ejecutado con el rol admin/propietario", async () => {
    const orgId = fixture.seed.orgId;
    const hotelA = fixture.seed.hotels[0]!;

    const { rows } = await fixture.engine.admin.query<AuditRow>(
      "select (public.record_audit_log($1, $2, $3, $4, null, $5)).id as id;",
      [orgId, hotelA.id, "intento_borrar", "test_entity", JSON.stringify({})],
    );
    const id = (rows[0] as unknown as { id: string }).id;

    await expect(
      fixture.engine.admin.query("delete from public.audit_log where id = $1;", [id]),
    ).rejects.toThrow(/audit_log_append_only/);
  });
});
