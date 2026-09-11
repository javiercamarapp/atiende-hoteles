// REQ-REV-017 (P2/F, fuente H05-017): "El sistema debe recomendar un ajuste de tarifa
// (BAR) cuando el índice de reputación suba sobre un umbral en una ventana de tiempo
// definida." Confirmado por grep antes de este archivo: no existía ningún módulo que
// conectara reputación (REQ-CRM-002, `reputacion/clasificador.ts`, que ya produce un
// `sentiment_score` -1..1 por reseña) con revenue (`revenue/*.ts`) -- este archivo es
// el primer puente entre esos dos dominios.
//
// Alcance deliberado, distinto de REQ-CRM-006 ("panel/índice propio de reputación tipo
// GRI con tasa de respuesta, volumen por plataforma y estimación mensual del efecto en
// ADR", todavía `pendiente`): este módulo NO construye ese panel completo -- solo el
// índice mínimo (promedio de `sentiment_score` remapeado a 0..100) que el criterio de
// ESTE requisito necesita para poder decidir "sube sobre un umbral en una ventana". Si
// REQ-CRM-006 se construye después, debe reusar `sentimentScoreToIndice()` en vez de
// reinventar su propio remapeo -1..1 -> 0..100.
//
// Puro (sin I/O, mismo principio que fraude/deteccion.ts y revenueEngineGate.ts): la
// lectura real de `guest_review` y la persistencia idempotente de la recomendación
// viven en `apps/api/src/jobs/barReputacionEvaluator.ts` (mismo patrón de capas que
// `jobs/ticketEscalation.ts` puro vs. su scheduler de I/O) -- este archivo solo decide,
// dada una serie de puntos YA leída, si hubo un cruce de umbral dentro de la ventana y
// qué ajuste de BAR recomendar.
import { PROPONE_VARIATION_PCT_MAX, PROPONE_VARIATION_PCT_MIN } from "./revenueEngineGate.ts";

export const REPUTATION_INDEX_MIN = 0;
export const REPUTATION_INDEX_MAX = 100;

/** Umbral y ventana por defecto cuando el hotel no configuró los propios -- 75/100 es
 *  un GRI "muy bueno" (referencia de la industria: Global Review Index de ReviewPro/
 *  Shiji, 0-100, >=80 se considera excelente, 70-79 muy bueno); 30 días es la misma
 *  granularidad "mensual" que REQ-CRM-006 ya declara para su panel, para no introducir
 *  una segunda cadencia de reporte de reputación en el mismo sistema. */
export const DEFAULT_BAR_REPUTATION_THRESHOLD = 75;
export const DEFAULT_BAR_REPUTATION_WINDOW_DAYS = 30;

export interface IndiceReputacionPunto {
  readonly fecha: Date;
  /** 0..100, ver `sentimentScoreToIndice`. */
  readonly valor: number;
}

export interface CruceUmbralResult {
  readonly cruzo: boolean;
  readonly fechaCruce: Date | null;
  readonly indiceAntesDeCruce: number | null;
  /** Índice del punto más reciente dentro de la ventana evaluada -- presente aunque
   *  `cruzo` sea `false`, siempre que la ventana tenga al menos un punto, para que el
   *  llamador pueda loguear/mostrar el índice vigente incluso sin recomendación. */
  readonly indiceActual: number | null;
}

/**
 * Remapea un `sentiment_score` (-1..1, `analizarSentimiento()` de
 * `reputacion/clasificador.ts`) a la escala 0..100 tipo GRI que usa este módulo --
 * -1 -> 0, 0 -> 50, 1 -> 100.
 */
export function sentimentScoreToIndice(sentimentScore: number): number {
  if (!Number.isFinite(sentimentScore) || sentimentScore < -1 || sentimentScore > 1) {
    throw new RangeError(`sentiment_score fuera de rango (-1..1): ${sentimentScore}`);
  }
  return ((sentimentScore + 1) / 2) * 100;
}

/**
 * Índice de reputación agregado de un conjunto de reseñas -- promedio simple de sus
 * `sentiment_score` remapeados a 0..100 (promediar antes o después del remapeo da el
 * mismo resultado porque el remapeo es afín, pero este módulo SIEMPRE remapea primero
 * para que el promedio nunca dependa de ese detalle de implementación). `[]` -> `null`:
 * sin reseñas no hay índice que evaluar, nunca se inventa un valor neutro (50) que
 * pudiera disparar un falso "cruce".
 */
export function calcularIndiceReputacion(sentimentScores: readonly number[]): number | null {
  if (sentimentScores.length === 0) return null;
  const suma = sentimentScores.reduce((acc, s) => acc + sentimentScoreToIndice(s), 0);
  return Math.round((suma / sentimentScores.length) * 100) / 100;
}

/**
 * Detecta si, dentro de la ventana `[ahora - ventanaDias, ahora]`, el índice de
 * reputación CRUZÓ de abajo del umbral hacia arriba (o igual) Y sigue arriba del
 * umbral en el punto más reciente de la ventana -- "sube sobre un umbral", no
 * "está arriba del umbral": una serie que ya empezaba por encima del umbral antes del
 * primer punto observado en la ventana no cuenta como un cruce nuevo (evita
 * "recomendar" solo porque la reputación siempre fue buena), y una subida que ya volvió
 * a caer por debajo del umbral antes del punto más reciente tampoco cuenta (evita
 * recomendar un ajuste sobre una mejora que ya no es vigente).
 *
 * `serie` debe venir ordenada ASCENDENTE por fecha (el llamador real la arma así desde
 * `ORDER BY fecha` de la consulta a `guest_review`, ver `barReputacionEvaluator.ts`) --
 * este módulo no ordena por diseño (mismo principio que otros módulos puros del
 * dominio: nunca oculta un supuesto sobre el orden de entrada haciendo un sort
 * silencioso que enmascararía un bug real del llamador).
 */
