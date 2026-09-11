// REQ-REV-006 (P1/F, fuentes BP-087/H02-001/H05-003): "el sistema debe decidir/ejecutar
// el mix de canal (cerrar OTA en fechas de alta demanda, pausar campañas de metasearch
// al superar umbral de ocupación proyectada, subir puja) registrando la razón de cada
// decisión."
//
// Contexto de dominio: un hotel vende habitaciones por varios canales simultáneos --
// OTAs (Booking.com, Expedia, ...) que cobran comisión por reserva concretada, y
// metasearch (Google Hotel Ads, TripAdvisor, trivago, ...) que cobra POR CLIC/impresión
// aunque no convierta. Cuando la ocupación proyectada para una fecha ya es alta, seguir
// pagando por más demanda en esos canales es dinero perdido (ya no hay inventario que
// vender) o directamente riesgoso (una OTA sigue vendiendo el último cuarto que el
// canal directo ya tenía comprometido, riesgo de overbooking) -- de ahí "cerrar OTA" /
// "pausar metasearch" cuando la ocupación proyectada supera un umbral. A la inversa,
// cuando la ocupación proyectada es baja, el hotel SÍ quiere pagar más por demanda
// adicional en metasearch ("subir puja") para llenar cuartos que de otro modo
// quedarían vacíos.
//
// Este módulo es puro dominio/decisión -- mismo patrón que `parity-guard.ts`
// (`evaluateParityGuard`) y `revenueEngineGate.ts`: NO calcula la ocupación proyectada
// (eso lo hace el motor de pricing de REQ-REV-002, todavía `pendiente` en este repo --
// este módulo recibe el número ya calculado por quien llama) ni escribe/empuja nada a
// un canal real -- eso requeriría el conector/channel manager de REQ-REV-008..
// REQ-REV-011, que este repo deliberadamente NO construye en esta fase (mismo límite
// documentado en `atribucionCanal.ts` y `parity-guard.ts`). "Ejecutar" en el alcance de
// esta fase significa: decidir la acción y dejar registrada, como fuente de verdad
// interna del hotel, la nueva acción sobre el canal (cierre, pausa, alza de puja) --
// quien opere un channel manager real puede leer esa fuente de verdad y empujarla a la
// OTA/metasearch correspondiente; ese empuje en sí queda fuera de este módulo (la
// orquestación -- leer configuración/estado vigente, invocar este motor, persistir la
// decisión -- vive en `apps/api`, mismo criterio de capas que `parity-guard.ts`).
//
// Vocabulario: SOLO las 3 acciones que el propio texto del requisito nombra
// (cerrar_ota / pausar_metasearch / subir_puja) -- sin inventar acciones simétricas
// (reabrir OTA, reanudar metasearch, bajar puja) que el requisito no pide; quien
// ejecute este motor periódicamente ya recalcula sobre el estado vigente en cada
// corrida, así que un canal que deja de cumplir el umbral simplemente no vuelve a
// producir una nueva decisión de acción -- la AUSENCIA de decisión (no una acción
// inversa explícita) es cómo este motor comunica "ya no aplica, no hay nada que hacer".

export type ChannelType = "ota" | "metasearch";
export const CHANNEL_TYPES: readonly ChannelType[] = ["ota", "metasearch"];

export type ChannelMixAction = "cerrar_ota" | "pausar_metasearch" | "subir_puja";
export const CHANNEL_MIX_ACTIONS: readonly ChannelMixAction[] = ["cerrar_ota", "pausar_metasearch", "subir_puja"];

export class ChannelMixEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelMixEngineError";
  }
}

/**
 * Configuración vigente de UN canal de UN hotel -- "configurable por hotel", mismo
 * criterio que `ParityChannelConfig` de `parity-guard.ts`. Los campos que no aplican al
 * `channelType` del canal deben quedar `undefined` (la validación lo exige) para evitar
 * configuración fantasma que nunca se evalúa y podría confundir a quien la lea después.
 */
