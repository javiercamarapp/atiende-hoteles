// REQ-RES-021 · Regresión de divergencia (ver cabecera de
// `packages/db/migrations/0130_mcp_hotel_server.sql`): `compute_mcp_room_type_quote()`
// (SQL, usado por el servidor MCP) reimplementa DELIBERADAMENTE, acotado al NETO, el
// mismo cálculo que `computeQuote()` (TypeScript, usado por el motor de reservas de
// staff, `packages/domain-hotel/src/quote.ts`). Esta prueba alimenta AMBOS motores con
// las MISMAS filas reales de `rate_plan` (incluida una tarifa con `min_stay=2` y una
// noche cerrada a llegada) y exige el MISMO resultado -- si algún día alguien cambia
// uno de los dos sin el otro, esta prueba lo detecta antes de producción.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeQuote, parseQuoteInput, QuoteError, type NightlyRate } from "@atiende-hoteles/domain-hotel";
import { createApiFixture, destroyApiFixture, type ApiFixture } from "../../../support/api-fixture.ts";

interface RatePlanRow {
  date: string;
  price: string;
  min_stay: number;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
}

interface McpQuoteRow {
  net_amount: string | null;
  nights: number;
  currency: string | null;
  reason: string | null;
}

describe("paridad SQL (servidor MCP) vs. TypeScript (motor interno) del cálculo de neto (REQ-RES-021)", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  let roomTypeId: string;
  let dates: string[];

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;

    const { rows } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    dates = rows.map((r) => r.date);
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  async function loadRatePlan(): Promise<NightlyRate[]> {
    const { rows } = await fixture.engine.admin.query<RatePlanRow>(
      `select date::text as date, price::text as price, min_stay, closed_to_arrival, closed_to_departure
       from public.rate_plan where hotel_id = $1 and room_type_id = $2 order by date asc;`,
      [hotelId, roomTypeId],
    );
    return rows.map((r) => ({
      date: r.date,
      price: Number(r.price),
      minStay: r.min_stay,
      closedToArrival: r.closed_to_arrival,
      closedToDeparture: r.closed_to_departure,
    }));
  }

  async function mcpQuote(checkIn: string, checkOut: string): Promise<McpQuoteRow> {
    const { rows } = await fixture.engine.admin.query<McpQuoteRow>(
      "select net_amount::text as net_amount, nights, currency, reason from public.compute_mcp_room_type_quote($1, $2, $3);",
      [roomTypeId, checkIn, checkOut],
    );
    return rows[0]!;
  }

  it("con tarifas planas (seed por defecto), ambos motores calculan el MISMO neto", async () => {
    const checkIn = dates[0]!;
    const checkOut = dates[2]!;
    const nightlyRates = await loadRatePlan();

    const tsQuote = computeQuote(
      parseQuoteInput({ checkInDate: checkIn, checkOutDate: checkOut, nightlyRates, taxConfig: { ivaRate: 0, ishRate: 0 } }),
    );
    const sqlQuote = await mcpQuote(checkIn, checkOut);

    expect(sqlQuote.reason).toBeNull();
    expect(Number(sqlQuote.net_amount)).toBe(tsQuote.netAmount);
    expect(sqlQuote.nights).toBe(tsQuote.nights);
  });

  it("con min-stay=2 en la llegada, ambos motores RECHAZAN una estadía de 1 noche con el mismo código", async () => {
    const checkIn = dates[0]!;
    const checkOut = dates[1]!;
    await fixture.engine.admin.query("update public.rate_plan set min_stay = 2 where room_type_id = $1 and date = $2;", [roomTypeId, checkIn]);

    const nightlyRates = await loadRatePlan();
    let tsCode: string | null = null;
    try {
      computeQuote(parseQuoteInput({ checkInDate: checkIn, checkOutDate: checkOut, nightlyRates, taxConfig: { ivaRate: 0, ishRate: 0 } }));
    } catch (err) {
      tsCode = err instanceof QuoteError ? err.code : "error_inesperado";
    }
    const sqlQuote = await mcpQuote(checkIn, checkOut);

    expect(tsCode).toBe("estadia_minima_no_alcanzada");
    expect(sqlQuote.reason).toBe("estadia_minima_no_alcanzada");
  });

  it("con CTA (closed_to_arrival) en la fecha de llegada, ambos motores RECHAZAN con el mismo código", async () => {
    const checkIn = dates[3]!;
    const checkOut = dates[4]!;
    await fixture.engine.admin.query("update public.rate_plan set closed_to_arrival = true where room_type_id = $1 and date = $2;", [roomTypeId, checkIn]);

    const nightlyRates = await loadRatePlan();
    let tsCode: string | null = null;
    try {
      computeQuote(parseQuoteInput({ checkInDate: checkIn, checkOutDate: checkOut, nightlyRates, taxConfig: { ivaRate: 0, ishRate: 0 } }));
    } catch (err) {
      tsCode = err instanceof QuoteError ? err.code : "error_inesperado";
    }
    const sqlQuote = await mcpQuote(checkIn, checkOut);

    expect(tsCode).toBe("cerrado_a_llegada");
    expect(sqlQuote.reason).toBe("cerrado_a_llegada");
  });

  it("con precios distintos por noche, ambos motores suman EXACTAMENTE lo mismo", async () => {
    const checkIn = dates[5]!;
    const mid = dates[6]!;
    const checkOut = dates[7]!;
    await fixture.engine.admin.query("update public.rate_plan set price = 1111.50 where room_type_id = $1 and date = $2;", [roomTypeId, checkIn]);
    await fixture.engine.admin.query("update public.rate_plan set price = 2222.75 where room_type_id = $1 and date = $2;", [roomTypeId, mid]);

    const nightlyRates = await loadRatePlan();
    const tsQuote = computeQuote(
      parseQuoteInput({ checkInDate: checkIn, checkOutDate: checkOut, nightlyRates, taxConfig: { ivaRate: 0, ishRate: 0 } }),
    );
    const sqlQuote = await mcpQuote(checkIn, checkOut);

    expect(sqlQuote.reason).toBeNull();
    expect(Number(sqlQuote.net_amount)).toBe(tsQuote.netAmount);
  });
});
