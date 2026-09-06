// H4 · POST /hoteles/:hotelId/quotes — REQ-REV-001/REQ-RES-002: motor de cotización
// determinista. El body de entrada NUNCA acepta un campo de precio/total: solo
// identificadores (roomTypeId/checkInDate/checkOutDate) — arquitectónicamente ni un
// LLM ni el propio cliente HTTP puede inyectar un precio final, ver
// packages/domain-hotel/src/quote.ts (`parseQuoteInput` descarta cualquier campo que no
// sea una columna real de `rate_plan`).
import { Hono } from "hono";
import { z } from "zod";
import { computeQuote, QuoteError, parseQuoteInput } from "@atiende-hoteles/domain-hotel";
import { ApiError, Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { loadNightlyRates } from "../pms/dbRoomRatePort.ts";
import { loadTaxConfig } from "../pms/taxConfig.ts";
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

// Mapa de códigos de dominio (packages/domain-hotel/src/quote.ts) -> estatus HTTP.
// Centralizado aquí (en vez de en toErrorBody) porque son códigos propios de la
// cotización, no errores genéricos de la capa HTTP/DB.
const CODE_STATUS: Record<string, number> = {
  estadia_invalida: 400,
  sin_tarifa: 409,
  cerrado_a_llegada: 409,
  cerrado_a_salida: 409,
  estadia_minima_no_alcanzada: 409,
};

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

    const taxConfig = await loadTaxConfig(db, hotelId);
    const nightlyRates = await loadNightlyRates(db, {
      hotelId,
      roomTypeId: body.roomTypeId,
      fromDateInclusive: body.checkInDate,
      toDateInclusive: body.checkOutDate,
    });

    try {
      const input = parseQuoteInput({
        checkInDate: body.checkInDate,
        checkOutDate: body.checkOutDate,
        taxConfig,
        nightlyRates,
      });
      const quote = computeQuote(input);
      return c.json({ roomTypeId: body.roomTypeId, ...quote }, 200);
    } catch (err) {
      if (err instanceof QuoteError) {
        const status = CODE_STATUS[err.code] ?? 409;
        throw new ApiError(status, err.code, err.message);
      }
      throw err;
    }
  });

  return app;
}
