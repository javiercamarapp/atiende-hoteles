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
