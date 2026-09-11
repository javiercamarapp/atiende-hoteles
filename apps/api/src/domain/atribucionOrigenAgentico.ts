// REQ-OBS-008 (P2/OBS): capa de agregación SQL real para el KPI "% de room-nights
// generadas directamente por agentes de IA" -- este archivo decide QUÉ cuenta como
// "una reserva de este reporte" (mismo principio de separación que
// `apps/api/src/domain/atribucionCanal.ts`/`plUsali.ts`: el paquete
// `@atiende-hoteles/domain-hotel` solo hace la aritmética sobre lo que aquí se agrega).
//
// Alcance deliberado: MISMO conjunto de estados que `atribucionCanal.ts` (reservas
// 'confirmada'/'check_in'/'en_estancia'/'check_out'/'cerrada'; excluye
// 'cotizada'/'cancelada'/'no_show') -- es el mismo criterio de "reserva real que
// generó una estancia atribuible", solo que agregado por `origin_actor` en vez de por
// `channel`.
import type { DbClient } from "@atiende-hoteles/db";
import { buildAgenticOriginReport, nightsBetween, type AgenticOriginReport } from "@atiende-hoteles/domain-hotel";

interface ReservationForOriginRow {
  id: string;
  origin_actor: string;
  check_in_date: string;
  check_out_date: string;
}

/**
 * Construye el reporte de origen agéntico para `[desde, hasta]` (por `check_in_date`,
 * INCLUSIVE en ambos extremos -- mismo criterio de rango que `atribucionCanal.ts`) de
 * UN hotel. `desde`/`hasta` ya vienen validados como YYYY-MM-DD por la capa de ruta.
 */
export async function buildAgenticOriginReportForHotel(
  db: DbClient,
  hotelId: string,
  desde: string,
  hasta: string,
): Promise<AgenticOriginReport> {
  const { rows } = await db.query<ReservationForOriginRow>(
    `select id, origin_actor, check_in_date::text as check_in_date, check_out_date::text as check_out_date
     from public.reservation
     where hotel_id = $1
       and check_in_date >= $2::date
       and check_in_date <= $3::date
       and status not in ('cotizada', 'cancelada', 'no_show')
     order by check_in_date asc;`,
    [hotelId, desde, hasta],
  );

  const reservations = rows.map((r) => ({
    id: r.id,
    originActor: r.origin_actor,
    nights: nightsBetween(r.check_in_date, r.check_out_date).length,
  }));

  return buildAgenticOriginReport(reservations);
}
