// H4 · POST /hoteles/:hotelId/quotes — REQ-REV-001/REQ-RES-002: motor de cotización
// determinista. El body de entrada NUNCA acepta un campo de precio/total: solo
// identificadores (roomTypeId/checkInDate/checkOutDate) — arquitectónicamente ni un
// LLM ni el propio cliente HTTP puede inyectar un precio final, ver
// packages/domain-hotel/src/quote.ts (`parseQuoteInput` descarta cualquier campo que no
// sea una columna real de `rate_plan`).
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { quoteConvertedToReportingCurrency } from "../pms/quoteConversion.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");

const quoteSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    checkInDate: dateSchema,
    checkOutDate: dateSchema,
  })
  .refine((v) => v.checkOutDate > v.checkInDate, {
    message: "checkOutDate debe ser posterior a checkInDate",
    path: ["checkOutDate"],
  });

export function quotesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/quotes",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.post("/hoteles/:hotelId/quotes", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(quoteSchema, await c.req.json().catch(() => ({})));

    const { rows: roomTypeRows } = await db.query<{ id: string }>(
      "select id from public.room_type where id = $1 and hotel_id = $2;",
      [body.roomTypeId, hotelId],
    );
    if (roomTypeRows.length === 0) throw Errors.notFound("Tipo de habitación no encontrado en este hotel.");

    // REQ-RES-015: `quoteConvertedToReportingCurrency` cotiza (mismo motor determinista
    // de siempre) y, si la tarifa está fijada en una divisa distinta a la de reporte del
    // motor de reservas, la convierte ACTIVAMENTE con el tipo de cambio vigente
    // registrado por el hotel (fail-closed: 409 explícito sin tasa vigente, nunca un
    // total inventado o en la moneda equivocada). `netAmount`/`ivaAmount`/`ishAmount`/
    // `totalAmount`/`currency` de la respuesta son los montos REALES que el motor
    // cobra/reporta (idénticos a los de `quote` cuando la tarifa ya estaba en la moneda
    // de reporte); `monedaOriginal`/`montoOriginal`/`tipoCambioAplicado` dejan trazable
    // la tarifa tal como el hotel la fijó, sin perder esa información en la conversión.
    const converted = await quoteConvertedToReportingCurrency(db, {
      hotelId,
      roomTypeId: body.roomTypeId,
      checkInDate: body.checkInDate,
      checkOutDate: body.checkOutDate,
    });

    return c.json(
      {
        roomTypeId: body.roomTypeId,
        nights: converted.quote.nights,
        nightlyBreakdown: converted.quote.nightlyBreakdown,
        currency: converted.reportingCurrency,
        netAmount: converted.netAmount,
        ivaAmount: converted.ivaAmount,
        ishAmount: converted.ishAmount,
        totalAmount: converted.totalAmount,
        monedaOriginal: converted.quote.currency,
        montoOriginal: converted.quote.totalAmount,
        tipoCambioAplicado: converted.exchangeRateApplied,
      },
      200,
    );
  });

  return app;
}
