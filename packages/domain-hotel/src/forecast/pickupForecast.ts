// REQ-AGT-012: pronóstico de "pick-up" hotelero -- distinto de una serie de tiempo
// genérica (`timeSeriesForecast.ts`). El método estándar de revenue management es: tomar
// las reservas YA EN LIBRO ("on the books") para una fecha de llegada, a N días de
// anticipación, y sumarles el "pick-up restante" promedio que la HISTORIA muestra que
// suele llegar entre ese punto y la llegada, para fechas comparables pasadas. Es
// determinista y auditable (misma entrada -> misma salida) y, como
// `walkForwardBacktest.ts`, NO inventa el dato que falta: la curva de pick-up histórica
// (`historicalPickupCurve`) la calcula el llamador a partir de reservas reales ya
// cerradas -- este módulo solo la aplica.
//
// Deliberadamente sin estacionalidad. no hace ninguna llamada de red ni depende de nada
// externo, y en particular no importa nada de `@atiende-hoteles/agent-core` ni de ningún
// proveedor de LLM (mismo principio que `timeSeriesForecast.ts`): estructuralmente no
// puede terminar pidiéndole el pronóstico a un LLM porque ni siquiera sabe que existe uno.

export interface PickupCurvePoint {
  /** Días de anticipación respecto a la llegada (0 = el propio día de llegada). Entero
   *  no-negativo. */
  readonly daysBeforeArrival: number;
  /** Pick-up restante PROMEDIO observado históricamente entre este punto y la llegada,
   *  para fechas comparables (mismo día de semana/temporada, según decida el llamador al
   *  construir la curva) -- ya calculado por fuera de este módulo a partir de reservas
   *  reales, nunca inventado aquí. */
  readonly averageRemainingPickup: number;
}

export interface PickupForecastInput {
  /** Reservas ya en libro ("on the books") para la fecha objetivo, en el momento del
   *  snapshot. */
  readonly onTheBooksCount: number;
  /** Días de anticipación del snapshot actual respecto a la llegada. */
  readonly daysBeforeArrival: number;
  /** Curva histórica de pick-up restante, indexada por días de anticipación. Al menos un
   *  punto; no requiere venir ordenada. No puede haber dos puntos con el mismo
   *  `daysBeforeArrival` (ambigüedad -- se rechaza en vez de promediar en silencio). */
  readonly historicalPickupCurve: readonly PickupCurvePoint[];
  /** Máximo histórico observado de conteo final para fechas comparables. Cuando se
   *  provee, acota el pronóstico: este módulo nunca proyecta un resultado final por
   *  encima de lo que la historia haya mostrado como plausible (mismo espíritu que
   *  `walkForwardBacktest.ts`: no fabricar una cifra sin respaldo empírico). */
  readonly maxHistoricalFinalCount?: number;
}

export interface PickupForecastResult {
  readonly method: "pickup_promedio_historico";
  readonly daysBeforeArrival: number;
  readonly onTheBooksCount: number;
  /** Pick-up restante esperado, tomado (o interpolado) de la curva histórica. */
  readonly expectedRemainingPickup: number;
  /** `onTheBooksCount + expectedRemainingPickup`, acotado por `maxHistoricalFinalCount`
   *  cuando se proveyó. */
  readonly projectedFinalCount: number;
  /** true si `daysBeforeArrival` no existía exacto en la curva y se interpoló/extrapoló
   *  entre los puntos vecinos (o se usó el punto más cercano, si cae fuera del rango
   *  histórico -- nunca se extrapola más allá de lo observado). */
  readonly interpolated: boolean;
}

/**
 * Proyecta el conteo final (ocupación/reservas) para una fecha de llegada combinando lo
 * que ya está en libro con el pick-up restante promedio histórico. Determinista: la misma
 * entrada siempre produce la misma salida.
 */
