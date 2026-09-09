// REQ-REV-003: "backtesting walk-forward obligatorio que exija mejora vs. baseline
// antes de habilitar autopilot". Walk-forward (a diferencia de un split train/test
// único) evalúa el motor en varias ventanas SECUENCIALES, cada una entrenada solo con
// datos anteriores a su propia ventana de prueba — nunca con datos futuros (sin fuga de
// información hacia el pasado, requisito mínimo para que "mejora vs. baseline" sea
// creíble).
//
// Este módulo DELIBERADAMENTE no inventa un modelo de elasticidad de demanda propio: no
// hay forma honesta de saber qué habría ocupado un hotel a un precio que nunca se
// cobró de verdad sin asumir una curva de elasticidad, y este repo trata cualquier
// cifra de impacto económico sin método contrafactual explícito como una cifra
// fabricada (mismo criterio que REQ-REV-018/GOB-037: "monto_verificado, monto_estimado,
// método_contrafactual y confianza"). Por eso quien llama a `evaluateWalkForwardBacktest`
// debe: (a) declarar su `counterfactualMethod` explícitamente, y (b) aportar, YA
// CALCULADO por fuera de este módulo (con ese método), el ingreso de cada ventana tanto
// para el motor como para el baseline. Este módulo se limita a dos responsabilidades
// deterministas y auditables: construir las ventanas walk-forward sin fuga de datos
// (`buildWalkForwardWindows`) y adjudicar pass/fail sobre los resultados ya calculados
// (`evaluateWalkForwardBacktest`) con un criterio fijo y explicado.

export type CounterfactualMethod =
  /** Baseline = la tarifa que el hotel de verdad cobró en el período comparable
   *  anterior (mismo mes/temporada del año pasado, o el período previo a activar el
   *  motor) — el método por defecto y el único que no requiere ningún supuesto de
   *  elasticidad: ambos ingresos (motor y baseline) son ingresos REALES ya ocurridos
   *  en ventanas de tiempo distintas, nunca una simulación de "qué habría pasado". */
  | "misma_tarifa_periodo_anterior"
  /** Baseline = la tarifa fija/estática que el hotel usaba antes de activar el motor
   *  de revenue, mantenida constante durante toda la ventana de prueba. */
  | "tarifa_estatica_pre_motor"
  /** El llamador declara y documenta su propio modelo de elasticidad de demanda para
   *  estimar el ingreso contrafactual — este módulo no lo valida ni lo ejecuta, solo
   *  registra que se usó (la responsabilidad de que el método esté bien fundamentado
   *  es de quien lo declara, igual que REQ-REV-018 exige `método_contrafactual`
   *  explícito para cualquier cifra estimada). */
  | "modelo_elasticidad_declarado";

export interface DailyPricingRecord {
  /** Fecha ISO `yyyy-mm-dd`. La serie debe venir ordenada ascendentemente por fecha. */
  readonly date: string;
}

export interface WalkForwardWindowSpec {
  /** Días de historia usados para "entrenar" (ajustar el motor) antes de cada ventana
   *  de prueba. Solo afecta dónde empieza `trainStart`; este módulo no entrena nada. */
  readonly trainDays: number;
  /** Días de la ventana de prueba (out-of-sample) evaluada contra el baseline. */
  readonly testDays: number;
  /** Cuántos días avanza la ventana siguiente respecto al inicio de la anterior — un
   *  valor menor que `testDays` produce ventanas de prueba solapadas (más ventanas,
   *  menos independientes entre sí); igual a `testDays`, ventanas de prueba contiguas
   *  sin solape. */
  readonly stepDays: number;
}

export interface WalkForwardWindow {
  readonly trainStart: string;
  readonly trainEnd: string;
  readonly testStart: string;
  readonly testEnd: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(date: string): Date {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`fecha_invalida: "${date}" no es una fecha ISO yyyy-mm-dd válida`);
  }
  return d;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Arma las ventanas walk-forward (entrenamiento seguido de prueba, deslizantes hacia
 * adelante en el tiempo) que cubren `series`. Cada ventana de prueba usa solo datos de
 * ANTES de sí misma para "entrenar" — nunca datos futuros (sin fuga de información).
 * No calcula ningún ingreso: eso lo hace quien tiene el motor real y el baseline real,
 * usando estas fechas para saber qué comparar.
 */
export function buildWalkForwardWindows(
  series: readonly DailyPricingRecord[],
  spec: WalkForwardWindowSpec,
): WalkForwardWindow[] {
  if (spec.trainDays <= 0 || spec.testDays <= 0 || spec.stepDays <= 0) {
    throw new RangeError("spec_invalido: trainDays/testDays/stepDays deben ser enteros positivos");
  }
  if (series.length === 0) return [];

  const dates = series.map((r) => r.date);
  for (let i = 1; i < dates.length; i++) {
    if (dates[i]! <= dates[i - 1]!) {
      throw new RangeError("serie_no_ordenada: la serie debe venir ordenada ascendentemente por fecha, sin duplicados");
    }
  }

  const seriesStart = parseIsoDate(dates[0]!);
  const seriesEnd = parseIsoDate(dates[dates.length - 1]!);

  const windows: WalkForwardWindow[] = [];
  let trainStart = seriesStart;

  while (true) {
    const trainEnd = addDays(trainStart, spec.trainDays - 1);
    const testStart = addDays(trainEnd, 1);
    const testEnd = addDays(testStart, spec.testDays - 1);
    if (testEnd > seriesEnd) break;

    windows.push({
      trainStart: toIsoDate(trainStart),
      trainEnd: toIsoDate(trainEnd),
      testStart: toIsoDate(testStart),
      testEnd: toIsoDate(testEnd),
    });

    trainStart = addDays(trainStart, spec.stepDays);
  }

  return windows;
}

