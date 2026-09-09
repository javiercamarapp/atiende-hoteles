// REQ-RES-020 (P1/F): capa de agregación SQL real para el reporte de atribución de
// canal/agente de origen -- este archivo decide QUÉ cuenta como "una reserva de este
// reporte" (mismo principio de separación que `apps/api/src/domain/plUsali.ts` ya
// documenta para el P&L: el paquete `@atiende-hoteles/domain-hotel` solo hace la
// aritmética sobre lo que aquí se agrega).
//
// Alcance deliberado: reservas 'confirmada'/'check_in'/'en_estancia'/'check_out'/
// 'cerrada' cuentan como ingreso atribuible (mismo conjunto de estados "reserva real,
// no cancelada/no-show" que `resumen.ts` usa para "reservasHoy" vía `status <>
// 'cancelada'`, restringido aquí además a excluir 'no_show' -- un no-show no generó
// una estancia real que atribuir a ningún canal). 'cotizada' se excluye: todavía no es
// una reserva confirmada, incluirla infla el reporte con cotizaciones que pueden
// nunca cerrarse.
import type { DbClient } from "@atiende-hoteles/db";
import { buildChannelAttributionReport, nightsBetween, type ChannelAttributionReport, type ChannelCommissionConfig } from "@atiende-hoteles/domain-hotel";

interface ReservationForAttributionRow {
  id: string;
  channel: string;
  check_in_date: string;
  check_out_date: string;
  total_amount: string;
}

export async function loadChannelCommissionConfig(db: DbClient, hotelId: string): Promise<ChannelCommissionConfig[]> {
  const { rows } = await db.query<{ channel: string; commission_pct: string }>(
    "select channel, commission_pct::text as commission_pct from public.hotel_channel_commission where hotel_id = $1;",
    [hotelId],
  );
  return rows.map((r) => ({ channel: r.channel, commissionPct: Number(r.commission_pct) }));
}

/**
 * Construye el reporte de atribución de canal para `[desde, hasta]` (por
 * `check_in_date`, INCLUSIVE en ambos extremos -- mismo criterio de rango que
 * `plUsali.ts`) de UN hotel. `desde`/`hasta` ya vienen validados como YYYY-MM-DD por
 * la capa de ruta.
 */
export async function buildChannelAttributionReportForHotel(
  db: DbClient,
  hotelId: string,
  desde: string,
  hasta: string,
): Promise<ChannelAttributionReport> {
  const [{ rows: reservationRows }, configs] = await Promise.all([
    db.query<ReservationForAttributionRow>(
      `select id, channel, check_in_date::text as check_in_date, check_out_date::text as check_out_date, total_amount::text as total_amount
       from public.reservation
       where hotel_id = $1
         and check_in_date >= $2::date
         and check_in_date <= $3::date
         and status not in ('cotizada', 'cancelada', 'no_show')
       order by check_in_date asc;`,
      [hotelId, desde, hasta],
    ),
    loadChannelCommissionConfig(db, hotelId),
  ]);

  const reservations = reservationRows.map((r) => ({
    id: r.id,
    channel: r.channel,
    nights: nightsBetween(r.check_in_date, r.check_out_date).length,
    netAmount: Number(r.total_amount),
  }));

  return buildChannelAttributionReport(reservations, configs);
}
