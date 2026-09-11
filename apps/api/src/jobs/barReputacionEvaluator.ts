// REQ-REV-017 (P2/F): capa de I/O que conecta la lectura REAL de `guest_review`
// (0097, poblada por `routes/reputacion.ts`/REQ-CRM-002) con el cálculo puro de
// `packages/domain-hotel/src/revenue/barPorReputacion.ts` (`detectarCruceDeUmbral` +
// `recomendarAjusteBar`) y persiste la recomendación de forma idempotente vía
// `record_bar_reputation_recommendation()` (0130) -- mismo patrón de capas exacto que
// `jobs/ticketEscalation.ts` (puro respecto al reloj, SIEMPRE recibe `now` como
// parámetro, nunca `Date.now()` interno ni el `now()` de Postgres para la ventana de
// evaluación) frente a `jobs/ticketEscalationScheduler.ts`.
import type { DbClient } from "@atiende-hoteles/db";
import {
  DEFAULT_BAR_REPUTATION_THRESHOLD,
  DEFAULT_BAR_REPUTATION_WINDOW_DAYS,
  detectarCruceDeUmbral,
  recomendarAjusteBar,
  sentimentScoreToIndice,
  type IndiceReputacionPunto,
  type RecomendacionAjusteBar,
} from "@atiende-hoteles/domain-hotel";

export interface EvaluateBarReputationParams {
  hotelId: string;
  tenantId: string;
}

export interface EvaluateBarReputationOptions {
  /** Reloj inyectable para pruebas deterministas -- default la hora real. Nunca se lee
   *  `Date.now()` en ningún otro punto de este módulo. */
  now?: () => Date;
  /** Umbral del índice de reputación (0..100) -- default `DEFAULT_BAR_REPUTATION_THRESHOLD`. */
  umbral?: number;
  /** Ventana de evaluación en días -- default `DEFAULT_BAR_REPUTATION_WINDOW_DAYS`. */
  ventanaDias?: number;
}

export interface EvaluateBarReputationResult {
  hotelId: string;
  /** `null` cuando no hubo suficientes datos en la ventana para evaluar un cruce
   *  (0 o 1 día con reseñas) -- distinto de "evaluado, sin cruce". */
  puntosEnVentana: number;
  recomendacion: RecomendacionAjusteBar | null;
  /** `true` solo si `recomendacion` no es `null` Y la fila se insertó de verdad (no
   *  existía ya una recomendación para el mismo `hotelId`+`fechaCruce`) -- mismo
   *  criterio `is_new` que `record_fraud_alert()`. */
  isNew: boolean;
  recommendationId: string | null;
}

interface DailyAvgRow {
  fecha: string; // date (YYYY-MM-DD) tal como lo serializa pg para una columna `date`.
  avg_sentiment_score: string; // numeric -> string, mismo patrón que sentiment_score en routes/reputacion.ts.
}

/**
 * Lee `guest_review.sentiment_score` de `hotelId` agrupado por día dentro de
 * `[ahora - ventanaDias, ahora]`, arma la serie de índice de reputación (promedio
 * diario remapeado a 0..100 vía `sentimentScoreToIndice`, ORDENADA ascendente por
 * fecha -- contrato exacto que exige `detectarCruceDeUmbral`), evalúa si hubo un
 * cruce de umbral y, si lo hubo, persiste la recomendación de forma idempotente.
 *
 * Es correcto (y esperado) llamar esta función muchas veces para el mismo hotel
 * mientras el índice sigue sobre el umbral -- la idempotencia real vive en la base
 * de datos (`bar_reputation_recommendation_hotel_cruce_idx` + `on conflict do
 * nothing` dentro de `record_bar_reputation_recommendation()`), no en este módulo.
 */
export async function evaluarAjusteBarPorReputacion(
  db: DbClient,
  params: EvaluateBarReputationParams,
  opts: EvaluateBarReputationOptions = {},
): Promise<EvaluateBarReputationResult> {
  const now = (opts.now ?? (() => new Date()))();
  const umbral = opts.umbral ?? DEFAULT_BAR_REPUTATION_THRESHOLD;
  const ventanaDias = opts.ventanaDias ?? DEFAULT_BAR_REPUTATION_WINDOW_DAYS;
  const desde = new Date(now.getTime() - ventanaDias * 24 * 60 * 60 * 1000);

  const { rows } = await db.query<DailyAvgRow>(
    `select (date_trunc('day', created_at) at time zone 'utc')::date::text as fecha,
            avg(sentiment_score)::numeric::text as avg_sentiment_score
     from public.guest_review
     where hotel_id = $1 and created_at >= $2 and created_at <= $3
     group by 1
     order by 1 asc;`,
    [params.hotelId, desde.toISOString(), now.toISOString()],
  );

  const puntos: IndiceReputacionPunto[] = rows.map((r) => ({
    fecha: new Date(`${r.fecha}T00:00:00.000Z`),
    valor: sentimentScoreToIndice(Number(r.avg_sentiment_score)),
  }));

  const cruce = detectarCruceDeUmbral(puntos, umbral, ventanaDias, now);
  const recomendacion = recomendarAjusteBar(cruce, umbral);

  if (recomendacion == null) {
    return { hotelId: params.hotelId, puntosEnVentana: puntos.length, recomendacion: null, isNew: false, recommendationId: null };
  }

  const { rows: insertRows } = await db.query<{ id: string; is_new: boolean }>(
    `select id, is_new from public.record_bar_reputation_recommendation($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
    [
      params.tenantId,
      params.hotelId,
      umbral,
      ventanaDias,
      recomendacion.fechaCruce.toISOString().slice(0, 10),
      recomendacion.indiceAntesDeCruce,
      recomendacion.indiceActual,
      recomendacion.ajustePorcentaje,
      recomendacion.razon,
    ],
  );
  const inserted = insertRows[0]!;

  return {
    hotelId: params.hotelId,
    puntosEnVentana: puntos.length,
    recomendacion,
    isNew: inserted.is_new,
    recommendationId: inserted.id,
  };
}