export interface ChannelMixChannelConfig {
  /** Identificador estable del canal, ej. "booking.com", "google_hotel_ads". Solo se
   *  usa para trazabilidad en `reason` -- este módulo no valida contra un catálogo
   *  cerrado de canales (mismo criterio que `ParityChannelConfig.channel`). */
  readonly channel: string;
  readonly channelType: ChannelType;
  /** Solo `channelType: "ota"`. Ocupación proyectada (%) a partir de la cual la fecha
   *  se considera de "alta demanda" y el canal debe cerrarse. Debe estar en (0, 100]. */
  readonly highDemandOccupancyThresholdPct?: number;
  /** Solo `channelType: "ota"`. Estado vigente del canal ANTES de esta evaluación. Si
   *  ya está cerrado (`false`), no se genera una nueva decisión aunque el umbral se
   *  siga cumpliendo -- una decisión por TRANSICIÓN de estado, no una por corrida. */
  readonly isOpen?: boolean;
  /** Solo `channelType: "metasearch"`. Ocupación proyectada (%) a partir de la cual se
   *  pausa la campaña (ya no hace falta pagar por más demanda). Debe estar en
   *  (0, 100]. */
  readonly pauseOccupancyThresholdPct?: number;
  /** Solo `channelType: "metasearch"`. Ocupación proyectada (%) por DEBAJO (o igual) de
   *  la cual se sube la puja (hace falta generar más demanda). Debe estar en [0, 100) y
   *  ser estrictamente menor que `pauseOccupancyThresholdPct` -- la banda de "subir
   *  puja" nunca puede solaparse con la de "pausar": un mismo nivel de ocupación no
   *  puede pedir dos acciones contradictorias a la vez. */
  readonly raiseBidOccupancyThresholdPct?: number;
  /** Solo `channelType: "metasearch"`. Cuánto sube la puja vigente, en % sobre la puja
   *  actual, cuando se dispara `subir_puja`. Debe ser > 0. */
  readonly bidRaisePct?: number;
  /** Solo `channelType: "metasearch"`. Estado vigente del canal ANTES de esta
   *  evaluación. `false` = ya pausado: no se genera ni `pausar_metasearch` (ya está en
   *  ese estado) ni `subir_puja` (no tiene sentido subir la puja de una campaña
   *  detenida). */
  readonly isActive?: boolean;
}

/** Una decisión concreta del motor para UN canal en UNA fecha de estadía. Nunca se
 *  produce una instancia con `reason` vacío -- el espejo de esquema
 *  (`0130_channel_mix_decision.sql`) lo exige además a nivel de base de datos, mismo
 *  criterio de "autoridad real es Postgres" que `revenue_engine_gate`. */
export interface ChannelMixDecision {
  readonly channel: string;
  readonly channelType: ChannelType;
  readonly action: ChannelMixAction;
  /** Fecha de estadía (YYYY-MM-DD) a la que aplica la decisión -- "fechas de alta
   *  demanda" del texto del requisito es siempre por fecha, nunca un cierre global del
   *  canal para todo el calendario. */
  readonly stayDate: string;
  readonly occupancyProjectedPct: number;
  /** Umbral configurado que esta decisión cruzó -- mismo campo que `deficitPct`/
   *  `floorRate` de `parity-guard.ts`: la evidencia de POR QUÉ se decidió, no solo el
   *  resultado. */
  readonly thresholdPct: number;
  /** Presente únicamente cuando `action === "subir_puja"`. */
  readonly bidRaisePct?: number;
  readonly reason: string;
}

const PCT_EPSILON = 1e-9;

function isFiniteNumberInRange(value: number, min: number, max: number, minInclusive: boolean, maxInclusive: boolean): boolean {
  if (!Number.isFinite(value)) return false;
  const aboveMin = minInclusive ? value >= min - PCT_EPSILON : value > min + PCT_EPSILON;
  const belowMax = maxInclusive ? value <= max + PCT_EPSILON : value < max - PCT_EPSILON;
  return aboveMin && belowMax;
}

const STAY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Valida una fecha de estadía en formato YYYY-MM-DD (mismo formato que `date` de
 *  Postgres) y que efectivamente sea un calendario válido (rechaza "2026-02-30"). */
export function assertValidStayDate(stayDate: string): void {
  if (!STAY_DATE_RE.test(stayDate)) {
    throw new ChannelMixEngineError(`fecha_invalida: stayDate debe tener formato YYYY-MM-DD, recibido "${stayDate}"`);
  }
  const [year, month, day] = stayDate.split("-").map(Number) as [number, number, number];
  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (asDate.getUTCFullYear() !== year || asDate.getUTCMonth() !== month - 1 || asDate.getUTCDate() !== day) {
    throw new ChannelMixEngineError(`fecha_invalida: "${stayDate}" no es una fecha de calendario válida`);
  }
}

