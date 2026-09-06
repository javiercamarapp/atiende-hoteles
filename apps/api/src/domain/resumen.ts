// H2 · REQ punto 3: ocupación/ADR/RevPAR/reservas del día calculados desde
// availability/rate_plan/reservation PROPIAS de este hotel para "hoy" (fecha del
// servidor), con "sin datos" honesto (null, nunca 0 fabricado) cuando no hay filas —
// mismo principio de docs/referencia/06-backoffice-agentes-likida.md §3.5 portado al
// backend: nunca inventar una cifra.
import type { DbClient } from "@atiende-hoteles/db";

export interface ResumenKpis {
  ocupacionPct: number | null;
  adr: number | null;
  revpar: number | null;
  reservasHoy: number | null;
}

interface AvailabilityRow {
  total_rooms: number;
  booked_rooms: number;
  price: string | null;
}

export async function calcularResumen(session: DbClient, hotelId: string): Promise<ResumenKpis> {
  const { rows } = await session.query<AvailabilityRow>(
    `select a.total_rooms, a.booked_rooms, r.price
     from public.availability a
     left join public.rate_plan r on r.room_type_id = a.room_type_id and r.date = a.date
     where a.hotel_id = $1 and a.date = current_date;`,
    [hotelId],
  );

  const { rows: reservasRows } = await session.query<{ count: string }>(
    `select count(*)::text as count
     from public.reservation
     where hotel_id = $1 and check_in_date = current_date and status <> 'cancelada';`,
    [hotelId],
  );
  const reservasHoy = reservasRows[0] ? Number(reservasRows[0].count) : null;

  if (rows.length === 0) {
    return { ocupacionPct: null, adr: null, revpar: null, reservasHoy };
  }

  let totalRooms = 0;
  let bookedRooms = 0;
  let weightedRateSum = 0;
  let weightedRateRooms = 0;

  for (const row of rows) {
    totalRooms += row.total_rooms;
    bookedRooms += row.booked_rooms;
    if (row.price != null) {
      weightedRateSum += Number(row.price) * row.total_rooms;
      weightedRateRooms += row.total_rooms;
    }
  }

  const ocupacionPct = totalRooms > 0 ? (bookedRooms / totalRooms) * 100 : null;
  const adr = weightedRateRooms > 0 ? weightedRateSum / weightedRateRooms : null;
  const revpar = ocupacionPct != null && adr != null ? adr * (ocupacionPct / 100) : null;

  return { ocupacionPct, adr, revpar, reservasHoy };
}
