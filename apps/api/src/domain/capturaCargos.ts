// REQ-AB-012 (P1/NF), mitad "reporte de tasa de captura" (H10-020): capa de I/O real
// (consulta a `room_charge_capture_attempt`, migración 0131) -- el cálculo de la tasa
// en sí vive en `@atiende-hoteles/domain-hotel` (`buildChargeCaptureReport`), mismo
// principio de separación que `apps/api/src/domain/plUsali.ts` ya usa para el P&L
// USALI: este archivo decide QUÉ se agrega (consulta SQL), el paquete de dominio
// decide CÓMO se calcula la tasa sobre lo ya agregado.
import type { DbClient } from "@atiende-hoteles/db";
import { buildChargeCaptureReport, type RoomChargeCaptureAttemptRecord, type ChargeCaptureReportResult } from "@atiende-hoteles/domain-hotel";
import { loadHotelMoneyConfig } from "../pms/taxConfig.ts";

interface CaptureAttemptRow {
  id: string;
  reconciled_status: "pendiente" | "capturado" | "fuga";
  amount: string;
  description: string;
  source: RoomChargeCaptureAttemptRecord["source"];
  occurred_at: string;
}

/** Trae TODOS los intentos de captura de un hotel cuyo `occurred_at` cae dentro de
 *  `[desde, hasta]` (fechas YYYY-MM-DD, límites inclusivos, SIEMPRE interpretados en
 *  UTC -- `desde`/`hasta` llegan de `isoDate()`/`toISOString().slice(0,10)` en el
 *  llamador, que son días de calendario UTC. `occurred_at >= $2::date` SIN forzar UTC
 *  compararía usando el `TimeZone` de la SESIÓN de Postgres (heredado del SO si nadie
 *  lo fija, ver packages/db/src/engines.ts) -- en un servidor con zona horaria local
 *  distinta de UTC (México: UTC-6/-5), esto desplaza la frontera del día hasta 6 horas
 *  y puede colar transacciones del día siguiente/anterior en el reporte. `at time zone
 *  'utc'` fuerza la extracción del día de calendario en UTC, sin importar la zona
 *  horaria del servidor donde corra Postgres. */
export async function loadRoomChargeCaptureAttempts(
  db: DbClient,
  hotelId: string,
  desde: string,
  hasta: string,
): Promise<RoomChargeCaptureAttemptRecord[]> {
  const { rows } = await db.query<CaptureAttemptRow>(
    `select id, reconciled_status, amount, description, source, occurred_at::text as occurred_at
     from public.room_charge_capture_attempt
     where hotel_id = $1
       and (occurred_at at time zone 'utc')::date between $2::date and $3::date
     order by occurred_at asc;`,
    [hotelId, desde, hasta],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.reconciled_status,
    amount: Number(r.amount),
    description: r.description,
    source: r.source,
    occurredAt: r.occurred_at,
  }));
}

export interface ChargeCaptureReportForHotel extends ChargeCaptureReportResult {
  readonly hotelId: string;
  readonly desde: string;
  readonly hasta: string;
}

/** Reporte periódico real de REQ-AB-012/H10-020: agrega los intentos del periodo
 *  (I/O, arriba) y aplica el cálculo puro de tasa/umbral (`buildChargeCaptureReport`)
 *  con el umbral objetivo PARAMETRIZADO de este hotel (`hotel_tax_config.charge_capture_rate_target`,
 *  nunca un 0.995 fijo en código). */
export async function buildChargeCaptureReportForHotel(
  db: DbClient,
  hotelId: string,
  desde: string,
  hasta: string,
): Promise<ChargeCaptureReportForHotel> {
  const [attempts, moneyConfig] = await Promise.all([
    loadRoomChargeCaptureAttempts(db, hotelId, desde, hasta),
    loadHotelMoneyConfig(db, hotelId),
  ]);
  const report = buildChargeCaptureReport(attempts, { targetRate: moneyConfig.chargeCaptureRateTarget });
  return { ...report, hotelId, desde, hasta };
}
