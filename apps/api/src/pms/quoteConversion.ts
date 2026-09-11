// REQ-RES-015: punto ÚNICO donde el motor de cotización determinista (`quote.ts`) se
// combina con la conversión de moneda (`reservas/multiMoneda.ts`) -- ni `routes/quotes.ts`
// ni `routes/reservas.ts` duplican esta composición, para que ambos caminos (cotizar sin
// reservar vs. crear/modificar una reserva) apliquen EXACTAMENTE la misma regla de
// conversión. El criterio de aceptación habla de "el motor de reservas" en singular: dos
// caminos que convirtieran distinto (o uno que convirtiera y otro no, como pasaba antes
// de este cableado) violaría esa misma garantía.
import { computeQuote, parseQuoteInput, QuoteError, roundCurrency, type Quote } from "@atiende-hoteles/domain-hotel";
import type { DbClient } from "@atiende-hoteles/db";
import { ApiError } from "../lib/errors.ts";
import { loadTaxConfig } from "./taxConfig.ts";
import { loadNightlyRatesWithCurrency } from "./dbRoomRatePort.ts";
import { convertToReportingCurrencyOrThrow, REPORTING_CURRENCY } from "./exchangeRate.ts";

// Mismo mapeo que `routes/quotes.ts`/`pms/quoteNetAmount.ts` -- centralizado aquí porque
// ahora los tres caminos (POST /quotes, POST /reservas, PATCH /reservas/:id/fechas)
// pasan por esta función.
const QUOTE_CODE_STATUS: Record<string, number> = {
  estadia_invalida: 400,
  sin_tarifa: 409,
  cerrado_a_llegada: 409,
  cerrado_a_salida: 409,
  estadia_minima_no_alcanzada: 409,
};

export interface QuoteConvertedResult {
  /** Cotización cruda, en la moneda ORIGINAL de la tarifa (`rate_plan.currency`). */
  quote: Quote;
  reportingCurrency: string;
  /** netAmount/ivaAmount/ishAmount/totalAmount YA convertidos a `reportingCurrency`
   *  (idénticos a los de `quote` cuando `quote.currency === reportingCurrency`, ver
   *  `convertToReportingCurrency`: passthrough exacto, nunca una tasa "1.0" inventada). */
  netAmount: number;
  ivaAmount: number;
  ishAmount: number;
  totalAmount: number;
  /** null cuando la tarifa ya estaba en `reportingCurrency` (sin conversión). */
  exchangeRateApplied: number | null;
}

/**
 * Cotiza una estadía real (tarifas + impuestos, `computeQuote`) y, si la tarifa está
 * fijada en una divisa distinta a la de reporte del motor de reservas
 * (`REPORTING_CURRENCY`), la convierte ACTIVAMENTE usando el tipo de cambio vigente
 * registrado por el hotel (`hotel_exchange_rate`) -- fail-closed: si no hay tasa
 * vigente registrada a `checkInDate`, la cotización/reserva se rechaza con 409 en vez
 * de cobrar/reportar un monto en la moneda equivocada o con una tasa inventada.
 *
 * Una sola estadía con noches en MÁS de una moneda (ej. un cambio de tarifa a mitad de
 * la estancia que también cambió de divisa) se rechaza explícitamente -- REQ-RES-015 no
 * exige soportar ese caso, y convertir cada noche con una tasa distinta ocultaría en qué
 * momento cambió la moneda real de la tarifa.
 */
export async function quoteConvertedToReportingCurrency(
  db: DbClient,
  params: { hotelId: string; roomTypeId: string; checkInDate: string; checkOutDate: string },
): Promise<QuoteConvertedResult> {
  const taxConfig = await loadTaxConfig(db, params.hotelId);
  const nightlyRates = await loadNightlyRatesWithCurrency(db, {
    hotelId: params.hotelId,
    roomTypeId: params.roomTypeId,
    fromDateInclusive: params.checkInDate,
    toDateInclusive: params.checkOutDate,
  });

  const distinctCurrencies = [...new Set(nightlyRates.map((r) => r.currency))];
  if (distinctCurrencies.length > 1) {
    throw new ApiError(
      409,
      "moneda_mixta_no_soportada",
      `La tarifa de esta estadía cambia de moneda entre noches (${distinctCurrencies.join(", ")}); el motor de cotización no soporta una sola estadía fijada en más de una moneda.`,
    );
  }
  // Si no hay ninguna fila de tarifa en el rango, `currency` no importa -- `computeQuote`
  // rechaza con "sin_tarifa" antes de que se use.
  const currency = distinctCurrencies[0] ?? REPORTING_CURRENCY;

  let quote: Quote;
  try {
    const input = parseQuoteInput({
      checkInDate: params.checkInDate,
      checkOutDate: params.checkOutDate,
      currency,
      taxConfig,
      nightlyRates,
    });
    quote = computeQuote(input);
  } catch (err) {
    if (err instanceof QuoteError) {
      throw new ApiError(QUOTE_CODE_STATUS[err.code] ?? 409, err.code, err.message);
    }
    throw err;
  }

  if (quote.currency === REPORTING_CURRENCY) {
    return {
      quote,
      reportingCurrency: REPORTING_CURRENCY,
      netAmount: quote.netAmount,
      ivaAmount: quote.ivaAmount,
      ishAmount: quote.ishAmount,
      totalAmount: quote.totalAmount,
      exchangeRateApplied: null,
    };
  }

  // asOfDate = check-in: la tasa vigente que rige es la que aplica el día en que
  // efectivamente arranca la estadía -- mismo ancla temporal que ya usa este motor para
  // min-stay/CTA/CTD (ver `computeQuote`).
  const asOfDate = params.checkInDate;
  const convertedNet = await convertToReportingCurrencyOrThrow(
    db,
    params.hotelId,
    { amount: quote.netAmount, currency: quote.currency },
    asOfDate,
  );
  const convertedIva = await convertToReportingCurrencyOrThrow(
    db,
    params.hotelId,
    { amount: quote.ivaAmount, currency: quote.currency },
    asOfDate,
  );
  const convertedIsh = await convertToReportingCurrencyOrThrow(
    db,
    params.hotelId,
    { amount: quote.ishAmount, currency: quote.currency },
    asOfDate,
  );
  const totalAmount = roundCurrency(convertedNet.amount + convertedIva.amount + convertedIsh.amount);

  return {
    quote,
    reportingCurrency: REPORTING_CURRENCY,
    netAmount: convertedNet.amount,
    ivaAmount: convertedIva.amount,
    ishAmount: convertedIsh.amount,
    totalAmount,
    exchangeRateApplied: convertedNet.exchangeRateApplied,
  };
}
