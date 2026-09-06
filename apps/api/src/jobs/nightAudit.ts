// H5 · Night audit propio (REQ-REV-013/H16-003), independiente del PMS del hotel:
// 1) postea el cargo de hospedaje de la noche a cada folio en casa (concept
//    'hospedaje', vía el motor determinista de packages/domain-hotel);
// 2) marca no-shows del día (reutiliza jobs/noShow.ts, mismo REQ-RES-008);
// 3) congela el día (una segunda corrida del MISMO business_date SIEMPRE devuelve el
//    resumen ya guardado, sin volver a postear -- ver night_audit_claim/finish,
//    migrations/0031_night_audit.sql);
// 4) genera un resumen de caja (cargos por concepto, pagos por método, ocupación).
//
// La conciliación A&B/spa contra el POS queda declarada explícitamente como
// "sin_pos_configurado" -- no existe integración POS real en esta fase (ADR-007),
// nunca se simulan cifras de conciliación.
import type { DbClient } from "@atiende-hoteles/db";
import { computeChargeAmounts } from "@atiende-hoteles/domain-hotel";
import { loadHotelMoneyConfig } from "../pms/taxConfig.ts";
import { runNoShowJob } from "./noShow.ts";

interface InHouseReservationRow {
  id: string;
  folio_id: string;
  room_type_id: string;
  price: string | null;
}

export interface NightAuditSummary {
  businessDate: string;
  hotelId: string;
  postedCharges: { reservationId: string; folioId: string; amount: number; taxAmount: number }[];
  noShows: { reservationId: string; chargeAmount: number }[];
  cargosPorConcepto: Record<string, number>;
  pagosPorMetodo: Record<string, number>;
  ocupacion: { enCasa: number };
  conciliacionAB: { estado: "sin_pos_configurado" };
  yaCompletado: boolean;
}