export function forecastPickup(input: PickupForecastInput): PickupForecastResult {
  if (!Number.isFinite(input.onTheBooksCount) || input.onTheBooksCount < 0) {
    throw new RangeError(`on_the_books_invalido: debe ser un número no-negativo, recibido ${input.onTheBooksCount}`);
  }
  if (!Number.isInteger(input.daysBeforeArrival) || input.daysBeforeArrival < 0) {
    throw new RangeError(
      `dias_anticipacion_invalido: debe ser un entero no-negativo, recibido ${input.daysBeforeArrival}`,
    );
  }
  if (input.historicalPickupCurve.length === 0) {
    throw new RangeError("curva_historica_vacia: se requiere al menos un punto de curva de pick-up histórica");
  }

  const curve = [...input.historicalPickupCurve].sort((a, b) => a.daysBeforeArrival - b.daysBeforeArrival);
  const seenDays = new Set<number>();
  for (const point of curve) {
    if (!Number.isInteger(point.daysBeforeArrival) || point.daysBeforeArrival < 0) {
      throw new RangeError(`curva_historica_invalida: daysBeforeArrival debe ser entero no-negativo (${point.daysBeforeArrival})`);
    }
    if (!Number.isFinite(point.averageRemainingPickup) || point.averageRemainingPickup < 0) {
      throw new RangeError(
        `curva_historica_invalida: averageRemainingPickup debe ser no-negativo (${point.averageRemainingPickup})`,
      );
    }
    if (seenDays.has(point.daysBeforeArrival)) {
      throw new RangeError(
        `curva_historica_duplicada: más de un punto con daysBeforeArrival=${point.daysBeforeArrival}`,
      );
    }
    seenDays.add(point.daysBeforeArrival);
  }

  const { expectedRemainingPickup, interpolated } = lookupPickup(curve, input.daysBeforeArrival);

  let projectedFinalCount = input.onTheBooksCount + expectedRemainingPickup;
  if (input.maxHistoricalFinalCount !== undefined) {
    projectedFinalCount = Math.min(projectedFinalCount, input.maxHistoricalFinalCount);
  }

  return {
    method: "pickup_promedio_historico",
    daysBeforeArrival: input.daysBeforeArrival,
    onTheBooksCount: input.onTheBooksCount,
    expectedRemainingPickup,
    projectedFinalCount,
    interpolated,
  };
}

function lookupPickup(
  curve: readonly PickupCurvePoint[],
  daysBeforeArrival: number,
): { expectedRemainingPickup: number; interpolated: boolean } {
  const exact = curve.find((p) => p.daysBeforeArrival === daysBeforeArrival);
  if (exact) return { expectedRemainingPickup: exact.averageRemainingPickup, interpolated: false };

  const first = curve[0]!;
  const last = curve[curve.length - 1]!;

  // Fuera del rango histórico observado: nunca se extrapola más allá de lo que la
  // historia mostró -- se usa el extremo más cercano (peor caso conservador conocido, no
  // un número inventado).
  if (daysBeforeArrival < first.daysBeforeArrival) {
    return { expectedRemainingPickup: first.averageRemainingPickup, interpolated: true };
  }
  if (daysBeforeArrival > last.daysBeforeArrival) {
    return { expectedRemainingPickup: last.averageRemainingPickup, interpolated: true };
  }

  // Interpolación lineal entre los dos puntos vecinos que sí están en la curva.
  let lower = first;
  let upper = last;
  for (let i = 0; i < curve.length - 1; i++) {
    if (curve[i]!.daysBeforeArrival <= daysBeforeArrival && curve[i + 1]!.daysBeforeArrival >= daysBeforeArrival) {
      lower = curve[i]!;
      upper = curve[i + 1]!;
      break;
    }
  }
  const span = upper.daysBeforeArrival - lower.daysBeforeArrival;
  const ratio = span === 0 ? 0 : (daysBeforeArrival - lower.daysBeforeArrival) / span;
  const value = lower.averageRemainingPickup + ratio * (upper.averageRemainingPickup - lower.averageRemainingPickup);
  return { expectedRemainingPickup: value, interpolated: true };
}
