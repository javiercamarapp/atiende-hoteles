// REQ-REV-005 (P1/F, fuentes BP-003/H02-002): "el agente de revenue debe poder explicar
// en lenguaje natural, en español, por qué recomienda un precio (pick-up, compset,
// evento, tipo de cambio) al consultarlo el dueño."
//
// Contexto de dominio: cuando el motor de revenue (REQ-REV-002/REQ-REV-003) propone una
// tarifa distinta de la vigente, el dueño puede preguntar "¿por qué este precio?" y la
// respuesta debe ser trazable a los factores concretos que la produjeron -- nunca una
// paráfrasis vaga tipo "el mercado lo pide".
//
// Este módulo es dominio puro determinista -- NUNCA usa un LLM para redactar la
// explicación. Mismo principio de honestidad que GOB-013/LLM-003 ("el LLM nunca debe
// calcular, redondear ni fijar un precio final por ninguna ruta de código",
// motor-precio-total.spec.ts) pero un paso más allá: tampoco delega la EXPLICACIÓN del
// precio a un LLM, para que la razón que el dueño lee sea siempre trazable a un número
// concreto que este módulo puede probar con datos fijos, nunca a una paráfrasis que un
// modelo podría inventar, omitir o exagerar. Si en el futuro un agente conversacional
// (agent-core) envuelve esta salida con un tono más natural, ese agente NARRA estos
// hechos ya calculados -- mismo patrón que `auditor_nocturno` narrando el night audit
// (REQ-REV-013) -- nunca los inventa.
//
// No consulta ningún feed externo: pick-up, compset, evento y tipo de cambio ya vienen
// calculados/obtenidos por quien llama -- mismo patrón de separación de capas que
// `parity-guard.ts` y `forecast/pickupForecast.ts`. Este módulo solo ordena los factores
// por relevancia (mayor magnitud primero, para que el dueño lea la razón principal
// primero) y los redacta en español con una plantilla fija por tipo de factor.

export class PriceExplanationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceExplanationError";
  }
}

export interface PickupFactor {
  readonly kind: "pickup";
  /** Reservas en libro vs. lo esperado por el pronóstico histórico (REQ-AGT-012,
   *  `forecastPickup`), en % -- positivo = pick-up por encima de lo esperado (empuja el
   *  precio al alza), negativo = por debajo (empuja a la baja). */
  readonly onTheBooksVsExpectedPct: number;
}

export interface CompsetFactor {
  readonly kind: "compset";
  /** Posición de la tarifa propia vs. la mediana del compset agregado (REQ-REV-004:
   *  exige k>=10 hoteles, >=12 meses de histórico -- este módulo no valida eso, solo
   *  redacta el resultado ya validado por `compsetGuard.ts`), en % -- positivo = tarifa
   *  propia por encima de la mediana del compset. */
  readonly ownRateVsMedianPct: number;
}

export interface EventoFactor {
  readonly kind: "evento";
  /** Nombre del evento (festival, congreso, temporada declarada, alerta de
   *  huracán/sargazo). Nunca vacío. */
  readonly nombre: string;
  readonly impacto: "alza_demanda" | "baja_demanda";
  /** Magnitud esperada del impacto en la demanda, en %. Siempre > 0 -- el signo del
   *  impacto lo da `impacto`, no el número. */
  readonly magnitudPct: number;
}

export interface TipoCambioFactor {
  readonly kind: "tipo_cambio";
  /** Código ISO de la divisa extranjera relevante, ej. "USD". */
  readonly moneda: string;
  /** Variación reciente del tipo de cambio, en % -- positivo = la divisa extranjera se
   *  fortaleció frente al peso (el turista internacional gana poder adquisitivo). */
  readonly variacionPct: number;
}

export type PriceFactor = PickupFactor | CompsetFactor | EventoFactor | TipoCambioFactor;
export type PriceFactorKind = PriceFactor["kind"];

const VALID_FACTOR_KINDS: readonly PriceFactorKind[] = ["pickup", "compset", "evento", "tipo_cambio"];

export interface PriceRecommendationInput {
  readonly hotelId: string;
  /** Fecha (noche) a la que aplica la recomendación, formato "YYYY-MM-DD". */
  readonly fecha: string;
  readonly currentPrice: number;
  readonly recommendedPrice: number;
  /** Código ISO de la moneda en la que se cotiza el hotel, ej. "MXN". */
  readonly currency: string;
  /** Al menos un factor -- una recomendación sin ningún factor detrás no es explicable
   *  y se rechaza en vez de inventar una razón genérica (mismo criterio de honestidad
   *  que el resto del módulo `revenue/`). Como mucho un factor de cada tipo: dos
   *  factores "pickup" simultáneos serían una contradicción sin forma de resolverse
   *  aquí (¿cuál es el vigente?) -- eso lo decide quien arma el input, no este módulo. */
  readonly factors: readonly PriceFactor[];
}

