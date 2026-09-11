// H4 · Única vía real para poblar `NightlyRate[]` del motor de cotización determinista
// (`@atiende-hoteles/domain-hotel` `computeQuote`): lee `rate_plan` bajo la MISMA
// sesión/transacción RLS de la request (nunca el cliente admin). El motor de dominio es
// puro/sin I/O (README de packages/domain-hotel) -- esta función es la única frontera
// donde el precio "entra" desde una fila real de base de datos; ninguna ruta de este
// repositorio arma un `NightlyRate` a partir de un valor sugerido por un LLM o por el
// cliente HTTP (REQ-RES-002).
//
// El rango consultado es [fromDateInclusive, toDateInclusive] INCLUSIVE (a diferencia
// de las noches cobradas, [checkInDate, checkOutDate)): la fila de la fecha de SALIDA
// se necesita para poder validar `closedToDeparture` (CTD) de esa fecha exacta (ver
// packages/domain-hotel/src/quote.ts).
//
// auditoria-2/arquitectura [BAJO]: esta carpeta (`apps/api/src/pms/`) NO es el
// conector PMS de ADR-007 -- ese es `@atiende-hoteles/mcp-pms`
// (`packages/mcp-servers/pms`, ver su README), que hoy sigue sin conectar a nada.
// Este archivo (junto con `taxConfig.ts`) es la frontera donde el precio/impuesto
// "entra" desde una fila real de Postgres PROPIA del hotel, sin hablar con ningún PMS
// externo -- dos cosas con el mismo nombre de carpeta ("pms") y propósitos distintos,
// reutilizado sin revisar que ya existía un paquete con ese dominio.
import type { DbClient } from "@atiende-hoteles/db";
import type { NightlyRate } from "@atiende-hoteles/domain-hotel";

export async function loadNightlyRates(
  db: DbClient,
  params: { hotelId: string; roomTypeId: string; fromDateInclusive: string; toDateInclusive: string },
): Promise<NightlyRate[]> {
  const { rows } = await db.query<{
    date: string;
    price: string;
    min_stay: number;
    closed_to_arrival: boolean;
    closed_to_departure: boolean;
  }>(
    `select date::text as date, price, min_stay, closed_to_arrival, closed_to_departure
     from public.rate_plan
     where hotel_id = $1 and room_type_id = $2 and date between $3 and $4
     order by date asc;`,
    [params.hotelId, params.roomTypeId, params.fromDateInclusive, params.toDateInclusive],
  );

  return rows.map((r) => ({
    date: r.date,
    price: Number(r.price),
    minStay: r.min_stay,
    closedToArrival: r.closed_to_arrival,
    closedToDeparture: r.closed_to_departure,
  }));
}

// REQ-RES-015: `rate_plan.currency` (migración 0004_room_inventory.sql, default
// 'MXN') existe desde el principio pero `loadNightlyRates` de arriba nunca la
// seleccionaba -- el motor de cotización trataba TODA tarifa como si estuviera en la
// moneda de reporte, sin importar en qué moneda el hotel realmente la había
// registrado (exactamente el bug que describe REQ-RES-015: el módulo de dominio puro
// `multiMoneda.ts` ya existía y estaba probado, pero nada en el producto lo invocaba).
// Esta variante SÍ expone la moneda real de cada noche, para que el llamador
// (`pms/quoteConversion.ts`) decida si hace falta convertir con el tipo de cambio
// vigente (`pms/exchangeRate.ts`) antes de cotizar/reservar.
export interface NightlyRateWithCurrency extends NightlyRate {
  readonly currency: string;
}

export async function loadNightlyRatesWithCurrency(
  db: DbClient,
  params: { hotelId: string; roomTypeId: string; fromDateInclusive: string; toDateInclusive: string },
): Promise<NightlyRateWithCurrency[]> {
  const { rows } = await db.query<{
    date: string;
    price: string;
    currency: string;
    min_stay: number;
    closed_to_arrival: boolean;
    closed_to_departure: boolean;
  }>(
    `select date::text as date, price, currency, min_stay, closed_to_arrival, closed_to_departure
     from public.rate_plan
     where hotel_id = $1 and room_type_id = $2 and date between $3 and $4
     order by date asc;`,
    [params.hotelId, params.roomTypeId, params.fromDateInclusive, params.toDateInclusive],
  );

  return rows.map((r) => ({
    date: r.date,
    price: Number(r.price),
    currency: r.currency,
    minStay: r.min_stay,
    closedToArrival: r.closed_to_arrival,
    closedToDeparture: r.closed_to_departure,
  }));
}
