// REQ-TEN-002: "El modelo de datos debe representar cada hotel como una `location` con
// `kind='hotel'` bajo una `org` (tenant), reutilizando el mismo esquema `org`/`location`
// de la línea Restaurantes; el restaurante asociado (si existe) es otra `location`
// enlazada por `property_id`." (docs/REQUISITOS.md).
//
// El esquema (packages/db/migrations/0002_org_location_hotel.sql) ya existía antes de
// esta tarea; lo que faltaba era la VERIFICACIÓN automatizada que exige
// docs/ACEPTACION.md: "Consulta de esquema confirma location.kind='hotel' bajo org, y
// cuando existe restaurante asociado, location(kind='restaurant').property_id enlaza a
// la misma org; una migración que intente crear una tabla `hotel` paralela sin usar
// `location` falla la revisión."
//
// Esta suite corre contra `embedded-postgres` real (ADR-003) -- no PGlite -- porque
// interroga catálogos del sistema (pg_constraint/information_schema) para confirmar la
// FORMA del esquema, no solo su comportamiento funcional; queremos el motor más fiel a
// producción para esa introspección. La mitad estática de la regla ("una migración que
// intente crear una tabla hotel paralela... falla la revisión") vive en
// scripts/checks/schema-location.ts, ejercitado por su propio test unitario.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgFixture, destroyPgFixture, type PgFixture } from "../../support/pg-fixture.ts";

interface CheckConstraintRow {
  definition: string;
}

interface ForeignKeyRow {
  foreign_table: string;
  foreign_column: string;
}

async function fetchCheckConstraints(fixture: PgFixture, table: string): Promise<string[]> {
  const { rows } = await fixture.engine.admin.query<CheckConstraintRow>(
    `select pg_get_constraintdef(oid) as definition
       from pg_constraint
      where conrelid = $1::regclass and contype = 'c';`,
    [`public.${table}`],
  );
  return rows.map((r) => r.definition);
}

async function fetchForeignKey(fixture: PgFixture, table: string, column: string): Promise<ForeignKeyRow | undefined> {
  const { rows } = await fixture.engine.admin.query<ForeignKeyRow>(
    `select ccu.table_name as foreign_table, ccu.column_name as foreign_column
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
       join information_schema.constraint_column_usage ccu
         on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
      where tc.constraint_type = 'FOREIGN KEY'
        and tc.table_schema = 'public'
        and tc.table_name = $1
        and kcu.column_name = $2;`,
    [table, column],
  );
  return rows[0];
}

