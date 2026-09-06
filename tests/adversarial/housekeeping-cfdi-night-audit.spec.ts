// H5 · defensa en profundidad: housekeeping/maintenance no pueden leer `cfdi_emision`
// ni `night_audit_run` por RLS (aunque nunca lleguen ahí por la API, que ya los
// rechaza con 403 -- ver tests/integration/revenue/night-audit.spec.ts y
// tests/adversarial/cargo-folio-verificacion.spec.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../support/pg-fixture.ts";

describe("adversarial: housekeeping/maintenance no ven CFDI ni night audit (RLS)", () => {
  let fixture: PgFixture;

  beforeAll(async () => {
    fixture = await createPgFixture();
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  it("housekeeping: 0 filas de cfdi_emision aunque existan para su propio hotel", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const housekeeping = hotel.staff.find((s) => s.role === "housekeeping")!;
    const { rows: folioRows } = await fixture.engine.admin.query<{ id: string }>(
      "select id from public.folio limit 1;",
    );
    if (folioRows.length > 0) {
      await fixture.engine.admin.query(
        `insert into public.cfdi_emision
           (tenant_id, hotel_id, folio_id, tipo, status, subtotal, iva, total, rfc_receptor, uso_cfdi, metodo_pago)
         values ($1, $2, $3, 'hospedaje', 'timbrado', 100, 16, 116, 'XAXX010101000', 'S01', 'PUE');`,
        [fixture.seed.orgId, hotel.id, folioRows[0]!.id],
      );
    }

    const { rows } = await fixture.engine.withAppSession({ userId: housekeeping.id }, async (db) =>
      db.query("select * from public.cfdi_emision where hotel_id = $1;", [hotel.id]),
    );
    expect(rows).toHaveLength(0);
  });

  it("maintenance: 0 filas de night_audit_run aunque existan para su propio hotel", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const maintenance = hotel.staff.find((s) => s.role === "maintenance")!;

    const { rows: claimRows } = await fixture.engine.admin.query<{ run_id: string }>(
      "select run_id from public.night_audit_claim($1, $2, current_date);",
      [fixture.seed.orgId, hotel.id],
    );
    expect(claimRows).toHaveLength(1);

    const { rows } = await fixture.engine.withAppSession({ userId: maintenance.id }, async (db) =>
      db.query("select * from public.night_audit_run where hotel_id = $1;", [hotel.id]),
    );
    expect(rows).toHaveLength(0);
  });

  it("gm (rol con acceso a dinero) SÍ ve ambas tablas de su propio hotel", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const gm = hotel.staff.find((s) => s.role === "gm")!;

    const { rows } = await fixture.engine.withAppSession({ userId: gm.id }, async (db) =>
      db.query("select * from public.night_audit_run where hotel_id = $1;", [hotel.id]),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
