// H12b · LAUNCH-007: RLS + función de la consola superadmin cross-tenant
// (packages/db/migrations/0100_platform_admin_console.sql). Verifica, contra Postgres
// real (PGlite, no solo lectura del SQL):
//   1. Un staff normal (no superadmin) NO ve ninguna fila de `platform_admin` ni de
//      `platform_admin_audit_log` (RLS vacía, no un 403 -- estas tablas nunca las lee la
//      UI directo, pero la política tiene que sostenerse igual si algo las consultara).
//   2. `admin_negocio()` lanza `no_autorizado` para un staff normal.
//   3. Una vez otorgado `platform_admin` (alta manual, GOB-058: nunca autoservicio),
//      `admin_negocio()` agrega AMBOS hoteles sembrados (cruza tenants a propósito) y
//      queda auditada en `platform_admin_audit_log`.
//   4. `admin_reintentar_outbox()` es la ÚNICA escritura operativa permitida: revive un
//      evento en dead-letter sin tocar ninguna tabla de negocio.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgliteFixture, destroyPgliteFixture, type PgliteFixture } from "../../support/pglite-fixture.ts";

describe("consola superadmin: platform_admin/admin_negocio (RLS + security definer)", () => {
  let fixture: PgliteFixture;

  beforeEach(async () => {
    fixture = await createPgliteFixture();
  });

  afterEach(async () => {
    await destroyPgliteFixture(fixture);
  });

  it("un staff normal no ve filas de platform_admin ni de platform_admin_audit_log (RLS vacía)", async () => {
    const owner = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!;

    // Otro usuario SÍ es superadmin (para que la tabla no esté vacía de verdad) --
    // así la ausencia de filas para `owner` prueba la política, no que la tabla está sin
    // datos.
    const otroSuperadmin = fixture.seed.hotels[1]!.staff.find((s) => s.role === "owner")!;
    await fixture.engine.admin.query("insert into public.platform_admin (user_id) values ($1);", [otroSuperadmin.id]);

    await fixture.engine.withSession({ userId: owner.id }, async (session) => {
      const { rows: pa } = await session.query("select * from public.platform_admin;");
      expect(pa).toHaveLength(0);
      const { rows: log } = await session.query("select * from public.platform_admin_audit_log;");
      expect(log).toHaveLength(0);
    });
  });

  it("admin_negocio() lanza no_autorizado para un staff que no es superadmin de plataforma", async () => {
    const owner = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!;

    await expect(
      fixture.engine.withSession({ userId: owner.id }, async (session) => {
        await session.query("select public.admin_negocio();");
      }),
    ).rejects.toThrow(/no_autorizado/);
  });

  it("admin_negocio() agrega AMBOS hoteles cruzando tenants una vez otorgado platform_admin, y queda auditado", async () => {
    const superadmin = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!;
    await fixture.engine.admin.query("insert into public.platform_admin (user_id) values ($1);", [superadmin.id]);

    const resultado = await fixture.engine.withSession({ userId: superadmin.id }, async (session) => {
      const { rows } = await session.query<{ admin_negocio: { hoteles: { hotel_id: string }[]; metricasGlobales: { hotelesTotal: number } } }>(
        "select public.admin_negocio() as admin_negocio;",
      );
      return rows[0]!.admin_negocio;
    });

    const idsDevueltos = new Set(resultado.hoteles.map((h) => h.hotel_id));
    expect(idsDevueltos.has(fixture.seed.hotels[0]!.id)).toBe(true);
    expect(idsDevueltos.has(fixture.seed.hotels[1]!.id)).toBe(true);
    expect(resultado.metricasGlobales.hotelesTotal).toBe(2);

    // Auditoría: la propia función security definer dejó rastro (visible para el mismo
    // superadmin, RLS "platform_admin_audit_superadmin_select").
    const auditoria = await fixture.engine.withSession({ userId: superadmin.id }, async (session) => {
      const { rows } = await session.query<{ action: string }>("select action from public.platform_admin_audit_log;");
      return rows;
    });
    expect(auditoria.some((r) => r.action === "admin_negocio")).toBe(true);
  });

  it("admin_reintentar_outbox() es la única escritura permitida: revive un evento dead-letter sin tocar datos de negocio", async () => {
    const superadmin = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!;
    await fixture.engine.admin.query("insert into public.platform_admin (user_id) values ($1);", [superadmin.id]);

    const { rows: outboxRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, status, attempts, last_error)
       values ($1, $2, 'reservation', gen_random_uuid(), 'reservation.confirmada', 'fallido', 5, 'timeout simulado')
       returning id;`,
      [fixture.seed.orgId, fixture.seed.hotels[0]!.id],
    );
    const outboxId = outboxRows[0]!.id;

    await fixture.engine.withSession({ userId: superadmin.id }, async (session) => {
      await session.query("select public.admin_reintentar_outbox($1);", [outboxId]);
    });

    const { rows: despues } = await fixture.engine.admin.query<{ status: string; attempts: number; last_error: string | null }>(
      "select status, attempts, last_error from public.outbox where id = $1;",
      [outboxId],
    );
    expect(despues[0]!.status).toBe("pendiente");
    expect(despues[0]!.attempts).toBe(0);
    expect(despues[0]!.last_error).toBeNull();
  });

  it("admin_reintentar_outbox() también lanza no_autorizado para un staff que no es superadmin", async () => {
    const owner = fixture.seed.hotels[0]!.staff.find((s) => s.role === "owner")!;
    const { rows: outboxRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, status)
       values ($1, $2, 'reservation', gen_random_uuid(), 'reservation.confirmada', 'fallido')
       returning id;`,
      [fixture.seed.orgId, fixture.seed.hotels[0]!.id],
    );
    const outboxId = outboxRows[0]!.id;

    await expect(
      fixture.engine.withSession({ userId: owner.id }, async (session) => {
        await session.query("select public.admin_reintentar_outbox($1);", [outboxId]);
      }),
    ).rejects.toThrow(/no_autorizado/);
  });
});
