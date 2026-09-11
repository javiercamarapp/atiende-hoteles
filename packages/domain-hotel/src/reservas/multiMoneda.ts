// REQ-RES-015 (P2/F): "El motor de reservas debe operar en modo multi-moneda
// (USD/MXN), gestionando activamente el efecto del tipo de cambio sobre tarifas
// fijadas en una divisa distinta a la de reporte." Módulo de dominio PURO (mismo
// principio que `taxes.ts`/`folioEngine.ts`/`clubSegundoViaje.ts`): ninguna función de
// aquí toca I/O. El llamador (ruta API) lee las filas ya registradas de
// `hotel_exchange_rate` (packages/db/migrations/0130_hotel_exchange_rate.sql) y se las
// pasa como `ExchangeRateRecord[]` -- este módulo NUNCA consulta un feed de tipo de
// cambio en vivo ni inventa uno: solo usa el tipo de cambio VIGENTE REGISTRADO por el
// hotel (por eso REQUISITOS.md marca la dependencia de este REQ como "ninguna", a
// diferencia de REQ-RES-009 que sí depende de un feed externo de clima).
import { roundCurrency } from "../money.ts";

export class ExchangeRateError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ExchangeRateError";
    this.code = code;
  }
}

/** Espejo de una fila de `hotel_exchange_rate`: tipo de cambio registrado por el hotel
 *  para convertir `fromCurrency` -> `toCurrency`, vigente a partir de `effectiveDate`
 *  (inclusive) hasta que se registre una fila más reciente para el mismo par. */
export interface ExchangeRateRecord {
  readonly fromCurrency: string;
  readonly toCurrency: string;
  /** Unidades de `toCurrency` que equivalen a 1 unidad de `fromCurrency`. */
  readonly rate: number;
  readonly effectiveDate: string; // YYYY-MM-DD
}

/** Encuentra el tipo de cambio VIGENTE para convertir `fromCurrency` -> `toCurrency`
 *  en `asOfDate`: la fila registrada con `effectiveDate` más reciente que no sea
 *  posterior a `asOfDate` (nunca una fila futura -- sería usar una tasa que el hotel
 *  todavía no ha registrado como vigente a esa fecha). Nunca extrapola, promedia ni
 *  "adivina" un tipo de cambio -- si el hotel no ha registrado ninguna tasa vigente a
 *  esa fecha para ese par, se rechaza explícitamente (fail-closed: mejor bloquear la
 *  conversión que reportar con un tipo de cambio incorrecto o inventado). */
export function resolveVigenteExchangeRate(
  rates: readonly ExchangeRateRecord[],
  fromCurrency: string,
  toCurrency: string,
  asOfDate: string,
): ExchangeRateRecord {
  let vigente: ExchangeRateRecord | undefined;
  for (const r of rates) {
    if (r.fromCurrency !== fromCurrency || r.toCurrency !== toCurrency) continue;
    if (r.effectiveDate > asOfDate) continue;
    if (!vigente || r.effectiveDate > vigente.effectiveDate) vigente = r;
  }
  if (!vigente) {
    throw new ExchangeRateError(
      "tipo_cambio_no_registrado",
      `No hay tipo de cambio ${fromCurrency}->${toCurrency} registrado vigente al ${asOfDate}.`,
    );
  }
  return vigente;
}

export interface MoneyInCurrency {
  readonly amount: number;
  readonly currency: string;
}

export interface ConvertedAmount {
  /** Monto ya convertido, en `currency` (== la moneda de reporte solicitada). */
  readonly amount: number;
  readonly currency: string;
  /** Tipo de cambio aplicado, o `null` cuando `originalCurrency === currency` (sin
   *  conversión: el propio concepto de "tipo de cambio 1:1 a sí mismo" no se registra
   *  ni se busca -- ver `convertToReportingCurrency`). */
  readonly exchangeRateApplied: number | null;
  readonly originalAmount: number;
  readonly originalCurrency: string;
}