export interface ExplainedFactor {
  readonly kind: PriceFactorKind;
  readonly text: string;
  /** Magnitud absoluta usada para ordenar los factores de mayor a menor relevancia. */
  readonly magnitude: number;
}

export type PriceDirection = "sube" | "baja" | "sin_cambio";

export interface PriceRecommendationExplanation {
  readonly hotelId: string;
  readonly fecha: string;
  readonly direction: PriceDirection;
  /** % de cambio de `currentPrice` a `recommendedPrice` (positivo = sube). */
  readonly deltaPct: number;
  /** Un renglón, para vista compacta (ej. notificación de WhatsApp). */
  readonly headline: string;
  /** Un renglón por factor, de mayor a menor magnitud. Vacío nunca -- `factors` de
   *  entrada exige al menos uno. */
  readonly factors: readonly ExplainedFactor[];
  /** `headline` + cada texto de `factors`, en un solo párrafo, para la respuesta
   *  conversacional completa que el dueño lee. */
  readonly fullText: string;
}

// Épsilon para no reportar "sube"/"baja" por ruido de punto flotante cuando el precio
// prácticamente no cambió.
const DELTA_EPSILON_PCT = 1e-6;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmt(n: number): string {
  // Evita "-0" y arrastres de punto flotante en el texto que lee el dueño.
  const r = round1(n);
  return (r === 0 ? 0 : r).toString();
}

export function assertValidPriceRecommendationInput(input: PriceRecommendationInput): void {
  if (!input.hotelId || input.hotelId.trim().length === 0) {
    throw new PriceExplanationError("hotel_id_faltante: se requiere el id del hotel");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fecha)) {
    throw new PriceExplanationError(`fecha_invalida: se esperaba formato YYYY-MM-DD, recibido "${input.fecha}"`);
  }
  if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) {
    throw new PriceExplanationError(`precio_actual_invalido: debe ser un número positivo, recibido ${input.currentPrice}`);
  }
  if (!Number.isFinite(input.recommendedPrice) || input.recommendedPrice < 0) {
    throw new PriceExplanationError(`precio_recomendado_invalido: debe ser un número no negativo, recibido ${input.recommendedPrice}`);
  }
  if (!input.currency || input.currency.trim().length === 0) {
    throw new PriceExplanationError("moneda_faltante: se requiere el código de moneda");
  }
  if (input.factors.length === 0) {
    throw new PriceExplanationError(
      "sin_factores: una recomendación de precio debe venir con al menos un factor (pick-up, compset, evento o tipo de cambio) -- no se inventa una razón genérica",
    );
  }
  const seenKinds = new Set<PriceFactorKind>();
  for (const factor of input.factors) {
    if (!VALID_FACTOR_KINDS.includes(factor.kind)) {
      throw new PriceExplanationError(`tipo_factor_invalido: "${(factor as { kind: string }).kind}" no es un tipo de factor reconocido`);
    }
    if (seenKinds.has(factor.kind)) {
      throw new PriceExplanationError(`factor_duplicado: el tipo de factor "${factor.kind}" aparece más de una vez en la misma recomendación`);
    }
    seenKinds.add(factor.kind);

    switch (factor.kind) {
      case "pickup":
        if (!Number.isFinite(factor.onTheBooksVsExpectedPct)) {
          throw new PriceExplanationError("pickup_invalido: onTheBooksVsExpectedPct debe ser un número finito");
        }
        break;
      case "compset":
        if (!Number.isFinite(factor.ownRateVsMedianPct)) {
          throw new PriceExplanationError("compset_invalido: ownRateVsMedianPct debe ser un número finito");
        }
        break;
      case "evento":
        if (!factor.nombre || factor.nombre.trim().length === 0) {
          throw new PriceExplanationError("evento_sin_nombre: el factor de evento requiere un nombre no vacío");
        }
        if (factor.impacto !== "alza_demanda" && factor.impacto !== "baja_demanda") {
          throw new PriceExplanationError(`evento_impacto_invalido: "${factor.impacto}" no es "alza_demanda" ni "baja_demanda"`);
        }
        if (!Number.isFinite(factor.magnitudPct) || factor.magnitudPct <= 0) {
          throw new PriceExplanationError(`evento_magnitud_invalida: magnitudPct debe ser positivo, recibido ${factor.magnitudPct}`);
        }
        break;
      case "tipo_cambio":
        if (!factor.moneda || factor.moneda.trim().length === 0) {
          throw new PriceExplanationError("tipo_cambio_sin_moneda: el factor de tipo de cambio requiere un código de moneda");
        }
        if (!Number.isFinite(factor.variacionPct)) {
          throw new PriceExplanationError("tipo_cambio_invalido: variacionPct debe ser un número finito");
        }
        break;
    }
  }
}

