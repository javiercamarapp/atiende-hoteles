// REQ-BO-010 (P0/BP-024/BP-041/BP-071/H16-016/H16-017/H07-032/H17-002/H04-023): motor
// PURO (sin acceso a DB, determinista, mismo principio que
// `revenue/revenueEngineGate.ts` y `forecast/timeSeriesForecast.ts`) de las 5
// superficies exigidas: (1) P&L USALI por departamento, (2) forecast de 90 días
// (reutiliza `forecastExponentialSmoothing`, NUNCA reimplementa su propio modelo),
// (3) punto de equilibrio dinámico, (4) owner's report, (5) proyección de caja a 13
// semanas. Toda la agregación desde Postgres (ingresos reales por `charge.concept`,
// gastos reales de `expense_entry`, reservas reales en libro) vive en
// `apps/api/src/domain/plUsali.ts` -- este módulo solo aplica la aritmética sobre
// filas YA agregadas, para que cada fórmula sea unit-testeable sin levantar Postgres
// (ver tests/unit/domain-hotel/usali-pl.spec.ts) y la integración
// (tests/integration/bo/pl-usali.spec.ts) solo tenga que verificar que la agregación
// SQL alimenta estas fórmulas con los números reales correctos.
import { forecastExponentialSmoothing, type ForecastPoint, type TimeSeriesPoint } from "../forecast/timeSeriesForecast.ts";

/** Departamentos operados (tienen ingreso propio, `charge.concept` los alimenta). */
export const USALI_REVENUE_DEPARTMENTS = ["rooms", "food_beverage", "otros_departamentos"] as const;
export type UsaliRevenueDepartment = (typeof USALI_REVENUE_DEPARTMENTS)[number];

/** Gastos no distribuidos: sin ingreso propio, viven de `expense_entry` solamente. */
export const USALI_UNDISTRIBUTED_DEPARTMENTS = [
  "admin_general",
  "ventas_marketing",
  "operacion_mantenimiento",
  "utilities",
] as const;
export type UsaliUndistributedDepartment = (typeof USALI_UNDISTRIBUTED_DEPARTMENTS)[number];

export type UsaliExpenseCategory = "costo_ventas" | "nomina" | "otros_gastos";

// ---------------------------------------------------------------------------------
// 1) P&L USALI por departamento (diario/mensual: la misma función corre para
//    cualquier corte de fechas -- quien arma el bucket diario/mensual es la capa de
//    agregación SQL, ver apps/api/src/domain/plUsali.ts).
// ---------------------------------------------------------------------------------

export interface DepartmentRevenueRow {
  department: UsaliRevenueDepartment;
  revenue: number;
}

export interface DepartmentExpenseRow {
  department: UsaliRevenueDepartment;
  category: UsaliExpenseCategory;
  amount: number;
}

export interface DepartmentStatement {
  department: UsaliRevenueDepartment;
  revenue: number;
  costOfSales: number;
  payroll: number;
  otherExpenses: number;
  totalExpenses: number;
  departmentalProfit: number;
  /** null cuando el departamento no tuvo ingreso (no se fabrica un 0% engañoso). */
  profitMarginPct: number | null;
}

