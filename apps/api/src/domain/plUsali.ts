// REQ-BO-010 (P0/BP): capa de AGREGACIÓN SQL real para el P&L USALI -- este archivo es
// la única autoridad de "qué cuenta como ingreso/gasto/habitación disponible", el
// paquete `@atiende-hoteles/domain-hotel` (`pl/usaliPL.ts`) solo hace la aritmética
// sobre lo que aquí se agrega (mismo principio de separación que
// `apps/api/src/domain/resumen.ts` ya usa para ocupación/ADR/RevPAR de "hoy").
//
// Mapeo ingreso -> departamento USALI (ver limitación completa en el header de
// `packages/db/migrations/0110_pl_usali.sql`): 'hospedaje'->rooms, 'ab'->food_beverage,
// 'extras'/'otro'->otros_departamentos, 'ajuste'/'descuento'->rooms (el esquema actual
// de folios no registra a qué departamento aplica un ajuste/descuento genérico),
// 'reverso' resuelve al departamento del cargo ORIGINAL vía `reverses_charge_id`
// (nunca se cuenta como su propio departamento), 'propina' se EXCLUYE por completo.
import type { DbClient } from "@atiende-hoteles/db";
import {
  buildCashFlow13Weeks,
  buildOwnersReport,
  buildUsaliPL,
  computeDynamicBreakeven,
  forecastDailyRevenue90Days,
  CASH_PROJECTION_WEEKS,
  REVENUE_FORECAST_HORIZON_DAYS,
  USALI_REVENUE_DEPARTMENTS,
  USALI_UNDISTRIBUTED_DEPARTMENTS,
  type CashSummary,
  type CashWeekInput,
  type DepartmentExpenseRow,
  type DepartmentRevenueRow,
  type ForecastSummary,
  type OwnersReport,
  type UndistributedRow,
  type UsaliExpenseCategory,
  type UsaliPL,
  type UsaliRevenueDepartment,
} from "@atiende-hoteles/domain-hotel";

