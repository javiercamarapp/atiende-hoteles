// H4 · Motor de cotización determinista (REQ-RES-002/REQ-REV-001): noches × tarifa de
// `rate_plan` (una fila real por noche, jamás inventada) + impuestos configurables
// (taxes.ts). Ninguna ruta de este módulo acepta ni usa un precio "sugerido" por un
// LLM — `nightlyRateSchema` solo reconoce las columnas reales de `rate_plan`; un campo
// extra (ej. `llmSuggestedPrice`) se DESCARTA por zod antes de llegar al cálculo (ver
// `parseQuoteInput` y tests/unit/domain-hotel/pricing-source.spec.ts).
import { z } from "zod";
import { applyTaxes, assertValidTaxConfig, type TaxBreakdown } from "./taxes.ts";
import { roundCurrency } from "./money.ts";

export class QuoteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QuoteError";
    this.code = code;
  }
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");

// Espejo exacto (y únicamente) de las columnas de `rate_plan` relevantes para cotizar
// (packages/db/migrations/0004_room_inventory.sql + 0013_tarifas_avanzadas_y_politicas.sql).
// Cualquier propiedad fuera de esta lista (ej. un precio propuesto por el LLM de un
// canal conversacional) se elimina silenciosamente por el `.strip()` implícito de zod.
const nightlyRateSchema = z.object({
  date: dateSchema,
  price: z.number().nonnegative(),
  minStay: z.number().int().positive().default(1),
  closedToArrival: z.boolean().default(false),
  closedToDeparture: z.boolean().default(false),
});

const taxConfigSchema = z.object({
  ivaRate: z.number().min(0),
  ishRate: z.number().min(0),
});

// `nightlyRates` debe cubrir cada fecha de [checkInDate, checkOutDate] INCLUSIVE: las
// noches que se cobran son [checkInDate, checkOutDate), pero la fila de checkOutDate
// también se exige para poder validar `closedToDeparture` de la fecha de salida.
export const quoteInputSchema = z
  .object({
    checkInDate: dateSchema,
    checkOutDate: dateSchema,
    currency: z.string().default("MXN"),
    nightlyRates: z.array(nightlyRateSchema).min(1),
    taxConfig: taxConfigSchema,
  })
  .refine((v) => v.checkOutDate > v.checkInDate, {
    message: "checkOutDate debe ser posterior a checkInDate",
    path: ["checkOutDate"],
  });

export type NightlyRate = z.infer<typeof nightlyRateSchema>;
export type QuoteInput = z.infer<typeof quoteInputSchema>;

export interface QuoteNightBreakdown {
  date: string;
  price: number;
}

export interface Quote extends TaxBreakdown {
  nights: number;
  currency: string;
  nightlyBreakdown: QuoteNightBreakdown[];
}

/** Descarta cualquier campo no reconocido (ej. un precio sugerido por un LLM) antes de
 *  que el valor llegue a `computeQuote`. Lanza `ZodError` si falta un campo requerido. */
export function parseQuoteInput(raw: unknown): QuoteInput {
  return quoteInputSchema.parse(raw);
}

/** Fechas UTC calendario puras (sin componente de hora): evita que un cambio de horario
 *  de verano local (México abolió el DST general en 2022, pero esto es robusto incluso
 *  si una región lo reintrodujera) duplique o elimine una noche. */
export function nightsBetween(checkInDate: string, checkOutDate: string): string[] {
  const nights: string[] = [];
  const cursor = new Date(`${checkInDate}T00:00:00Z`);
  const end = new Date(`${checkOutDate}T00:00:00Z`);
  while (cursor < end) {
    nights.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

/**
 * Cotiza una estadía de forma 100% determinista a partir de tarifas y configuración
 * fiscal REALES (nunca inventadas ni redondeadas/ajustadas por un LLM, REQ-REV-001).
 * Valida min-stay/CTA/CTD (H07-005) y rechaza una estadía de 0 noches.
 */
export function computeQuote(input: QuoteInput): Quote {
  assertValidTaxConfig(input.taxConfig);
  // Repite la validación de `quoteInputSchema.refine()` aquí porque `computeQuote` es
  // una función pública exportada por su cuenta (no todo llamador pasa primero por
  // `parseQuoteInput`) — una estadía de 0 noches se rechaza sin importar la vía de
  // entrada.
  if (input.checkOutDate <= input.checkInDate) {
    throw new QuoteError("estadia_invalida", "checkOutDate debe ser posterior a checkInDate.");
  }
  const nights = nightsBetween(input.checkInDate, input.checkOutDate);
  if (nights.length < 1) {
    throw new QuoteError("estadia_invalida", "La estadía debe ser de al menos 1 noche.");
  }

  const ratesByDate = new Map(input.nightlyRates.map((r) => [r.date, r]));

  const arrivalRate = ratesByDate.get(input.checkInDate);
  if (!arrivalRate) {
    throw new QuoteError(
      "sin_tarifa",
      `No hay tarifa configurada para la fecha de llegada ${input.checkInDate}.`,
    );
  }
  if (arrivalRate.closedToArrival) {
    throw new QuoteError("cerrado_a_llegada", `El ${input.checkInDate} está cerrado a llegadas (CTA).`);
  }
  if (nights.length < arrivalRate.minStay) {
    throw new QuoteError(
      "estadia_minima_no_alcanzada",
      `Esta tarifa exige una estadía mínima de ${arrivalRate.minStay} noche(s); se solicitaron ${nights.length}.`,
    );
  }

  const departureRate = ratesByDate.get(input.checkOutDate);
  if (departureRate?.closedToDeparture) {
    throw new QuoteError("cerrado_a_salida", `El ${input.checkOutDate} está cerrado a salidas (CTD).`);
  }

  const nightlyBreakdown: QuoteNightBreakdown[] = [];
  let netSubtotal = 0;
  for (const date of nights) {
    const rate = ratesByDate.get(date);
    if (!rate) {
      throw new QuoteError("sin_tarifa", `No hay tarifa configurada para la noche ${date}.`);
    }
    nightlyBreakdown.push({ date, price: rate.price });
    netSubtotal = roundCurrency(netSubtotal + rate.price);
  }

  const taxes = applyTaxes(netSubtotal, input.taxConfig);

  return {
    nights: nights.length,
    currency: input.currency,
    nightlyBreakdown,
    ...taxes,
  };
}
