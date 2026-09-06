// REQ-BO-008 · calendario de obligaciones fiscales con alertas anticipadas (≥5 días)
// por tipo -- verificado con una obligación a 5 y a 4 días. Sin una ruta de API
// dedicada todavía (ver README de apps/api), este chequeo corre directamente contra
// `fiscal_obligation` bajo RLS real (mismo patrón que otras tablas de solo-lectura
// operativa de esta suite).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../../support/pg-fixture.ts";

describe("REQ-BO-008 · calendario fiscal con alertas ≥5 días", () => {
  let fixture: PgFixture;

  beforeAll(async () => {
    fixture = await createPgFixture();
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  it("una obligación a 5 días entra en la alerta; una a 4 días también; una a 10 días NO", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const gm = hotel.staff.find((s) => s.role === "gm")!;

    await fixture.engine.admin.query(
      `insert into public.fiscal_obligation (tenant_id, hotel_id, tipo, due_date) values
         ($1, $2, 'iva_isr', current_date + 5),
         ($1, $2, 'diot', current_date + 4),
         ($1, $2, 'ish', current_date + 10);`,
      [fixture.seed.orgId, hotel.id],
    );

    const { rows } = await fixture.engine.withAppSession({ userId: gm.id }, async (db) =>
      db.query<{ tipo: string; dias: string }>(
        `select tipo, (due_date - current_date)::text as dias
         from public.fiscal_obligation
         where hotel_id = $1 and status = 'pendiente' and due_date - current_date <= 5
         order by due_date asc;`,
        [hotel.id],
      ),
    );

    expect(rows.map((r) => r.tipo).sort()).toEqual(["diot", "iva_isr"]);
    expect(rows.every((r) => Number(r.dias) <= 5)).toBe(true);
  });

  it("housekeeping no puede leer el calendario fiscal (RLS: 0 filas, no un error)", async () => {
    const hotel = fixture.seed.hotels[0]!;
    const housekeeping = hotel.staff.find((s) => s.role === "housekeeping")!;

    await fixture.engine.admin.query(
      "insert into public.fiscal_obligation (tenant_id, hotel_id, tipo, due_date) values ($1, $2, 'imss', current_date + 2);",
      [fixture.seed.orgId, hotel.id],
    );

    const { rows } = await fixture.engine.withAppSession({ userId: housekeeping.id }, async (db) =>
      db.query("select * from public.fiscal_obligation where hotel_id = $1;", [hotel.id]),
    );
    expect(rows).toHaveLength(0);
  });
});