// La misma expresión CASE se reutiliza en las dos consultas de ingreso de abajo
// (diaria/mensual comparten fuente) -- centralizada aquí para que un cambio de
// mapeo nunca diverja entre ellas.
const REVENUE_DEPARTMENT_CASE = `
  case coalesce(orig.concept, c.concept)
    when 'hospedaje' then 'rooms'
    when 'ab' then 'food_beverage'
    when 'extras' then 'otros_departamentos'
    when 'otro' then 'otros_departamentos'
    when 'ajuste' then 'rooms'
    when 'descuento' then 'rooms'
    else null
  end
`;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function daysBetweenInclusive(desde: string, hasta: string): string[] {
  const out: string[] = [];
  let cursor = desde;
  while (cursor <= hasta) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

function monthKey(fecha: string): string {
  return fecha.slice(0, 7); // YYYY-MM
}

interface RevenueByDateRow {
  fecha: string;
  department: UsaliRevenueDepartment;
  revenue: string;
}

async function loadRevenueByDate(db: DbClient, hotelId: string, desde: string, hasta: string): Promise<RevenueByDateRow[]> {
  const { rows } = await db.query<{ fecha: string; department: UsaliRevenueDepartment | null; revenue: string }>(
    `select
       coalesce(c.stay_date, c.created_at::date)::text as fecha,
       ${REVENUE_DEPARTMENT_CASE} as department,
       sum(c.amount)::text as revenue
     from public.charge c
     left join public.charge orig on orig.id = c.reverses_charge_id
     where c.hotel_id = $1
       and coalesce(c.stay_date, c.created_at::date) between $2::date and $3::date
       and coalesce(orig.concept, c.concept) <> 'propina'
     group by fecha, department;`,
    [hotelId, desde, hasta],
  );
  return rows.filter((r): r is RevenueByDateRow => r.department != null);
}

interface ExpenseByDateRow {
  fecha: string;
  department: string;
  category: UsaliExpenseCategory;
  amount: string;
}

async function loadExpensesByDate(db: DbClient, hotelId: string, desde: string, hasta: string): Promise<ExpenseByDateRow[]> {
  const { rows } = await db.query<ExpenseByDateRow>(
    `select expense_date::text as fecha, department::text as department, category::text as category, sum(amount)::text as amount
     from public.expense_entry
     where hotel_id = $1 and expense_date between $2::date and $3::date
     group by fecha, department, category;`,
    [hotelId, desde, hasta],
  );
  return rows;
}

interface RoomNightsByDateRow {
  fecha: string;
  roomNights: string;
  revenue: string;
}

/** Habitaciones-noche REALMENTE ocupadas y cobradas (un cargo `concept='hospedaje'`
 *  vigente = una noche ocupada -- night audit postea exactamente uno por
 *  habitación/noche, ver `apps/api/src/jobs/nightAudit.ts`). Excluye cargos ya
 *  reversados (`reversed_by is not null`): esa noche se cancela por completo, tanto en
 *  ingreso (el reverso lo neutraliza en `loadRevenueByDate`) como en el conteo de
 *  ocupación real. */
async function loadOccupiedRoomNightsByDate(
  db: DbClient,
  hotelId: string,
  desde: string,
  hasta: string,
): Promise<RoomNightsByDateRow[]> {
  const { rows } = await db.query<{ fecha: string; room_nights: string; revenue: string }>(
    `select stay_date::text as fecha, count(*)::text as room_nights, sum(amount)::text as revenue
     from public.charge
     where hotel_id = $1 and concept = 'hospedaje' and reversed_by is null
       and stay_date between $2::date and $3::date
     group by fecha;`,
    [hotelId, desde, hasta],
  );
  return rows.map((r) => ({ fecha: r.fecha, roomNights: r.room_nights, revenue: r.revenue }));
}

async function loadTotalRooms(db: DbClient, hotelId: string): Promise<number> {
  const { rows } = await db.query<{ total: string }>("select count(*)::text as total from public.room where hotel_id = $1;", [
    hotelId,
  ]);
  return Number(rows[0]?.total ?? 0);
}

function toDepartmentRevenueRows(rows: RevenueByDateRow[]): DepartmentRevenueRow[] {
  const totals = new Map<UsaliRevenueDepartment, number>();
  for (const r of rows) {
    totals.set(r.department, (totals.get(r.department) ?? 0) + Number(r.revenue));
  }
  return USALI_REVENUE_DEPARTMENTS.map((department) => ({ department, revenue: totals.get(department) ?? 0 }));
}

function toDepartmentExpenseRows(rows: ExpenseByDateRow[]): DepartmentExpenseRow[] {
  return rows
    .filter((r): r is ExpenseByDateRow & { department: UsaliRevenueDepartment } =>
      (USALI_REVENUE_DEPARTMENTS as readonly string[]).includes(r.department),
    )
    .map((r) => ({ department: r.department, category: r.category, amount: Number(r.amount) }));
}

function toUndistributedRows(rows: ExpenseByDateRow[]): UndistributedRow[] {
  return rows
    .filter((r) => (USALI_UNDISTRIBUTED_DEPARTMENTS as readonly string[]).includes(r.department))
    .map((r) => ({ department: r.department as (typeof USALI_UNDISTRIBUTED_DEPARTMENTS)[number], amount: Number(r.amount) }));
}

function sumWhereDepartment(rows: ExpenseByDateRow[], department: string): number {
  return rows.filter((r) => r.department === department).reduce((total, r) => total + Number(r.amount), 0);
}

/** Arma el `UsaliPL` (Summary Operating Statement) para un corte de fechas, a partir
 *  de filas YA filtradas por ese corte. */
function assembleUsaliPL(revenueRows: RevenueByDateRow[], expenseRows: ExpenseByDateRow[]): UsaliPL {
  return buildUsaliPL({
    departmentRevenue: toDepartmentRevenueRows(revenueRows),
    departmentExpenses: toDepartmentExpenseRows(expenseRows),
    undistributedExpenses: toUndistributedRows(expenseRows),
    managementFeeAmount: sumWhereDepartment(expenseRows, "cuota_administracion"),
    nonOperatingExpenseAmount: sumWhereDepartment(expenseRows, "no_operativo"),
  });
}

export interface PeriodoPL {
  inicio: string;
  fin: string;
  pl: UsaliPL;
}

export interface OcupacionKpis {
  adr: number;
  revpar: number;
  occupancyPct: number;
  occupiedRoomNights: number;
  availableRoomNights: number;
  totalRooms: number;
}

export interface FullPLReport {
  periodo: { desde: string; hasta: string };
  diario: PeriodoPL[];
  mensual: PeriodoPL[];
  total: UsaliPL;
  kpis: OcupacionKpis;
  puntoEquilibrio: ReturnType<typeof computeDynamicBreakeven>;
  forecast90d: {
    horizonDias: number;
    puntos: readonly { fecha: string; stepsAhead: number; value: number; lowerBound: number; upperBound: number }[];
    totalIngresosProyectados90d: number;
    promedioDiario90d: number;
  } | null;
  flujoCaja13Semanas: readonly (CashWeekInput & { netChange: number; endingBalance: number })[];
  ownersReport: OwnersReport;
}

export interface BuildPlUsaliReportOptions {
  saldoInicialCaja?: number;
}

export async function buildPlUsaliReport(
  db: DbClient,
  hotelId: string,
  desde: string,
  hasta: string,
  options: BuildPlUsaliReportOptions = {},
): Promise<FullPLReport> {
  if (desde > hasta) {
    throw new RangeError(`rango_invalido: desde (${desde}) es posterior a hasta (${hasta})`);
  }

  const [revenueRows, expenseRows, roomNightsRows, totalRooms] = await Promise.all([
    loadRevenueByDate(db, hotelId, desde, hasta),
    loadExpensesByDate(db, hotelId, desde, hasta),
    loadOccupiedRoomNightsByDate(db, hotelId, desde, hasta),
    loadTotalRooms(db, hotelId),
  ]);

  // --- P&L diario -------------------------------------------------------------
  const allDates = daysBetweenInclusive(desde, hasta);
  const diario: PeriodoPL[] = allDates.map((fecha) => ({
    inicio: fecha,
    fin: fecha,
    pl: assembleUsaliPL(
      revenueRows.filter((r) => r.fecha === fecha),
      expenseRows.filter((r) => r.fecha === fecha),
    ),
  }));

  // --- P&L mensual --------------------------------------------------------------
  const months = [...new Set(allDates.map(monthKey))];
  const mensual: PeriodoPL[] = months.map((mes) => {
    const inicioMes = allDates.filter((f) => monthKey(f) === mes)[0]!;
    const finMes = allDates.filter((f) => monthKey(f) === mes).at(-1)!;
    return {
      inicio: inicioMes,
      fin: finMes,
      pl: assembleUsaliPL(
        revenueRows.filter((r) => monthKey(r.fecha) === mes),
        expenseRows.filter((r) => monthKey(r.fecha) === mes),
      ),
    };
  });

  // --- P&L total del periodo solicitado (base del breakeven/owner's report) -----
  const total = assembleUsaliPL(revenueRows, expenseRows);

  // --- KPIs reales (ADR/RevPAR/ocupación) ---------------------------------------
  const occupiedRoomNights = roomNightsRows.reduce((sum, r) => sum + Number(r.roomNights), 0);
  const roomsRevenueGross = roomNightsRows.reduce((sum, r) => sum + Number(r.revenue), 0);
  const availableRoomNights = totalRooms * allDates.length;
  const adr = occupiedRoomNights > 0 ? roomsRevenueGross / occupiedRoomNights : 0;
  const revpar = availableRoomNights > 0 ? roomsRevenueGross / availableRoomNights : 0;
  const occupancyPct = availableRoomNights > 0 ? (occupiedRoomNights / availableRoomNights) * 100 : 0;
  const kpis: OcupacionKpis = { adr, revpar, occupancyPct, occupiedRoomNights, availableRoomNights, totalRooms };

  // --- Punto de equilibrio dinámico ---------------------------------------------
  const roomsStatement = total.departamentos.find((d) => d.department === "rooms")!;
  const otherDepartmentsProfit = total.departamentos
    .filter((d) => d.department !== "rooms")
    .reduce((sum, d) => sum + d.departmentalProfit, 0);
  const fixedCosts = total.totalGastosNoDistribuidos + total.cuotaAdministracion + total.gastosNoOperativos;
  const roomsVariableCostPerOccupiedRoom = occupiedRoomNights > 0 ? roomsStatement.totalExpenses / occupiedRoomNights : 0;
  const puntoEquilibrio = computeDynamicBreakeven({
    fixedCosts,
    otherDepartmentsProfit,
    realAdr: adr,
    roomsVariableCostPerOccupiedRoom,
    availableRoomNights,
    actualOccupiedRoomNights: occupiedRoomNights,
  });

  // --- Forecast de 90 días (ingreso total diario, serie completa sin huecos) ----
  const revenueByDateTotal = new Map<string, number>();
  for (const r of revenueRows) {
    revenueByDateTotal.set(r.fecha, (revenueByDateTotal.get(r.fecha) ?? 0) + Number(r.revenue));
  }
  const history = allDates.map((fecha) => ({ date: fecha, value: revenueByDateTotal.get(fecha) ?? 0 }));
  const forecastPoints = forecastDailyRevenue90Days(history);
  const forecast90d = forecastPoints
    ? {
        horizonDias: REVENUE_FORECAST_HORIZON_DAYS,
        puntos: forecastPoints.map((p) => ({
          fecha: addDays(hasta, p.stepsAhead),
          stepsAhead: p.stepsAhead,
          value: p.value,
          lowerBound: p.lowerBound,
          upperBound: p.upperBound,
        })),
        totalIngresosProyectados90d: forecastPoints.reduce((sum, p) => sum + p.value, 0),
        promedioDiario90d: forecastPoints.reduce((sum, p) => sum + p.value, 0) / forecastPoints.length,
      }
    : null;
  const forecastSummary: ForecastSummary | null = forecast90d
    ? { totalIngresosProyectados90d: forecast90d.totalIngresosProyectados90d, promedioDiario90d: forecast90d.promedioDiario90d }
    : null;

  // --- Proyección de caja a 13 semanas -------------------------------------------
  const totalExpensesPeriodo = expenseRows.reduce((sum, r) => sum + Number(r.amount), 0);
  const expenseRunRatePerWeek = totalExpensesPeriodo / (allDates.length / 7);

  const weekInputs: CashWeekInput[] = [];
  for (let week = 0; week < CASH_PROJECTION_WEEKS; week += 1) {
    const weekStart = addDays(hasta, 1 + week * 7);
    const weekEnd = addDays(hasta, (week + 1) * 7);
    const { rows } = await db.query<{ total: string | null }>(
      `select sum(total_amount)::text as total
       from public.reservation
       where hotel_id = $1 and status not in ('cancelada', 'no_show')
         and check_in_date between $2::date and $3::date;`,
      [hotelId, weekStart, weekEnd],
    );
    weekInputs.push({
      weekStart,
      weekEnd,
      onBooksInflow: Number(rows[0]?.total ?? 0),
      expenseRunRate: expenseRunRatePerWeek,
    });
  }
  const saldoInicialCaja = options.saldoInicialCaja ?? 0;
  const flujoCaja13Semanas = buildCashFlow13Weeks(saldoInicialCaja, weekInputs);
  const cashSummary: CashSummary = {
    saldoInicial: saldoInicialCaja,
    saldoFinal13Semanas: flujoCaja13Semanas.at(-1)!.endingBalance,
    cambioNetoTotal: flujoCaja13Semanas.reduce((sum, w) => sum + w.netChange, 0),
    semanasConFlujoNegativo: flujoCaja13Semanas.filter((w) => w.netChange < 0).length,
  };

  // --- Owner's report -------------------------------------------------------------
  const ownersReport = buildOwnersReport({
    periodo: { desde, hasta },
    pl: total,
    kpis: { adr, revpar, occupancyPct },
    breakeven: puntoEquilibrio,
    forecastSummary,
    cashSummary,
  });

  return {
    periodo: { desde, hasta },
    diario,
    mensual,
    total,
    kpis,
    puntoEquilibrio,
    forecast90d,
    flujoCaja13Semanas,
    ownersReport,
  };
}
