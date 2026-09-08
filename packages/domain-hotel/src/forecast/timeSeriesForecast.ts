// REQ-AGT-012 (LLM-004/LLM-009): "el pronóstico (kWh, ocupación, pick-up, demanda) debe
// resolverse con un modelo de series de tiempo especializado, nunca pidiéndoselo
// directamente a un LLM; el LLM solo redacta la explicación textual del resultado."
//
// Este módulo es el "modelo de series de tiempo especializado" para series NUMÉRICAS
// regulares (consumo de kWh, % de ocupación, demanda/reservas por día) -- para el caso
// específico de pick-up hotelero (reservas en libro + curva histórica de pick-up
// restante) ver `pickupForecast.ts`, que usa un método distinto y más apropiado para ese
// problema concreto.
//
// Implementa suavizado exponencial (Holt para tendencia sin estacionalidad; Holt-Winters
// aditivo cuando hay suficiente historia para estimar un ciclo estacional) -- un método
// clásico, determinista y explicable de forecasting de series de tiempo (NO un LLM, NO
// aleatorio: la misma entrada siempre produce la misma salida, igual que
// `walkForwardBacktest.ts`/`folioEngine.ts`). Deliberadamente NO importa nada de
// `@atiende-hoteles/agent-core` ni de ningún proveedor de LLM -- este módulo no sabe que
// un LLM existe, para que sea estructuralmente imposible que termine pidiéndole el
// pronóstico a uno.

export interface TimeSeriesPoint {
  /** Fecha/hora ISO del punto observado. Solo se usa para trazabilidad; el modelo opera
   *  sobre la SECUENCIA de valores, no sobre la fecha en sí. */
  readonly date: string;
  readonly value: number;
}

/** Tipos de pronóstico cubiertos explícitamente por REQ-AGT-012. `"pickup"` no se resuelve
 *  con este módulo (ver `pickupForecast.ts`) -- se incluye aquí solo para que un
 *  despachador (`forecastKind`) pueda enrutar sin que el llamador tenga que saber de
 *  antemano qué archivo usar. */
export type ForecastKind = "kwh" | "ocupacion" | "demanda" | "pickup";

export interface ExponentialSmoothingOptions {
  /** Cuántos períodos futuros pronosticar. Entero positivo. */
  readonly horizon: number;
  /** Longitud del ciclo estacional (p.ej. 7 para patrón semanal en datos diarios, 24 para
   *  patrón horario en un día). `undefined` o `1` desactiva la estacionalidad (se usa
   *  Holt de tendencia simple). */
  readonly seasonLength?: number;
  /** Suavizado de nivel, (0,1]. Default 0.3. */
  readonly alpha?: number;
  /** Suavizado de tendencia, (0,1]. Default 0.1. */
  readonly beta?: number;
  /** Suavizado estacional, (0,1]. Ignorado sin estacionalidad. Default 0.1. */
  readonly gamma?: number;
}

export interface ForecastPoint {
  /** 1-indexado: 1 es el primer período después del último dato observado. */
  readonly stepsAhead: number;
  readonly value: number;
  /** Banda de incertidumbre ~80% (z=1.2816), creciendo con `sqrt(stepsAhead)` a partir de
   *  la desviación estándar de los residuos IN-SAMPLE (un paso adelante). Nunca inventada:
   *  se deriva de qué tan bien el propio modelo explicó los datos históricos que sí tuvo. */
  readonly lowerBound: number;
  readonly upperBound: number;
}

export interface ExponentialSmoothingResult {
  readonly method: "holt_winters_aditivo" | "holt_doble_exponencial";
  /** 1 cuando no hubo estacionalidad (Holt simple). */
  readonly seasonLength: number;
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
  /** Error absoluto medio de los ajustes un-paso-adelante IN-SAMPLE -- métrica de qué tan
   *  bien el modelo explicó la historia que sí observó, no una promesa sobre el futuro. */
  readonly inSampleMae: number;
  readonly points: readonly ForecastPoint[];
}

const DEFAULT_ALPHA = 0.3;
const DEFAULT_BETA = 0.1;
const DEFAULT_GAMMA = 0.1;
/** z de una normal estándar para ~80% de cobertura (dos colas). Documentado explícitamente
 *  para que quien lea el resultado sepa qué tan ancha es la banda, sin adivinar. */
const Z_80 = 1.2816;