/** Valida UN canal de la configuración -- lanza `ChannelMixEngineError` con un código
 *  estable (prefijo antes de ":") ante cualquier dato imposible de honrar, mismo
 *  criterio que `assertValidParityChannelConfig`. */
export function assertValidChannelMixChannelConfig(config: ChannelMixChannelConfig): void {
  if (!config.channel || config.channel.trim().length === 0) {
    throw new ChannelMixEngineError("canal_faltante: cada canal debe tener un nombre no vacío");
  }
  if (!CHANNEL_TYPES.includes(config.channelType)) {
    throw new ChannelMixEngineError(
      `tipo_canal_invalido: channelType debe ser uno de ${CHANNEL_TYPES.join(", ")}, recibido "${config.channelType}" para el canal "${config.channel}"`,
    );
  }

  if (config.channelType === "ota") {
    if (config.pauseOccupancyThresholdPct !== undefined || config.raiseBidOccupancyThresholdPct !== undefined || config.bidRaisePct !== undefined || config.isActive !== undefined) {
      throw new ChannelMixEngineError(
        `campos_metasearch_en_canal_ota: el canal "${config.channel}" es de tipo "ota" y no debe declarar pauseOccupancyThresholdPct/raiseBidOccupancyThresholdPct/bidRaisePct/isActive`,
      );
    }
    if (config.highDemandOccupancyThresholdPct === undefined || !isFiniteNumberInRange(config.highDemandOccupancyThresholdPct, 0, 100, false, true)) {
      throw new ChannelMixEngineError(
        `umbral_alta_demanda_invalido: highDemandOccupancyThresholdPct del canal "${config.channel}" debe estar en (0, 100], recibido ${config.highDemandOccupancyThresholdPct}`,
      );
    }
    if (typeof config.isOpen !== "boolean") {
      throw new ChannelMixEngineError(`estado_ota_faltante: el canal "${config.channel}" (ota) debe declarar isOpen (boolean)`);
    }
    return;
  }

  // channelType === "metasearch"
  if (config.highDemandOccupancyThresholdPct !== undefined || config.isOpen !== undefined) {
    throw new ChannelMixEngineError(
      `campos_ota_en_canal_metasearch: el canal "${config.channel}" es de tipo "metasearch" y no debe declarar highDemandOccupancyThresholdPct/isOpen`,
    );
  }
  if (config.pauseOccupancyThresholdPct === undefined || !isFiniteNumberInRange(config.pauseOccupancyThresholdPct, 0, 100, false, true)) {
    throw new ChannelMixEngineError(
      `umbral_pausa_invalido: pauseOccupancyThresholdPct del canal "${config.channel}" debe estar en (0, 100], recibido ${config.pauseOccupancyThresholdPct}`,
    );
  }
  if (config.raiseBidOccupancyThresholdPct === undefined || !isFiniteNumberInRange(config.raiseBidOccupancyThresholdPct, 0, 100, true, false)) {
    throw new ChannelMixEngineError(
      `umbral_puja_invalido: raiseBidOccupancyThresholdPct del canal "${config.channel}" debe estar en [0, 100), recibido ${config.raiseBidOccupancyThresholdPct}`,
    );
  }
  if (config.raiseBidOccupancyThresholdPct >= config.pauseOccupancyThresholdPct - PCT_EPSILON) {
    throw new ChannelMixEngineError(
      `bandas_solapadas: en el canal "${config.channel}" raiseBidOccupancyThresholdPct (${config.raiseBidOccupancyThresholdPct}) debe ser estrictamente menor que pauseOccupancyThresholdPct (${config.pauseOccupancyThresholdPct}) -- las bandas de "subir puja" y "pausar" no pueden solaparse`,
    );
  }
  if (config.bidRaisePct === undefined || !Number.isFinite(config.bidRaisePct) || config.bidRaisePct <= 0) {
    throw new ChannelMixEngineError(`alza_puja_invalida: bidRaisePct del canal "${config.channel}" debe ser un número positivo, recibido ${config.bidRaisePct}`);
  }
  if (typeof config.isActive !== "boolean") {
    throw new ChannelMixEngineError(`estado_metasearch_faltante: el canal "${config.channel}" (metasearch) debe declarar isActive (boolean)`);
  }
}

