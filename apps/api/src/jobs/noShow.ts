// H4 · Job de no-show (REQ-RES-008/H02-012): toda reserva 'confirmada' cuya fecha de
// check-in ya pasó sin que el huésped haya hecho check-in se marca 'no_show', libera el
// inventario de TODAS sus noches (nadie ocupó la habitación) y calcula el cargo de
// política vía `@atiende-hoteles/domain-hotel` (`evaluateNoShow`). Idempotente por
// construcción: el filtro `status = 'confirmada'` excluye automáticamente cualquier
// reserva ya procesada en una corrida anterior, sin necesitar una columna de marca aparte.
import type { DbClient } from "@atiende-hoteles/db";
import { evaluateNoShow, nightsBetween, type CancellationPolicyConfig } from "@atiende-hoteles/domain-hotel";

export interface NoShowResult {
  reservationId: string;
  chargeAmount: number;
}

interface DueReservationRow {
  id: string;
  room_type_id: string;
  check_in_date: string;
  check_out_date: string;
  total_amount: string;
}

const DEFAULT_POLICY: CancellationPolicyConfig = {
  freeUntilHours: 0,
  penaltyPct: 0,
  noShowPct: 100,
  depositPct: 0,
};

/**
 * Procesa no-shows de UN hotel dentro de la transacción de sesión ya abierta (`db`,
 * ver middleware.ts `dbSession`). `asOfDate` (YYYY-MM-DD) es la fecha "de hoy" desde la
 * óptica del hotel — parametrizable para poder probar el job sin depender del reloj
 * real del sistema; en producción se omite y se usa `current_date` del servidor.
 */
export async function runNoShowJob(
  db: DbClient,
  params: { tenantId: string; hotelId: string; asOfDate?: string },
): Promise<NoShowResult[]> {
  const { rows: dueReservations } = await db.query<DueReservationRow>(
    `select id, room_type_id, check_in_date::text as check_in_date, check_out_date::text as check_out_date, total_amount
     from public.reservation
     where hotel_id = $1
       and status = 'confirmada'
       and check_in_date < coalesce($2::date, current_date)
     order by check_in_date asc;`,
    [params.hotelId, params.asOfDate ?? null],
  );

  const { rows: policyRows } = await db.query<{
    free_until_hours: number;
    penalty_pct: string;
    no_show_pct: string;
    deposit_pct: string;
  }>(
    "select free_until_hours, penalty_pct, no_show_pct, deposit_pct from public.hotel_cancellation_policy where hotel_id = $1;",
    [params.hotelId],
  );
  const policy: CancellationPolicyConfig = policyRows[0]
    ? {
        freeUntilHours: policyRows[0].free_until_hours,
        penaltyPct: Number(policyRows[0].penalty_pct),
        noShowPct: Number(policyRows[0].no_show_pct),
        depositPct: Number(policyRows[0].deposit_pct),
      }
    : DEFAULT_POLICY;

  const results: NoShowResult[] = [];

  for (const reservation of dueReservations) {
    const nights = nightsBetween(reservation.check_in_date, reservation.check_out_date);
    for (const night of nights) {
      await db.query("select * from public.release_availability($1, $2, $3, 1);", [
        params.hotelId,
        reservation.room_type_id,
        night,
      ]);
    }

    const { chargeAmount } = evaluateNoShow(policy, Number(reservation.total_amount));

    await db.query(
      `update public.reservation
       set status = 'no_show', cancellation_penalty_amount = $1, updated_at = now()
       where id = $2;`,
      [chargeAmount, reservation.id],
    );

    // H5 · REQ-BO-001: la penalización de no-show se postea al folio como concepto
    // 'hospedaje' (el CFDI de hospedaje la incluye igual que una noche real, "concepto
    // de hospedaje con penalidad en no-show") -- SIN `stay_date` (no se ocupó ninguna
    // noche), así que no choca con el índice de idempotencia del night audit.
    if (chargeAmount > 0) {
      const { rows: folioRows } = await db.query<{ id: string }>(
        "select id from public.folio where reservation_id = $1 and is_primary;",
        [reservation.id],
      );
      const folioId = folioRows[0]?.id;
      if (folioId) {
        await db.query(
          `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept)
           values ($1, $2, $3, 'Penalización por no-show', $4, 0, 'hospedaje');`,
          [params.tenantId, params.hotelId, folioId, chargeAmount],
        );
      }
    }

    await db.query(
      "select public.record_audit_log($1, $2, 'reservation.no_show', 'reservation', $3, $4);",
      [params.tenantId, params.hotelId, reservation.id, JSON.stringify({ chargeAmount })],
    );

    await db.query(
      `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
       values ($1, $2, 'reservation', $3, 'reservation.no_show', $4);`,
      [params.tenantId, params.hotelId, reservation.id, JSON.stringify({ chargeAmount })],
    );

    results.push({ reservationId: reservation.id, chargeAmount });
  }

  return results;
}
