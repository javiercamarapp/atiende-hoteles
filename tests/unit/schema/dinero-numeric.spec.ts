// REQ-GOB-011: el dinero siempre es numeric(12,2), nunca float/double. Inspecciona el
// catalogo real de Postgres (information_schema) en vez de solo grep sobre el .sql, para
// que la prueba siga siendo valida si alguien reescribe una migracion con otro estilo.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, openPglite, type PgliteEngine } from "@atiende-hoteles/db";

const MONEY_COLUMNS: Array<{ table: string; column: string }> = [
  { table: "rate_plan", column: "price" },
  { table: "reservation", column: "total_amount" },
  { table: "charge", column: "amount" },
  { table: "charge", column: "tax_amount" },
  { table: "payment", column: "amount" },
];

describe("columnas monetarias son numeric(12,2)", () => {
  let engine: PgliteEngine;

  beforeAll(async () => {
    engine = await openPglite();
    await applyMigrations(engine.admin);
  });

  afterAll(async () => {
    await engine.close();
  });

  it.each(MONEY_COLUMNS)("public.$table.$column es numeric(12,2)", async ({ table, column }) => {
    const { rows } = await engine.admin.query<{
      data_type: string;
      numeric_precision: number;
      numeric_scale: number;
    }>(
      `select data_type, numeric_precision, numeric_scale
       from information_schema.columns
       where table_schema = 'public' and table_name = $1 and column_name = $2;`,
      [table, column],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe("numeric");
    expect(rows[0]!.numeric_precision).toBe(12);
    expect(rows[0]!.numeric_scale).toBe(2);
  });

  it("ninguna columna del esquema public usa float4/float8/double precision/real", async () => {
    const { rows } = await engine.admin.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
       from information_schema.columns
       where table_schema = 'public' and data_type in ('real', 'double precision');`,
    );
    expect(rows).toEqual([]);
  });
});