/** Convierte un monto fijado en `money.currency` a la moneda de reporte del hotel
 *  (`reportingCurrency`), usando el tipo de cambio VIGENTE registrado a `asOfDate`. Si
 *  la moneda del monto YA es la de reporte, es un passthrough exacto (sin buscar ni
 *  exigir ninguna tasa -- factor 1, nunca una "1.000000" aproximada que arrastraría
 *  redondeo innecesario). */
export function convertToReportingCurrency(
  money: MoneyInCurrency,
  reportingCurrency: string,
  asOfDate: string,
  rates: readonly ExchangeRateRecord[],
): ConvertedAmount {
  if (money.amount < 0) {
    throw new RangeError("El monto a convertir no puede ser negativo.");
  }
  const originalAmount = roundCurrency(money.amount);
  if (money.currency === reportingCurrency) {
    return {
      amount: originalAmount,
      currency: reportingCurrency,
      exchangeRateApplied: null,
      originalAmount,
      originalCurrency: money.currency,
    };
  }
  const vigente = resolveVigenteExchangeRate(rates, money.currency, reportingCurrency, asOfDate);
  return {
    amount: roundCurrency(originalAmount * vigente.rate),
    currency: reportingCurrency,
    exchangeRateApplied: vigente.rate,
    originalAmount,
    originalCurrency: money.currency,
  };
}

export interface MultiCurrencyTotalInput {
  readonly lines: readonly MoneyInCurrency[];
  readonly reportingCurrency: string;
  readonly asOfDate: string;
  readonly rates: readonly ExchangeRateRecord[];
}

export interface MultiCurrencyTotalResult {
  /** Suma de todas las líneas, cada una ya convertida a `reportingCurrency`. */
  readonly totalInReportingCurrency: number;
  readonly reportingCurrency: string;
  /** Detalle línea por línea con su conversión aplicada -- para que un reporte pueda
   *  mostrar tanto el monto original (la moneda en la que la tarifa realmente se fijó)
   *  como su equivalente en la moneda de reporte, sin perder la trazabilidad cuando
   *  DOS monedas conviven en el mismo periodo. */
  readonly lines: readonly ConvertedAmount[];
  /** Monedas distintas de `reportingCurrency` que efectivamente aparecieron entre las
   *  líneas -- así el llamador confirma "sí hubo actividad multi-moneda este periodo"
   *  sin tener que re-derivarlo iterando `lines` por su cuenta. */
  readonly foreignCurrenciesInvolved: readonly string[];
}

/** Agrega un conjunto de montos -- potencialmente fijados en monedas distintas -- a un
 *  único total en la moneda de reporte del hotel. Es el punto central que un reporte
 *  (PL, folio consolidado, reporte de grupo) debe usar cuando conviven reservas/cargos
 *  en USD y en MXN en el mismo periodo (el escenario que exige el criterio de
 *  aceptación de REQ-RES-015: "verificado con dos monedas activas en el mismo
 *  periodo"): cada línea se convierte de forma determinista e independiente -- nunca
 *  se aplica un "tipo de cambio promedio del periodo" inventado, que ocultaría cuánto
 *  aportó cada moneda realmente. */
export function summarizeMultiCurrencyTotals(input: MultiCurrencyTotalInput): MultiCurrencyTotalResult {
  const lines = input.lines.map((line) =>
    convertToReportingCurrency(line, input.reportingCurrency, input.asOfDate, input.rates),
  );
  let totalInReportingCurrency = 0;
  for (const line of lines) {
    totalInReportingCurrency = roundCurrency(totalInReportingCurrency + line.amount);
  }
  const foreignCurrenciesInvolved = [
    ...new Set(lines.filter((l) => l.originalCurrency !== input.reportingCurrency).map((l) => l.originalCurrency)),
  ];
  return {
    totalInReportingCurrency,
    reportingCurrency: input.reportingCurrency,
    lines,
    foreignCurrenciesInvolved,
  };
}