function assertUnitInterval(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError(`${name}_invalido: debe estar en (0, 1], recibido ${value}`);
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Pronostica una serie de tiempo numérica con suavizado exponencial (Holt / Holt-Winters
 * aditivo). Determinista: la misma `history`+`options` siempre produce el mismo resultado.
 * No hace ninguna llamada de red ni depende de nada externo -- puro cómputo numérico.
 */
export function forecastExponentialSmoothing(
  history: readonly TimeSeriesPoint[],
  options: ExponentialSmoothingOptions,
): ExponentialSmoothingResult {
  if (!Number.isInteger(options.horizon) || options.horizon <= 0) {
    throw new RangeError(`horizonte_invalido: debe ser un entero positivo, recibido ${options.horizon}`);
  }
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const beta = options.beta ?? DEFAULT_BETA;
  const gamma = options.gamma ?? DEFAULT_GAMMA;
  assertUnitInterval("alpha", alpha);
  assertUnitInterval("beta", beta);
  assertUnitInterval("gamma", gamma);

  const values = history.map((p) => p.value);
  const n = values.length;
  const seasonLength = options.seasonLength && options.seasonLength > 1 ? Math.trunc(options.seasonLength) : 1;

  if (values.some((v) => !Number.isFinite(v))) {
    throw new RangeError("serie_invalida: todos los valores de la historia deben ser numéricos finitos");
  }

  const useSeasonal = seasonLength > 1 && n >= seasonLength * 2;

  if (!useSeasonal) {
    if (n < 2) {
      throw new RangeError(
        `historia_insuficiente: se requieren al menos 2 puntos para Holt simple (o ${seasonLength * 2} para Holt-Winters con seasonLength=${seasonLength}), recibidos ${n}`,
      );
    }
    return forecastHoltDoble(values, options.horizon, alpha, beta);
  }

  return forecastHoltWintersAditivo(values, options.horizon, seasonLength, alpha, beta, gamma);
}

function forecastHoltDoble(
  values: readonly number[],
  horizon: number,
  alpha: number,
  beta: number,
): ExponentialSmoothingResult {
  const n = values.length;
  const level: number[] = new Array(n);
  const trend: number[] = new Array(n);
  const fitted: number[] = new Array(n);

  level[0] = values[0]!;
  trend[0] = values[1]! - values[0]!;
  fitted[0] = values[0]!;

  for (let t = 1; t < n; t++) {
    fitted[t] = level[t - 1]! + trend[t - 1]!;
    level[t] = alpha * values[t]! + (1 - alpha) * (level[t - 1]! + trend[t - 1]!);
    trend[t] = beta * (level[t]! - level[t - 1]!) + (1 - beta) * trend[t - 1]!;
  }

  const residuals = values.slice(1).map((v, i) => v - fitted[i + 1]!);
  const inSampleMae = residuals.length > 0 ? mean(residuals.map((r) => Math.abs(r))) : 0;
  const residualStd = residualStdDev(residuals);

  const lastLevel = level[n - 1]!;
  const lastTrend = trend[n - 1]!;
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    const value = lastLevel + h * lastTrend;
    const band = Z_80 * residualStd * Math.sqrt(h);
    points.push({ stepsAhead: h, value, lowerBound: value - band, upperBound: value + band });
  }

  return {
    method: "holt_doble_exponencial",
    seasonLength: 1,
    alpha,
    beta,
    gamma: 0,
    inSampleMae,
    points,
  };
}

function forecastHoltWintersAditivo(
  values: readonly number[],
  horizon: number,
  seasonLength: number,
  alpha: number,
  beta: number,
  gamma: number,
): ExponentialSmoothingResult {
  const n = values.length;
  const season1 = values.slice(0, seasonLength);
  const season2 = values.slice(seasonLength, seasonLength * 2);
  const meanSeason1 = mean(season1);
  const meanSeason2 = mean(season2);

  const level: number[] = new Array(n);
  const trend: number[] = new Array(n);
  const season: number[] = new Array(n);
  const fitted: number[] = new Array(n);

  level[seasonLength - 1] = meanSeason1;
  trend[seasonLength - 1] = (meanSeason2 - meanSeason1) / seasonLength;
  for (let i = 0; i < seasonLength; i++) {
    season[i] = season1[i]! - meanSeason1;
  }

  for (let t = seasonLength; t < n; t++) {
    const prevLevel = level[t - 1]!;
    const prevTrend = trend[t - 1]!;
    const seasonalRef = season[t - seasonLength]!;
    fitted[t] = prevLevel + prevTrend + seasonalRef;
    level[t] = alpha * (values[t]! - seasonalRef) + (1 - alpha) * (prevLevel + prevTrend);
    trend[t] = beta * (level[t]! - prevLevel) + (1 - beta) * prevTrend;
    season[t] = gamma * (values[t]! - level[t]!) + (1 - gamma) * seasonalRef;
  }

  const residuals: number[] = [];
  for (let t = seasonLength; t < n; t++) {
    residuals.push(values[t]! - fitted[t]!);
  }
  const inSampleMae = residuals.length > 0 ? mean(residuals.map((r) => Math.abs(r))) : 0;
  const residualStd = residualStdDev(residuals);

  const lastLevel = level[n - 1]!;
  const lastTrend = trend[n - 1]!;
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    // Índice estacional del ciclo más reciente ya observado que corresponde a este paso
    // futuro (el mismo "día de la semana"/"hora del día" relativo al final de la serie).
    const seasonIdx = n - seasonLength + ((h - 1) % seasonLength);
    const value = lastLevel + h * lastTrend + season[seasonIdx]!;
    const band = Z_80 * residualStd * Math.sqrt(h);
    points.push({ stepsAhead: h, value, lowerBound: value - band, upperBound: value + band });
  }

  return {
    method: "holt_winters_aditivo",
    seasonLength,
    alpha,
    beta,
    gamma,
    inSampleMae,
    points,
  };
}

function residualStdDev(residuals: readonly number[]): number {
  if (residuals.length === 0) return 0;
  const m = mean(residuals as number[]);
  const variance = mean(residuals.map((r) => (r - m) ** 2));
  return Math.sqrt(variance);
}