describe("REQ-TEN-002: hotel = location(kind='hotel') bajo org, restaurante asociado via property_id", () => {
  let fixture: PgFixture;

  beforeAll(async () => {
    fixture = await createPgFixture();
  });

  afterAll(async () => {
    await destroyPgFixture(fixture);
  });

  it("location.org_id es NOT NULL y FK a org(id) -- toda location vive bajo un tenant", async () => {
    const { rows } = await fixture.engine.admin.query<{ is_nullable: string }>(
      `select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'location' and column_name = 'org_id';`,
    );
    expect(rows[0]?.is_nullable).toBe("NO");

    const fk = await fetchForeignKey(fixture, "location", "org_id");
    expect(fk).toEqual({ foreign_table: "org", foreign_column: "id" });
  });

  it("location.kind tiene un CHECK que solo permite 'hotel' o 'restaurant'", async () => {
    const defs = await fetchCheckConstraints(fixture, "location");
    const kindCheck = defs.find((d) => d.includes("kind"));
    expect(kindCheck).toBeDefined();
    expect(kindCheck).toMatch(/'hotel'/);
    expect(kindCheck).toMatch(/'restaurant'/);

    // Confirma en vivo, no solo por texto del constraint: un kind fuera del catálogo
    // cerrado es rechazado por Postgres.
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ($1) returning id;",
      ["Org para probar CHECK de kind"],
    );
    await expect(
      fixture.engine.admin.query("insert into public.location (org_id, kind, name) values ($1, $2, $3);", [
        orgRows[0]!.id,
        "spa",
        "Spa inventado",
      ]),
    ).rejects.toThrow();
  });

  it("public.hotel es la extensión 1:1 de location: hotel.id es PK y FK a location(id) (no una tabla paralela)", async () => {
    const fk = await fetchForeignKey(fixture, "hotel", "id");
    expect(fk).toEqual({ foreign_table: "location", foreign_column: "id" });

    // "1:1" no es solo intención: hotel.id debe ser la PRIMARY KEY de hotel (no una
    // columna cualquiera con FK), así ningún location puede tener dos filas de hotel.
    const { rows: pkRows } = await fixture.engine.admin.query<{ column_name: string }>(
      `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
        where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public' and tc.table_name = 'hotel';`,
    );
    expect(pkRows.map((r) => r.column_name)).toEqual(["id"]);

    // Solo debe existir UNA tabla llamada "hotel" en el esquema public -- si algún día
    // apareciera una segunda tabla "hotel" paralela (bypaseando location), esta
    // aserción la atrapa incluso si scripts/checks/schema-location.ts no corriera.
    const { rows: tableRows } = await fixture.engine.admin.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
        where table_schema = 'public' and table_name = 'hotel';`,
    );
    expect(tableRows[0]?.count).toBe("1");
  });

  it("el trigger enforce_hotel_location_kind rechaza extender una location que NO es kind='hotel'", async () => {
    const { rows: orgRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.org (name) values ($1) returning id;",
      ["Org para probar trigger de kind"],
    );
    const orgId = orgRows[0]!.id;
    const { rows: locRows } = await fixture.engine.admin.query<{ id: string }>(
      "insert into public.location (org_id, kind, name) values ($1, 'restaurant', $2) returning id;",
      [orgId, "Restaurante suelto (sin hotel asociado)"],
    );
    const restaurantLocationId = locRows[0]!.id;

    await expect(
      fixture.engine.admin.query("insert into public.hotel (id, org_id) values ($1, $2);", [
        restaurantLocationId,
        orgId,
      ]),
    ).rejects.toThrow(/kind=hotel/);
  });

  it("consulta de esquema confirma: cada hotel sembrado es una location kind='hotel' bajo su org", async () => {
    const seed = fixture.seed;
    expect(seed.hotels.length).toBeGreaterThan(0);

    for (const hotel of seed.hotels) {
      const { rows } = await fixture.engine.admin.query<{ kind: string; org_id: string; hotel_org_id: string }>(
        `select l.kind, l.org_id, h.org_id as hotel_org_id
           from public.location l
           join public.hotel h on h.id = l.id
          where l.id = $1;`,
        [hotel.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe("hotel");
      expect(rows[0]!.org_id).toBe(seed.orgId);
      expect(rows[0]!.hotel_org_id).toBe(seed.orgId);
    }
  });

  it("cuando existe un restaurante asociado, location(kind='restaurant').property_id enlaza a la misma org que el hotel", async () => {
    const seed = fixture.seed;
    const hotel = seed.hotels[0]!;

    const { rows: restaurantRows } = await fixture.engine.admin.query<{ id: string }>(
      `insert into public.location (org_id, kind, name, property_id)
       values ($1, 'restaurant', $2, $3) returning id;`,
      [seed.orgId, `Restaurante de ${hotel.name}`, hotel.id],
    );
    const restaurantLocationId = restaurantRows[0]!.id;

    const { rows } = await fixture.engine.admin.query<{
      restaurant_org: string;
      hotel_org: string;
      hotel_kind: string;
      restaurant_kind: string;
    }>(
      `select r.org_id as restaurant_org, h.org_id as hotel_org, h.kind as hotel_kind, r.kind as restaurant_kind
         from public.location r
         join public.location h on h.id = r.property_id
        where r.id = $1;`,
      [restaurantLocationId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.restaurant_kind).toBe("restaurant");
    expect(rows[0]!.hotel_kind).toBe("hotel");
    // La aserción central de REQ-TEN-002: el restaurante asociado enlaza (via
    // property_id) a una location que comparte la MISMA org (tenant) que él.
    expect(rows[0]!.restaurant_org).toBe(rows[0]!.hotel_org);
    expect(rows[0]!.restaurant_org).toBe(seed.orgId);
  });

  it("una location sin restaurante asociado tiene property_id NULL (la asociación es opcional, no fabricada)", async () => {
    const seed = fixture.seed;
    const { rows } = await fixture.engine.admin.query<{ property_id: string | null }>(
      "select property_id from public.location where id = $1;",
      [seed.hotels[0]!.id],
    );
    expect(rows[0]?.property_id).toBeNull();
  });
});
