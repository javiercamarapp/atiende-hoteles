// H4 · Extraído de routes/reservas.ts (donde nació como función local usada por POST
// crear y PATCH fechas) para que REQ-RES-006 (apps/api/src/pms/waitlistOffer.ts) pueda
// cotizar el precio DIRECTO de una oferta de lista de espera con el MISMO motor —
// nunca una segunda copia de la lógica de cotización que pudiera divergir.
//
// `reservation.total_amount` guarda el NETO (sin impuestos): los impuestos se postean
// como cargo aparte en el folio (H5, apps/api/src/routes/folios.ts) — el desglose
// completo con IVA/ISH lo entrega POST /quotes para cotizar, no la reserva persistida
// ni la oferta de lista de espera.
import type { DbClient } from "@atiende-hoteles/db";
import { computeQuote, parseQuoteInput, QuoteError } from "@atiende-hoteles/domain-hotel";
import { ApiError } from "../lib/errors.ts";
import { loadNightlyRates } from "./dbRoomRatePort.ts";
import { loadTaxConfig } from "./taxConfig.ts";

const QUOTE_CODE_STATUS: Record<string, number> = {
  estadia_invalida: 400,
  sin_tarifa: 409,
  cerrado_a_llegada: 409,
  cerrado_a_salida: 409,
  estadia_minima_no_alcanzada: 409,
};

export async function quoteNetAmount(
  db: DbClient,
  params: { hotelId: string; roomTypeId: string; checkInDate: string; checkOutDate: string },
): Promise<number> {
  const taxConfig = await loadTaxConfig(db, params.hotelId);
  const nightlyRates = await loadNightlyRates(db, {
    hotelId: params.hotelId,
    roomTypeId: params.roomTypeId,
    fromDateInclusive: params.checkInDate,
    toDateInclusive: params.checkOutDate,
  });
  try {
    const input = parseQuoteInput({
      checkInDate: params.checkInDate,
      checkOutDate: params.checkOutDate,
      taxConfig,
      nightlyRates,
    });
    return computeQuote(input).netAmount;
  } catch (err) {
    if (err instanceof QuoteError) {
      throw new ApiError(QUOTE_CODE_STATUS[err.code] ?? 409, err.code, err.message);
    }
    throw err;
  }
}
