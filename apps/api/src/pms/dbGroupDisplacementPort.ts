// REQ-RES-012 (H02-015): "el Agente de Revenue debe consultar... el costo de
// desplazamiento (noches que se dejarían de vender x ADR esperado) antes de fijar el
// precio de un grupo". Este archivo es la única frontera donde esa consulta se puebla
// con datos REALES de `availability`/`rate_plan` (mismo criterio que
// `dbRoomRatePort.ts` para la cotización individual) -- nunca un pronóstico inventado
// ni delegado a un LLM.
//
// Heurística de desplazamiento (documentada aquí porque es la única frontera que la
// aplica, ver `@atiende-hoteles/domain-hotel` `computeGroupQuote`, que solo CONSUME el
// resultado): una noche se considera de "alta demanda" cuando la ocupación YA EN
// LIBRO (`booked_rooms / total_rooms`, la única señal de demanda futura que este
// repositorio persiste hoy -- no existe un pronóstico de pickup guardado, ver
// `forecast/pickupForecast.ts`, cuya curva histórica nadie ha poblado todavía) alcanza
// o supera `HIGH_DEMAND_OCCUPANCY_PCT`. En ese caso, CADA habitación que el bloque de
// grupo se lleva es una habitación que un huésped individual habría podido pagar a
// ADR (`rate_plan.price`, el mismo BAR que ya usa `computeQuote`) -- por eso
// `roomsDisplaced = roomsRequested` esa noche. Por debajo del umbral, se asume que esas
// habitaciones se habrían quedado vacías de cualquier forma (no hay demanda que
// desplazar) -- `roomsDisplaced = 0`. Es una heurística conservadora y auditable, NO
// un modelo probabilístico: cuando este repositorio persista un pronóstico de pickup
// real, esta función es el único lugar que hay que actualizar.
import type { DbClient } from "@atiende-hoteles/db";
import type { NightlyDisplacement } from "@atiende-hoteles/domain-hotel";

/** Debajo de este % de ocupación YA EN LIBRO, se asume que un cuarto dado al grupo no
 *  le quita nada a la venta individual (se habría quedado vacío). Documentado como
 *  constante única (mismo criterio que GROUP_QUOTE_SLA_MINUTES/CUTOFF_MIN_PICKUP_PCT
 *  de domain-hotel) en vez de adivinarlo distinto en cada llamador. */
export const HIGH_DEMAND_OCCUPANCY_PCT = 70;

export class GroupAvailabilityError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GroupAvailabilityError";
    this.code = code;
  }
}

export interface NightAvailabilitySnapshot {
  readonly date: string;
  readonly totalRooms: number;
  readonly bookedRooms: number;
  readonly barRate: number;
}

/**
 * Lee `availability` + `rate_plan` REALES para cada noche de [checkInDate,
 * checkOutDate) de un room_type. Lanza `sin_inventario_configurado` si falta una fila
 * de cualquiera de las dos tablas para alguna noche -- una cotización de grupo nunca
 * "adivina" un ADR o un total de habitaciones que nadie configuró (mismo criterio que
 * `computeQuote` con `sin_tarifa`).
 */
export async function loadNightAvailabilitySnapshots(
  db: DbClient,
  params: { hotelId: string; roomTypeId: string; nights: readonly string[] },
): Promise<NightAvailabilitySnapshot[]> {
  if (params.nights.length === 0) {
    throw new GroupAvailabilityError("estadia_invalida", "Se requiere al menos una noche.");
  }
  const { rows } = await db.query<{ date: string; total_rooms: number; booked_rooms: number; price: string }>(
    `select a.date::text as date, a.total_rooms, a.booked_rooms, r.price
     from public.availability a
     join public.rate_plan r on r.hotel_id = a.hotel_id and r.room_type_id = a.room_type_id and r.date = a.date
     where a.hotel_id = $1 and a.room_type_id = $2 and a.date = any($3::date[])
     order by a.date asc;`,
    [params.hotelId, params.roomTypeId, params.nights],
  );

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const missing = params.nights.filter((n) => !byDate.has(n));
  if (missing.length > 0) {
    throw new GroupAvailabilityError(
      "sin_inventario_configurado",
      `No hay disponibilidad/tarifa configurada para: ${missing.join(", ")}. No se puede consultar el desplazamiento de ADR sin esos datos (REQ-RES-012).`,
    );
  }

  return params.nights.map((date) => {
    const row = byDate.get(date)!;
    return { date, totalRooms: row.total_rooms, bookedRooms: row.booked_rooms, barRate: Number(row.price) };
  });
}

/**
 * Consulta real al "motor de Revenue" (H02-015): para cada noche, decide cuántas
 * habitaciones desplazaría el bloque de grupo y a qué ADR esperado, a partir de
 * `availability`/`rate_plan` reales. Rechaza (`sin_disponibilidad_suficiente`) si el
 * bloque pide más habitaciones que las que quedan libres esa noche -- una cotización
 * nunca promete un bloque que el inventario real no puede cumplir.
 */
export function estimateNightlyDisplacement(
  snapshots: readonly NightAvailabilitySnapshot[],
  roomsRequested: number,
): NightlyDisplacement[] {
  return snapshots.map((night) => {
    const freeRooms = night.totalRooms - night.bookedRooms;
    if (freeRooms < roomsRequested) {
      throw new GroupAvailabilityError(
        "sin_disponibilidad_suficiente",
        `${night.date}: el bloque pide ${roomsRequested} habitación(es) pero solo hay ${freeRooms} libre(s).`,
      );
    }
    const occupancyPct = night.totalRooms > 0 ? (night.bookedRooms / night.totalRooms) * 100 : 0;
    const isHighDemand = occupancyPct >= HIGH_DEMAND_OCCUPANCY_PCT;
    return {
      date: night.date,
      roomsDisplaced: isHighDemand ? roomsRequested : 0,
      expectedAdr: night.barRate,
    };
  });
}