function sumBy<T>(rows: readonly T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

export function buildDepartmentalStatements(
  revenueRows: readonly DepartmentRevenueRow[],
  expenseRows: readonly DepartmentExpenseRow[],
): DepartmentStatement[] {
  return USALI_REVENUE_DEPARTMENTS.map((department) => {
    const revenue = sumBy(
      revenueRows.filter((r) => r.department === department),
      (r) => r.revenue,
    );
    const deptExpenses = expenseRows.filter((e) => e.department === department);
    const costOfSales = sumBy(
      deptExpenses.filter((e) => e.category === "costo_ventas"),
      (e) => e.amount,
    );
    const payroll = sumBy(
      deptExpenses.filter((e) => e.category === "nomina"),
      (e) => e.amount,
    );
    const otherExpenses = sumBy(
      deptExpenses.filter((e) => e.category === "otros_gastos"),
      (e) => e.amount,
    );
    const totalExpenses = costOfSales + payroll + otherExpenses;
    const departmentalProfit = revenue - totalExpenses;

    return {
      department,
      revenue,
      costOfSales,
      payroll,
      otherExpenses,
      totalExpenses,
      departmentalProfit,
      profitMarginPct: revenue > 0 ? (departmentalProfit / revenue) * 100 : null,
    };
  });
}

export interface UndistributedRow {
  department: UsaliUndistributedDepartment;
  amount: number;
}

export interface UsaliPL {
  departamentos: DepartmentStatement[];
  ingresosTotales: number;
  utilidadDepartamentalTotal: number;
  gastosNoDistribuidos: UndistributedRow[];
  totalGastosNoDistribuidos: number;
  gop: number;
  gopMarginPct: number | null;
  cuotaAdministracion: number;
  ebitda: number;
  gastosNoOperativos: number;
  utilidadNeta: number;
}

export interface BuildUsaliPLInput {
  departmentRevenue: readonly DepartmentRevenueRow[];
  departmentExpenses: readonly DepartmentExpenseRow[];
  /** Uno por cada `UsaliUndistributedDepartment` con gasto (los que no aparecen se
   *  tratan como 0, nunca se fabrica un departamento inexistente). */
  undistributedExpenses: readonly UndistributedRow[];
  /** Suma de `expense_entry` con department = 'cuota_administracion' del periodo. */
  managementFeeAmount: number;
  /** Suma de `expense_entry` con department = 'no_operativo' del periodo. */
  nonOperatingExpenseAmount: number;
}

/**
 * Ensambla el Summary Operating Statement USALI 12ª edición (ver nota de alcance en
 * `packages/db/migrations/0110_pl_usali.sql`): Ingresos -> Utilidad departamental ->
 * Gastos no distribuidos -> GOP -> cuota de administración -> EBITDA -> gastos no
 * operativos -> Utilidad neta.
 */
export function buildUsaliPL(input: BuildUsaliPLInput): UsaliPL {
  const departamentos = buildDepartmentalStatements(input.departmentRevenue, input.departmentExpenses);
  const ingresosTotales = sumBy(departamentos, (d) => d.revenue);
  const utilidadDepartamentalTotal = sumBy(departamentos, (d) => d.departmentalProfit);

  const gastosNoDistribuidos = USALI_UNDISTRIBUTED_DEPARTMENTS.map((department) => ({
    department,
    amount: sumBy(
      input.undistributedExpenses.filter((u) => u.department === department),
      (u) => u.amount,
    ),
  }));
  const totalGastosNoDistribuidos = sumBy(gastosNoDistribuidos, (u) => u.amount);

  const gop = utilidadDepartamentalTotal - totalGastosNoDistribuidos;
  const ebitda = gop - input.managementFeeAmount;
  const utilidadNeta = ebitda - input.nonOperatingExpenseAmount;

  return {
    departamentos,
    ingresosTotales,
    utilidadDepartamentalTotal,
    gastosNoDistribuidos,
    totalGastosNoDistribuidos,
    gop,
    gopMarginPct: ingresosTotales > 0 ? (gop / ingresosTotales) * 100 : null,
    cuotaAdministracion: input.managementFeeAmount,
    ebitda,
    gastosNoOperativos: input.nonOperatingExpenseAmount,
    utilidadNeta,
  };
}

// ---------------------------------------------------------------------------------
// 2) Forecast de 90 días: envoltura delgada sobre `forecastExponentialSmoothing`
//    (REQ-AGT-012) -- este módulo NUNCA reimplementa su propio modelo de series de
//    tiempo. `seasonLength: 7` captura el patrón semanal típico de ocupación/ingreso
//    hotelero cuando hay historia suficiente (>=14 días); con menos historia el propio
//    módulo degrada automáticamente a Holt simple (sin estacionalidad).
// ---------------------------------------------------------------------------------

export const REVENUE_FORECAST_HORIZON_DAYS = 90;

export function forecastDailyRevenue90Days(history: readonly TimeSeriesPoint[]): readonly ForecastPoint[] | null {
  // Menos de 2 puntos: `forecastExponentialSmoothing` no puede ajustar ni Holt simple
  // -- se devuelve null (sin datos suficientes), nunca un pronóstico fabricado.
  if (history.length < 2) return null;
  return forecastExponentialSmoothing(history, { horizon: REVENUE_FORECAST_HORIZON_DAYS, seasonLength: 7 }).points;
}

// ---------------------------------------------------------------------------------
// 3) Punto de equilibrio DINÁMICO: recalculado cada vez con costos y ADR REALES del
//    periodo (nunca un supuesto fijo de "costo variable %" cableado en código). La
//    lógica clásica de breakeven hotelero: cuántas habitaciones-noche ocupadas se
//    necesitan para que el margen de contribución de Rooms cubra los costos que NO
//    varían con la ocupación (gastos no distribuidos + cuota de administración +
//    gastos no operativos), NETEADOS contra la utilidad (o pérdida) real de F&B/Otros
//    Departamentos -- si esos departamentos ya generan utilidad, reducen lo que Rooms
//    tiene que cubrir; si generan pérdida, lo aumentan.
// ---------------------------------------------------------------------------------

export interface DynamicBreakevenInput {
  /** Gastos no distribuidos + cuota de administración + gastos no operativos, del
   *  MISMO periodo que `realAdr`/`roomsVariableCostPerOccupiedRoom` -- "dinámico"
   *  significa que se recalcula por periodo, nunca un monto fijo. */
  fixedCosts: number;
  /** Utilidad (o pérdida, si es negativa) departamental REAL de food_beverage +
   *  otros_departamentos del mismo periodo -- reduce (o aumenta) la carga fija que
   *  Rooms debe cubrir. */
  otherDepartmentsProfit: number;
  /** Ingreso real de Rooms / habitaciones-noche ocupadas reales del periodo (nunca la
   *  tarifa de rack de `rate_plan`) -- el ADR "real" que exige el criterio. */
  realAdr: number;
  /** Gasto real del departamento Rooms (`expense_entry`) / habitaciones-noche
   *  ocupadas reales del mismo periodo -- el costo variable real por habitación. */
  roomsVariableCostPerOccupiedRoom: number;
  /** Habitaciones físicas del hotel x días del periodo (ver limitación documentada en
   *  apps/api/src/domain/plUsali.ts: asume inventario constante durante el periodo). */
  availableRoomNights: number;
  /** Habitaciones-noche REALMENTE ocupadas y cobradas en el periodo (para reportar el
   *  hueco real vs. punto de equilibrio, no solo el punto de equilibrio en sí). */
  actualOccupiedRoomNights: number;
}

export interface DynamicBreakevenResult {
  fixedCostsNetOfOtherDepartments: number;
  contributionMarginPerRoom: number;
  /** null cuando el margen de contribución no es positivo: nunca se alcanza
   *  equilibrio subiendo ocupación (hace falta subir ADR o bajar costo), no se
   *  fabrica un número sin sentido. */
  breakevenOccupiedRoomNights: number | null;
  breakevenOccupancyPct: number | null;
  actualOccupancyPct: number;
  /** actualOccupancyPct - breakevenOccupancyPct: positivo = por ENCIMA del punto de
   *  equilibrio. null cuando breakevenOccupancyPct es null. */
  occupancyGapPct: number | null;
}

export function computeDynamicBreakeven(input: DynamicBreakevenInput): DynamicBreakevenResult {
  const fixedCostsNetOfOtherDepartments = input.fixedCosts - input.otherDepartmentsProfit;
  const contributionMarginPerRoom = input.realAdr - input.roomsVariableCostPerOccupiedRoom;

  const breakevenOccupiedRoomNights =
    contributionMarginPerRoom > 0 ? fixedCostsNetOfOtherDepartments / contributionMarginPerRoom : null;
  const breakevenOccupancyPct =
    breakevenOccupiedRoomNights != null && input.availableRoomNights > 0
      ? (breakevenOccupiedRoomNights / input.availableRoomNights) * 100
      : null;
  const actualOccupancyPct =
    input.availableRoomNights > 0 ? (input.actualOccupiedRoomNights / input.availableRoomNights) * 100 : 0;

  return {
    fixedCostsNetOfOtherDepartments,
    contributionMarginPerRoom,
    breakevenOccupiedRoomNights,
    breakevenOccupancyPct,
    actualOccupancyPct,
    occupancyGapPct: breakevenOccupancyPct != null ? actualOccupancyPct - breakevenOccupancyPct : null,
  };
}

// ---------------------------------------------------------------------------------
// 4) Proyección de caja a 13 semanas: entrada = ingreso REAL "en libro" (reservas ya
//    confirmadas con check-in dentro de la semana, `reservation.total_amount`) menos
//    salida = corrida real de gasto histórico del periodo cerrado proyectada hacia
//    adelante (única base disponible hoy: no existe todavía un calendario de gasto
//    futuro/presupuesto, ver apps/api/src/domain/plUsali.ts) -- documentado como
//    límite explícito, nunca oculto.
// ---------------------------------------------------------------------------------

export const CASH_PROJECTION_WEEKS = 13;

export interface CashWeekInput {
  weekStart: string;
  weekEnd: string;
  onBooksInflow: number;
  expenseRunRate: number;
}

export interface CashWeekProjection extends CashWeekInput {
  netChange: number;
  endingBalance: number;
}

export function buildCashFlow13Weeks(
  startingBalance: number,
  weeks: readonly CashWeekInput[],
): readonly CashWeekProjection[] {
  if (weeks.length !== CASH_PROJECTION_WEEKS) {
    throw new RangeError(
      `semanas_invalidas: se requieren exactamente ${CASH_PROJECTION_WEEKS} semanas, recibidas ${weeks.length}`,
    );
  }

  let balance = startingBalance;
  return weeks.map((week) => {
    const netChange = week.onBooksInflow - week.expenseRunRate;
    balance += netChange;
    return { ...week, netChange, endingBalance: balance };
  });
}

// ---------------------------------------------------------------------------------
// 5) Owner's report: ensambla las 4 superficies anteriores + KPIs reales en un solo
//    documento para el dueño, con alertas derivadas SIEMPRE de los números ya
//    calculados (nunca texto libre de un LLM inventando una cifra -- mismo criterio
//    que REQ-AGT-012 exige para el forecast).
// ---------------------------------------------------------------------------------

export interface OwnersReportKpis {
  adr: number;
  revpar: number;
  occupancyPct: number;
}

export interface ForecastSummary {
  totalIngresosProyectados90d: number;
  promedioDiario90d: number;
}

export interface CashSummary {
  saldoInicial: number;
  saldoFinal13Semanas: number;
  cambioNetoTotal: number;
  semanasConFlujoNegativo: number;
}

export interface OwnersReportInput {
  periodo: { desde: string; hasta: string };
  pl: UsaliPL;
  kpis: OwnersReportKpis;
  breakeven: DynamicBreakevenResult;
  forecastSummary: ForecastSummary | null;
  cashSummary: CashSummary;
}

export interface OwnersReport extends OwnersReportInput {
  porEncimaDePuntoDeEquilibrio: boolean | null;
  alertas: string[];
}

export function buildOwnersReport(input: OwnersReportInput): OwnersReport {
  const alertas: string[] = [];

  const porEncimaDePuntoDeEquilibrio = input.breakeven.occupancyGapPct != null ? input.breakeven.occupancyGapPct >= 0 : null;

  if (porEncimaDePuntoDeEquilibrio === false) {
    alertas.push(
      `Ocupación real (${input.breakeven.actualOccupancyPct.toFixed(1)}%) está ${Math.abs(input.breakeven.occupancyGapPct!).toFixed(1)} pp por debajo del punto de equilibrio dinámico (${input.breakeven.breakevenOccupancyPct!.toFixed(1)}%).`,
    );
  }
  if (input.breakeven.contributionMarginPerRoom <= 0) {
    alertas.push(
      "El costo variable real por habitación ocupada iguala o supera el ADR real: ninguna ocupación alcanza el punto de equilibrio -- revisar tarifa o costo de Rooms.",
    );
  }
  if (input.pl.gop < 0) {
    alertas.push(`GOP negativo (${input.pl.gop.toFixed(2)}) en el periodo ${input.periodo.desde} a ${input.periodo.hasta}.`);
  }
  if (input.cashSummary.semanasConFlujoNegativo > 0) {
    alertas.push(
      `${input.cashSummary.semanasConFlujoNegativo} de ${CASH_PROJECTION_WEEKS} semanas proyectadas con flujo de caja neto negativo.`,
    );
  }

  return { ...input, porEncimaDePuntoDeEquilibrio, alertas };
}
