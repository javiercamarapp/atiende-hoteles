// REQ-RES-015: cablea `packages/domain-hotel/src/reservas/multiMoneda.ts` (módulo puro,
// sin I/O, ya probado en tests/unit/domain-hotel/multi-moneda.spec.ts) al producto real.
// Mismo principio que `pms/taxConfig.ts`: este archivo es la ÚNICA frontera donde el
// tipo de cambio "entra" desde una fila real de `hotel_exchange_rate`
// (packages/db/migrations/0130_hotel_exchange_rate.sql) -- el módulo de dominio sigue
// sin tocar I/O ni inventar/extrapolar ninguna tasa por su cuenta.
import type { DbClient } from "@atiende-hoteles/db";
import {
  ExchangeRateError,
  convertToReportingCurrency,
  type ConvertedAmount,
  type ExchangeRateRecord,
} from "@atiende-hoteles/domain-hotel";
import { ApiError } from "../lib/errors.ts";

/** Moneda de reporte del motor de reservas (REQ-RES-015). El resto del motor fiscal de
 *  este repo (IVA/ISH/CFDI/ISN/DIOT, `packages/domain-hotel/src/fiscalHospedaje.ts`) ya
 *  asume pesos mexicanos de forma implícita -- no existe hoy una columna
 *  `hotel.reporting_currency` (ni la exige el criterio de aceptación de REQ-RES-015,
 *  que fija el par piloto USD->MXN) -- se documenta aquí como constante, en el único
 *  lugar del código que decide "a qué moneda convierte el motor de reservas", igual que
 *  `hotel_exchange_rate.to_currency` (0130) documenta el mismo default en la base de
 *  datos. Si algún día un hotel fuera de México reporta en otra divisa, este es el
 *  único símbolo que hay que tocar. */
export const REPORTING_CURRENCY = "MXN";

export interface ExchangeRateRow extends ExchangeRateRecord {
  readonly id: string;
}

/** Todas las tasas registradas por el hotel (nunca filtradas por par/fecha aquí -- el
 *  filtrado "cuál es la vigente" es responsabilidad exclusiva de
 *  `resolveVigenteExchangeRate`, en el módulo de dominio puro). */
export async function loadExchangeRates(db: DbClient, hotelId: string): Promise<ExchangeRateRow[]> {
  const { rows } = await db.query<{
    id: string;
    from_currency: string;
    to_currency: string;
    rate: string;
    effective_date: string;
  }>(
    `select id, from_currency, to_currency, rate, effective_date::text as effective_date
     from public.hotel_exchange_rate
     where hotel_id = $1
     order by effective_date desc, created_at desc;`,
    [hotelId],
  );
  return rows.map((r) => ({
    id: r.id,
    fromCurrency: r.from_currency,
    toCurrency: r.to_currency,
    rate: Number(r.rate),
    effectiveDate: r.effective_date,
  }));
}

/** Registra una fila NUEVA (append-only, igual que `charge`/`payment`, ver comentario
 *  de 0130_hotel_exchange_rate.sql: "una tasa ya registrada no se edita ni se borra").
 *  Un error de captura se corrige registrando una fila nueva con la fecha correcta --
 *  esta función nunca hace UPDATE, refleja exactamente la RLS de 0130 (solo hay policy
 *  de INSERT/SELECT, nunca de UPDATE/DELETE). */
export async function insertExchangeRate(
  db: DbClient,
  params: { tenantId: string; hotelId: string; fromCurrency: string; toCurrency: string; rate: number; effectiveDate: string },
): Promise<ExchangeRateRow> {
  try {
    const { rows } = await db.query<{
      id: string;
      from_currency: string;
      to_currency: string;
      rate: string;
      effective_date: string;
    }>(
      `insert into public.hotel_exchange_rate (tenant_id, hotel_id, from_currency, to_currency, rate, effective_date)
       values ($1, $2, $3, $4, $5, $6)
       returning id, from_currency, to_currency, rate, effective_date::text as effective_date;`,
      [params.tenantId, params.hotelId, params.fromCurrency, params.toCurrency, params.rate, params.effectiveDate],
    );
    const row = rows[0]!;
    return {
      id: row.id,
      fromCurrency: row.from_currency,
      toCurrency: row.to_currency,
      rate: Number(row.rate),
      effectiveDate: row.effective_date,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key value|unique constraint/i.test(message)) {
      throw new ApiError(
        409,
        "tipo_cambio_ya_registrado",
        `Ya existe un tipo de cambio ${params.fromCurrency}->${params.toCurrency} registrado con effective_date=${params.effectiveDate}. Esta tabla es append-only (una tasa ya registrada no se edita): registra una fila nueva con la fecha correcta si necesitas corregir una captura.`,
      );
    }
    throw err;
  }
}

/** Convierte `money` a `REPORTING_CURRENCY` usando la tasa vigente registrada a
 *  `asOfDate` -- fail-closed (traduce `ExchangeRateError` del módulo de dominio a un
 *  409 explícito): nunca reporta/cobra un total en una moneda que no pudo convertirse
 *  de verdad, nunca inventa ni extrapola una tasa. Passthrough exacto (sin ni siquiera
 *  consultar `hotel_exchange_rate`) cuando `money.currency` YA es la de reporte. */
export async function convertToReportingCurrencyOrThrow(
  db: DbClient,
  hotelId: string,
  money: { amount: number; currency: string },
  asOfDate: string,
): Promise<ConvertedAmount> {
  if (money.currency === REPORTING_CURRENCY) {
    return convertToReportingCurrency(money, REPORTING_CURRENCY, asOfDate, []);
  }
  const rates = await loadExchangeRates(db, hotelId);
  try {
    return convertToReportingCurrency(money, REPORTING_CURRENCY, asOfDate, rates);
  } catch (err) {
    if (err instanceof ExchangeRateError) {
      throw new ApiError(409, err.code, err.message);
    }
    throw err;
  }
}