export interface WindowEvaluation {
  readonly window: WalkForwardWindow;
  /** Ingreso que produjo (o habría producido, según `counterfactualMethod`) la
   *  recomendación del motor en la ventana de prueba. Calculado por el llamador. */
  readonly engineRevenue: number;
  /** Ingreso baseline comparable para la misma ventana. Calculado por el llamador. */
  readonly baselineRevenue: number;
}

export interface WalkForwardBacktestInput {
  readonly evaluations: readonly WindowEvaluation[];
  readonly counterfactualMethod: CounterfactualMethod;
  /** Mínimo de ventanas evaluadas para que el resultado sea significativo — un backtest
   *  de una sola ventana no demuestra nada sobre 90 días de datos. Default 3. */
  readonly minWindows?: number;
  /** Mejora total mínima exigida (%) sobre el ingreso baseline agregado. Default 0 (el
   *  motor debe superar al baseline, no empatar ni perder) — REQ-REV-003: "que exija
   *  mejora vs. baseline", nunca negativo. */
  readonly minImprovementPct?: number;
  /** Fracción mínima de ventanas individuales en las que el motor debe igualar o
   *  superar al baseline, para que la mejora agregada no sea un solo outlier bueno
   *  ocultando que el motor pierde sistemáticamente en la mayoría de las ventanas.
   *  Default 0.5 (mayoría estricta). */
  readonly minWindowWinRatio?: number;
}

export interface WalkForwardBacktestResult {
  readonly engineTotalRevenue: number;
  readonly baselineTotalRevenue: number;
  /** `(engineTotalRevenue - baselineTotalRevenue) / baselineTotalRevenue * 100`. */
  readonly improvementPct: number;
  readonly windowsEvaluated: number;
  readonly windowsEngineWon: number;
  readonly windowWinRatio: number;
  readonly counterfactualMethod: CounterfactualMethod;
  readonly passes: boolean;
  /** Vacío cuando `passes` es `true`. */
  readonly failureReasons: readonly string[];
}

const DEFAULT_MIN_WINDOWS = 3;
const DEFAULT_MIN_IMPROVEMENT_PCT = 0;
const DEFAULT_MIN_WINDOW_WIN_RATIO = 0.5;

/**
 * Adjudica pass/fail de un backtest walk-forward ya calculado. Determinista y sin
 * efectos secundarios — la misma entrada siempre produce la misma salida, para que el
 * resultado pueda auditarse/reproducirse (mismo criterio de auditabilidad que
 * `packages/domain-hotel/src/folioEngine.ts`).
 */
export function evaluateWalkForwardBacktest(input: WalkForwardBacktestInput): WalkForwardBacktestResult {
  const minWindows = input.minWindows ?? DEFAULT_MIN_WINDOWS;
  const minImprovementPct = input.minImprovementPct ?? DEFAULT_MIN_IMPROVEMENT_PCT;
  const minWindowWinRatio = input.minWindowWinRatio ?? DEFAULT_MIN_WINDOW_WIN_RATIO;

  const windowsEvaluated = input.evaluations.length;
  const engineTotalRevenue = input.evaluations.reduce((sum, e) => sum + e.engineRevenue, 0);
  const baselineTotalRevenue = input.evaluations.reduce((sum, e) => sum + e.baselineRevenue, 0);
  const windowsEngineWon = input.evaluations.filter((e) => e.engineRevenue >= e.baselineRevenue).length;
  const windowWinRatio = windowsEvaluated > 0 ? windowsEngineWon / windowsEvaluated : 0;
  const improvementPct = baselineTotalRevenue !== 0 ? ((engineTotalRevenue - baselineTotalRevenue) / baselineTotalRevenue) * 100 : 0;

  const failureReasons: string[] = [];

  if (windowsEvaluated < minWindows) {
    failureReasons.push(`ventanas_insuficientes: se evaluaron ${windowsEvaluated} ventanas, se requieren al menos ${minWindows}`);
  }
  if (baselineTotalRevenue <= 0) {
    failureReasons.push("baseline_invalido: el ingreso baseline agregado debe ser positivo para poder medir una mejora");
  } else if (improvementPct < minImprovementPct) {
    failureReasons.push(
      `no_supera_baseline: el motor mejora ${improvementPct.toFixed(2)}% vs. baseline, se exige al menos ${minImprovementPct}%`,
    );
  }
  if (windowsEvaluated > 0 && windowWinRatio < minWindowWinRatio) {
    failureReasons.push(
      `mayoria_de_ventanas_no_mejora: el motor solo iguala o supera al baseline en ${windowsEngineWon}/${windowsEvaluated} ventanas (${(windowWinRatio * 100).toFixed(1)}%), se exige al menos ${(minWindowWinRatio * 100).toFixed(1)}%`,
    );
  }

  return {
    engineTotalRevenue,
    baselineTotalRevenue,
    improvementPct,
    windowsEvaluated,
    windowsEngineWon,
    windowWinRatio,
    counterfactualMethod: input.counterfactualMethod,
    passes: failureReasons.length === 0,
    failureReasons,
  };
}