function explainFactor(factor: PriceFactor): ExplainedFactor {
  switch (factor.kind) {
    case "pickup": {
      const pct = factor.onTheBooksVsExpectedPct;
      const dir = pct >= 0 ? "por encima" : "por debajo";
      return {
        kind: "pickup",
        magnitude: Math.abs(pct),
        text: `El pick-up (reservas ya en libro) está ${fmt(Math.abs(pct))}% ${dir} de lo esperado por el histórico para esta fecha.`,
      };
    }
    case "compset": {
      const pct = factor.ownRateVsMedianPct;
      const dir = pct >= 0 ? "por encima" : "por debajo";
      return {
        kind: "compset",
        magnitude: Math.abs(pct),
        text: `La tarifa propia está ${fmt(Math.abs(pct))}% ${dir} de la mediana del compset.`,
      };
    }
    case "evento": {
      const efecto = factor.impacto === "alza_demanda" ? "suele subir la demanda" : "suele bajar la demanda";
      return {
        kind: "evento",
        magnitude: factor.magnitudPct,
        text: `Hay un evento relevante ("${factor.nombre}") que ${efecto} en un ${fmt(factor.magnitudPct)}%.`,
      };
    }
    case "tipo_cambio": {
      const pct = factor.variacionPct;
      const dir = pct >= 0 ? "se fortaleció" : "se debilitó";
      return {
        kind: "tipo_cambio",
        magnitude: Math.abs(pct),
        text: `El ${factor.moneda} ${dir} ${fmt(Math.abs(pct))}% frente al peso en el periodo reciente.`,
      };
    }
  }
}

/**
 * Construye la explicación en español, en lenguaje natural, de por qué el motor de
 * revenue recomienda `recommendedPrice` en vez de `currentPrice` para `fecha`, a partir
 * de los factores YA calculados que recibe (pick-up, compset, evento, tipo de cambio).
 *
 * Determinista: la misma entrada siempre produce la misma salida (ordenamiento estable
 * por magnitud, texto fijo por plantilla) -- ningún llamado a un LLM ni a ningún feed
 * externo. Lanza `PriceExplanationError` si el input es inválido; nunca inventa un
 * factor ni una razón cuando faltan datos.
 */
export function explainPriceRecommendation(input: PriceRecommendationInput): PriceRecommendationExplanation {
  assertValidPriceRecommendationInput(input);

  const deltaPct = input.currentPrice === 0 ? 0 : ((input.recommendedPrice - input.currentPrice) / input.currentPrice) * 100;
  const direction: PriceDirection = deltaPct > DELTA_EPSILON_PCT ? "sube" : deltaPct < -DELTA_EPSILON_PCT ? "baja" : "sin_cambio";

  const explainedFactors = input.factors
    .map(explainFactor)
    // Orden estable de mayor a menor magnitud -- Array.prototype.sort es estable en los
    // motores JS modernos (ES2019+), así que factores con la misma magnitud conservan
    // el orden en que llegaron en `input.factors`.
    .sort((a, b) => b.magnitude - a.magnitude);

  const cambioTexto =
    direction === "sube"
      ? `sube ${fmt(Math.abs(deltaPct))}%`
      : direction === "baja"
        ? `baja ${fmt(Math.abs(deltaPct))}%`
        : "se mantiene sin cambio";

  const headline = `Para el ${input.fecha}, la tarifa recomendada ${cambioTexto} (de ${fmt(input.currentPrice)} a ${fmt(input.recommendedPrice)} ${input.currency}).`;

  const fullText = [headline, ...explainedFactors.map((f) => f.text)].join(" ");

  return {
    hotelId: input.hotelId,
    fecha: input.fecha,
    direction,
    deltaPct,
    headline,
    factors: explainedFactors,
    fullText,
  };
}