export async function runNightAudit(
  db: DbClient,
  params: { tenantId: string; hotelId: string; businessDate: string },
): Promise<NightAuditSummary> {
  const claim = await db.query<{ run_id: string; already_completed: boolean; summary: NightAuditSummary | null }>(
    "select * from public.night_audit_claim($1, $2, $3::date);",
    [params.tenantId, params.hotelId, params.businessDate],
  );
  const { run_id: runId, already_completed: alreadyCompleted, summary: existingSummary } = claim.rows[0]!;

  if (alreadyCompleted && existingSummary) {
    return { ...existingSummary, yaCompletado: true };
  }

  const taxConfig = await loadHotelMoneyConfig(db, params.hotelId);

  // P1/auditoria-2 pruebas [ALTO]: el resumen de caja debe agrupar por la FECHA DE
  // NEGOCIO del cierre (hora local del hotel), no por `created_at::date` crudo -- el
  // night audit normalmente cierra "el día de ayer" corriendo hoy de madrugada
  // (`businessDateToClose`, nightAuditScheduler.ts), así que comparar
  // `created_at::date` (casteado en la zona de sesión, típicamente UTC) contra
  // `businessDate` casi nunca coincide: un cargo hecho a las 23:00 hora local puede
  // caer en el día calendario SIGUIENTE en UTC, y viceversa para cargos de madrugada.
  const { rows: hotelRows } = await db.query<{ timezone: string }>(
    "select timezone from public.hotel where id = $1;",
    [params.hotelId],
  );
  const timezone = hotelRows[0]?.timezone ?? "America/Mexico_City";

  // Reservas "en casa" la noche de `businessDate`: check_in_date <= businessDate <
  // check_out_date, ya con check-in hecho (check_in/en_estancia). La tarifa de la
  // noche se lee de `rate_plan` para esa fecha exacta (misma fuente que el motor de
  // cotización de H4, nunca un promedio inventado).
  const { rows: inHouse } = await db.query<InHouseReservationRow>(
    `select r.id, f.id as folio_id, r.room_type_id, rp.price::text as price
     from public.reservation r
     join public.folio f on f.reservation_id = r.id and f.is_primary
     left join public.rate_plan rp on rp.room_type_id = r.room_type_id and rp.hotel_id = r.hotel_id and rp.date = $2::date
     where r.hotel_id = $1
       and r.status in ('check_in', 'en_estancia')
       and r.check_in_date <= $2::date
       and r.check_out_date > $2::date;`,
    [params.hotelId, params.businessDate],
  );

  const postedCharges: NightAuditSummary["postedCharges"] = [];
  for (const row of inHouse) {
    const nightlyPrice = row.price != null ? Number(row.price) : 0;
    const calc = computeChargeAmounts({ concept: "hospedaje", netAmount: nightlyPrice, taxConfig });

    // Índice único parcial `charge_folio_stay_date_hospedaje_idx` (migrations/0030)
    // hace de esta inserción una operación idempotente real: si ya se posteó la
    // noche para este folio, el ON CONFLICT no inserta una segunda vez.
    const { rows: inserted } = await db.query<{ id: string }>(
      `insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept, stay_date, night_audit_run_id)
       values ($1, $2, $3, $4, $5, $6, 'hospedaje', $7::date, $8)
       on conflict (folio_id, stay_date) where concept = 'hospedaje' and stay_date is not null and reverses_charge_id is null
       do nothing
       returning id;`,
      [params.tenantId, params.hotelId, row.folio_id, `Hospedaje noche del ${params.businessDate}`, calc.netAmount, calc.taxAmount, params.businessDate, runId],
    );
    if (inserted.length > 0) {
      postedCharges.push({ reservationId: row.id, folioId: row.folio_id, amount: calc.netAmount, taxAmount: calc.taxAmount });
      await db.query(
        "select public.record_audit_log($1, $2, 'night_audit.charge_posted', 'charge', $3, $4);",
        [params.tenantId, params.hotelId, inserted[0]!.id, JSON.stringify({ reservationId: row.id, businessDate: params.businessDate })],
      );
    }
  }

  const noShowResults = await runNoShowJob(db, { tenantId: params.tenantId, hotelId: params.hotelId, asOfDate: params.businessDate });

  const { rows: chargesByConceptRows } = await db.query<{ concept: string; total: string }>(
    `select concept, sum(amount + tax_amount)::text as total
     from public.charge
     where hotel_id = $1 and (created_at at time zone $3)::date = $2::date
     group by concept;`,
    [params.hotelId, params.businessDate, timezone],
  );
  const { rows: paymentsByMethodRows } = await db.query<{ method: string; total: string }>(
    `select method, sum(amount)::text as total
     from public.payment
     where hotel_id = $1 and (created_at at time zone $3)::date = $2::date and status = 'capturado'
     group by method;`,
    [params.hotelId, params.businessDate, timezone],
  );

  const summary: NightAuditSummary = {
    businessDate: params.businessDate,
    hotelId: params.hotelId,
    postedCharges,
    noShows: noShowResults.map((r) => ({ reservationId: r.reservationId, chargeAmount: r.chargeAmount })),
    cargosPorConcepto: Object.fromEntries(chargesByConceptRows.map((r) => [r.concept, Number(r.total)])),
    pagosPorMetodo: Object.fromEntries(paymentsByMethodRows.map((r) => [r.method, Number(r.total)])),
    ocupacion: { enCasa: inHouse.length },
    conciliacionAB: { estado: "sin_pos_configurado" },
    yaCompletado: false,
  };

  await db.query("select public.night_audit_finish($1, $2);", [runId, JSON.stringify(summary)]);
  await db.query(
    "select public.record_audit_log($1, $2, 'night_audit.completed', 'night_audit_run', $3, $4);",
    [params.tenantId, params.hotelId, runId, JSON.stringify({ businessDate: params.businessDate, postedCount: postedCharges.length })],
  );
  await db.query(
    `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
     values ($1, $2, 'night_audit_run', $3, 'night_audit.completed', $4);`,
    [params.tenantId, params.hotelId, runId, JSON.stringify({ businessDate: params.businessDate })],
  );

  return summary;
}