export function detectarCruceDeUmbral(
  serie: readonly IndiceReputacionPunto[],
  umbral: number,
  ventanaDias: number,
  ahora: Date,
): CruceUmbralResult {
  if (!Number.isFinite(umbral) || umbral < REPUTATION_INDEX_MIN || umbral > REPUTATION_INDEX_MAX) {
    throw new RangeError(`umbral fuera de rango (${REPUTATION_INDEX_MIN}..${REPUTATION_INDEX_MAX}): ${umbral}`);
  }
  if (!Number.isFinite(ventanaDias) || ventanaDias <= 0) {
    throw new RangeError(`ventanaDias debe ser un número positivo: ${ventanaDias}`);
  }

  const desde = new Date(ahora.getTime() - ventanaDias * 24 * 60 * 60 * 1000);
  const enVentana = serie.filter((p) => p.fecha >= desde && p.fecha <= ahora);

  const sinCruce = (indiceActual: number | null): CruceUmbralResult => ({
    cruzo: false,
    fechaCruce: null,
    indiceAntesDeCruce: null,
    indiceActual,
  });

  if (enVentana.length === 0) return sinCruce(null);

  const ultimo = enVentana[enVentana.length - 1]!;
  if (ultimo.valor < umbral) {
    // El índice actual ni siquiera está sobre el umbral ahora -- nada que recomendar,
    // haya o no cruzado transitoriamente en algún punto intermedio de la ventana.
    return sinCruce(ultimo.valor);
  }

  // Primer punto de la ventana en el que el índice pasa de abajo del umbral a
  // arriba/igual -- ese es el momento real del "cruce" que exige el criterio de
  // aceptación ("serie sintética de reputación que cruza el umbral").
  for (let i = 1; i < enVentana.length; i++) {
    const anterior = enVentana[i - 1]!;
    const actual = enVentana[i]!;
    if (anterior.valor < umbral && actual.valor >= umbral) {
      return { cruzo: true, fechaCruce: actual.fecha, indiceAntesDeCruce: anterior.valor, indiceActual: ultimo.valor };
    }
  }

  // El último punto está sobre el umbral, pero ningún par consecutivo DENTRO de la
  // ventana muestra la subida (el índice ya estaba arriba desde el primer punto
  // observado) -- no es un cruce nuevo, es un estado que ya traía de antes de la
  // ventana.
  return sinCruce(ultimo.valor);
}

export interface RecomendacionAjusteBar {
  /** Positivo, siempre dentro de [PROPONE_VARIATION_PCT_MIN, PROPONE_VARIATION_PCT_MAX]. */
  readonly ajustePorcentaje: number;
  readonly fechaCruce: Date;
  readonly indiceAntesDeCruce: number;
  readonly indiceActual: number;
  readonly umbral: number;
  readonly razon: string;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Traduce un cruce de umbral ya detectado en una recomendación concreta de ajuste de
 * BAR. `null` si `cruce.cruzo` es `false` (nunca inventa una recomendación sin un
 * cruce real).
 *
 * El porcentaje sugerido escala con qué tanto se elevó el índice ACTUAL sobre el
 * umbral (0 en el momento justo del cruce .. 1 cuando el índice llega al máximo
 * posible, 100) y SIEMPRE queda acotado al mismo rango ±10-15% que REQ-REV-003 ya
 * exige para cualquier cambio de tarifa mientras el motor de revenue está en modo
 * "propone" (`PROPONE_VARIATION_PCT_MIN`/`MAX`, `revenueEngineGate.ts`) -- este módulo
 * nunca sugiere un número que el propio motor de revenue rechazaría por exceder ese
 * límite de gobierno ya establecido. Este módulo produce solo la RECOMENDACIÓN; la
 * ejecución real de un ajuste de tarifa sigue pasando por
 * `evaluateRevenueProposal()`/la cola de aprobación humana (REQ-REV-003/REQ-UX-006) --
 * "recomendar" (este REQ) nunca es lo mismo que "aplicar".
 */
export function recomendarAjusteBar(cruce: CruceUmbralResult, umbral: number): RecomendacionAjusteBar | null {
  if (!cruce.cruzo || cruce.fechaCruce == null || cruce.indiceAntesDeCruce == null || cruce.indiceActual == null) {
    return null;
  }

  const margenDisponible = REPUTATION_INDEX_MAX - umbral;
  const elevacion = cruce.indiceActual - umbral;
  const proporcion = margenDisponible > 0 ? clamp01(elevacion / margenDisponible) : 1;
  const rango = PROPONE_VARIATION_PCT_MAX - PROPONE_VARIATION_PCT_MIN;
  const ajustePorcentaje = Math.round((PROPONE_VARIATION_PCT_MIN + proporcion * rango) * 10) / 10;

  return {
    ajustePorcentaje,
    fechaCruce: cruce.fechaCruce,
    indiceAntesDeCruce: cruce.indiceAntesDeCruce,
    indiceActual: cruce.indiceActual,
    umbral,
    razon:
      `El índice de reputación subió de ${cruce.indiceAntesDeCruce.toFixed(1)} a ${cruce.indiceActual.toFixed(1)} ` +
      `(umbral configurado: ${umbral}) el ${cruce.fechaCruce.toISOString().slice(0, 10)} -- se recomienda subir el BAR ` +
      `${ajustePorcentaje}%, dentro del límite de variación de REQ-REV-003.`,
  };
}