/**
 * Decide la acción (si aplica) para UN canal en UNA fecha de estadía con UNA ocupación
 * proyectada. Devuelve `null` cuando ninguna acción aplica -- ni porque ningún umbral
 * se cruzó, ni porque el canal ya está en el estado que la acción produciría (evita
 * decisiones redundantes, ver doc de `isOpen`/`isActive` arriba).
 *
 * Nunca lanza por falta de acción aplicable (eso se reporta como `null`); sí lanza
 * `ChannelMixEngineError` si `config`, `stayDate` u `occupancyProjectedPct` son
 * inválidos -- un error de configuración no debe disfrazarse de "sin acción".
 */
export function evaluateChannelMixDecision(config: ChannelMixChannelConfig, stayDate: string, occupancyProjectedPct: number): ChannelMixDecision | null {
  assertValidChannelMixChannelConfig(config);
  assertValidStayDate(stayDate);
  if (!Number.isFinite(occupancyProjectedPct) || occupancyProjectedPct < 0 || occupancyProjectedPct > 100) {
    throw new ChannelMixEngineError(`ocupacion_invalida: occupancyProjectedPct debe estar en [0, 100], recibido ${occupancyProjectedPct}`);
  }

  if (config.channelType === "ota") {
    const threshold = config.highDemandOccupancyThresholdPct!;
    if (config.isOpen === true && occupancyProjectedPct >= threshold - PCT_EPSILON) {
      return {
        channel: config.channel,
        channelType: "ota",
        action: "cerrar_ota",
        stayDate,
        occupancyProjectedPct,
        thresholdPct: threshold,
        reason:
          `alta_demanda_proyectada:${config.channel}: la ocupación proyectada (${occupancyProjectedPct}%) para ${stayDate} alcanza o supera ` +
          `el umbral de alta demanda configurado (${threshold}%) -- se cierra el canal OTA "${config.channel}" para esa fecha, evitando seguir ` +
          `pagando comisión por inventario que ya no existe (y el riesgo de overbooking frente al canal directo).`,
      };
    }
    return null;
  }

  // channelType === "metasearch"
  const pauseThreshold = config.pauseOccupancyThresholdPct!;
  const raiseThreshold = config.raiseBidOccupancyThresholdPct!;
  if (config.isActive === true && occupancyProjectedPct >= pauseThreshold - PCT_EPSILON) {
    return {
      channel: config.channel,
      channelType: "metasearch",
      action: "pausar_metasearch",
      stayDate,
      occupancyProjectedPct,
      thresholdPct: pauseThreshold,
      reason:
        `ocupacion_saturada:${config.channel}: la ocupación proyectada (${occupancyProjectedPct}%) para ${stayDate} alcanza o supera el umbral ` +
        `de pausa configurado (${pauseThreshold}%) -- se pausa la campaña de metasearch "${config.channel}" para esa fecha, ya no hace falta ` +
        `pagar por generar más demanda.`,
    };
  }
  if (config.isActive === true && occupancyProjectedPct <= raiseThreshold + PCT_EPSILON) {
    const bidRaisePct = config.bidRaisePct!;
    return {
      channel: config.channel,
      channelType: "metasearch",
      action: "subir_puja",
      stayDate,
      occupancyProjectedPct,
      thresholdPct: raiseThreshold,
      bidRaisePct,
      reason:
        `demanda_insuficiente:${config.channel}: la ocupación proyectada (${occupancyProjectedPct}%) para ${stayDate} cae en o por debajo del ` +
        `umbral de puja configurado (${raiseThreshold}%) -- se sube la puja de la campaña de metasearch "${config.channel}" en ${bidRaisePct}% ` +
        `para esa fecha, para generar más demanda sobre cuartos que de otro modo quedarían vacíos.`,
    };
  }
  return null;
}

/**
 * Evalúa TODOS los canales configurados de un hotel para UNA fecha/ocupación proyectada
 * y devuelve solo las decisiones que sí aplican (filtra los `null`) -- la función que
 * de verdad usa quien orquesta la corrida periódica del motor (`apps/api`).
 */
export function evaluateChannelMix(channels: readonly ChannelMixChannelConfig[], stayDate: string, occupancyProjectedPct: number): ChannelMixDecision[] {
  const decisions: ChannelMixDecision[] = [];
  for (const channel of channels) {
    const decision = evaluateChannelMixDecision(channel, stayDate, occupancyProjectedPct);
    if (decision) decisions.push(decision);
  }
  return decisions;
}
