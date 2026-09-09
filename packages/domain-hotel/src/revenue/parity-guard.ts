// REQ-REV-007 (P1/GOB, fuentes BP-047/BP-156): "el sistema debe respetar la paridad
// contractual vigente con OTAs mediante un 'parity guard' configurable por hotel
// (bloquea/alerta si una tarifa propuesta rompe la paridad pactada)".
//
// Contexto de dominio: las OTAs (Booking.com, Expedia, ...) suelen exigir en su
// contrato de distribución que el hotel NO ofrezca en su canal directo (web propia,
// llamada, walk-in) una tarifa más barata que la publicada en esa OTA para la misma
// fecha/tipo de habitación — la llamada "cláusula de paridad de tarifas". El texto
// exacto de esa cláusula varía por contrato y por país (paridad estricta = 0% de
// margen permitido; paridad "narrow"/relajada = un margen pactado, ej. 3-5%, para
// tarifas cerradas de programas de lealtad); de ahí "configurable por hotel" en el
// requisito: este módulo NO asume un único porcentaje ni una única OTA, recibe la
// paridad pactada (referencia + tolerancia) como configuración por canal.
//
// Este módulo es puro dominio/decisión: NO consulta la tarifa vigente en cada OTA (eso
// requeriría el conector/channel manager de REQ-REV-008..REQ-REV-011, que este repo
// deliberadamente NO construye en esta fase) ni escribe nada — solo decide, dada una
// tarifa directa propuesta y las tarifas de referencia YA obtenidas por quien llama,
// si esa propuesta respeta la paridad pactada, y si por eso debe bloquearse o solo
// generar una alerta, según el modo configurado para el hotel. Mismo patrón de
// separación de capas que `revenueEngineGate.ts`: la decisión determinista vive aquí,
// la orquestación (leer tarifas OTA, persistir la alerta, notificar) vive en
// `apps/api`.
//
// "bloquea vs. alerta" (el propio texto del requisito) son los dos modos posibles:
// - "bloquea": una propuesta que rompe la paridad pactada en CUALQUIER canal
//   configurado no es elegible para ejecutarse (`allowed: false`).
// - "alerta": la propuesta sigue siendo elegible (`allowed: true`) pero el resultado
//   reporta igual las violaciones detectadas, para que quien llama decida notificar/
//   registrar sin impedir el cambio — un hotel puede preferir este modo mientras aún
//   no confía en la frescura de sus tarifas de referencia OTA.

export type ParityMode = "bloquea" | "alerta";

export const PARITY_MODES: readonly ParityMode[] = ["bloquea", "alerta"];

export class ParityGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParityGuardError";
  }
}

/**
 * Paridad pactada para UN canal (una OTA) de un hotel. Un hotel puede tener contratos
 * con varias OTAs y cada una puede tener una tolerancia distinta — por eso la
 * configuración es una lista de canales, nunca un único número global.
 */
export interface ParityChannelConfig {
  /** Identificador estable del canal, ej. "booking.com", "expedia". Solo se usa para
   *  trazabilidad en `reasons`/`violations` — este módulo no valida contra un catálogo
   *  cerrado de OTAs (evita acoplar domain-hotel al registro de conectores PMS). */
  readonly channel: string;
  /** Tarifa vigente en ese canal para la misma fecha/tipo de habitación, YA obtenida
   *  por quien llama (este módulo no la consulta). Debe ser > 0. */
  readonly referenceRate: number;
  /** Margen pactado en el contrato para ESTE canal, en % sobre `referenceRate`, por el
   *  que el canal directo puede ir por debajo sin romper la paridad. 0 = paridad
   *  estricta (ni un centavo por debajo). Debe estar en [0, 100). */
  readonly toleranceAllowedPct: number;
}

/**
 * Configuración de paridad completa de un hotel — "configurable por hotel" del
 * requisito: cada hotel decide su propio modo (bloquea/alerta) y declara los canales
 * con los que tiene cláusula de paridad vigente.
 */
export interface ParityGuardConfig {
  readonly hotelId: string;
  readonly mode: ParityMode;
  /** Lista vacía = el hotel no tiene ninguna cláusula de paridad vigente registrada
   *  todavía; `evaluateParityGuard` entonces permite cualquier tarifa (no hay nada que
   *  proteger) — evita que la ausencia de configuración se confunda con una violación. */
  readonly channels: readonly ParityChannelConfig[];
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Valida un único canal de la configuración. Lanza `ParityGuardError` con un código
 *  estable (prefijo antes de ":") ante cualquier dato imposible de honrar. */
export function assertValidParityChannelConfig(channel: ParityChannelConfig): void {
  if (!channel.channel || channel.channel.trim().length === 0) {
    throw new ParityGuardError("canal_faltante: cada canal de paridad debe tener un nombre no vacío");
  }
  if (!isPositiveFiniteNumber(channel.referenceRate)) {
    throw new ParityGuardError(
      `tarifa_referencia_invalida: la tarifa de referencia del canal "${channel.channel}" debe ser un número positivo, recibido ${channel.referenceRate}`,
    );
  }
  if (!Number.isFinite(channel.toleranceAllowedPct) || channel.toleranceAllowedPct < 0 || channel.toleranceAllowedPct >= 100) {
    throw new ParityGuardError(
      `tolerancia_invalida: la tolerancia pactada del canal "${channel.channel}" debe estar en [0, 100), recibido ${channel.toleranceAllowedPct}`,
    );
  }
}

/** Valida la configuración completa de un hotel: modo válido, cada canal individual
 *  válido (`assertValidParityChannelConfig`), y sin canales duplicados (un hotel no
 *  puede tener dos reglas distintas y potencialmente contradictorias para la misma
 *  OTA — si el contrato cambió, se reemplaza la fila, no se agrega otra). */
export function assertValidParityGuardConfig(config: ParityGuardConfig): void {
  if (!PARITY_MODES.includes(config.mode)) {
    throw new ParityGuardError(`modo_invalido: el modo de paridad debe ser uno de ${PARITY_MODES.join(", ")}, recibido "${config.mode}"`);
  }
  const seen = new Set<string>();
  for (const channel of config.channels) {
    assertValidParityChannelConfig(channel);
    const key = channel.channel.trim().toLowerCase();
    if (seen.has(key)) {
      throw new ParityGuardError(`canal_duplicado: el canal "${channel.channel}" está configurado más de una vez para el hotel "${config.hotelId}"`);
    }
    seen.add(key);
  }
}

/** Piso de tarifa directa que respeta la paridad pactada con un canal: la tarifa de
 *  referencia menos el margen tolerado. Una tarifa directa igual al piso (dentro de un
 *  épsilon de punto flotante) SÍ respeta la paridad — la tolerancia es inclusiva. */
export function computeParityFloor(referenceRate: number, toleranceAllowedPct: number): number {
  return referenceRate * (1 - toleranceAllowedPct / 100);
}

/** Detalle de una violación de paridad contra un canal concreto. */
export interface ParityChannelViolation {
  readonly channel: string;
  readonly referenceRate: number;
  readonly toleranceAllowedPct: number;
  /** `computeParityFloor(referenceRate, toleranceAllowedPct)` — la tarifa directa
   *  mínima que hubiera respetado la paridad pactada con este canal. */
  readonly floorRate: number;
  readonly proposedRate: number;
  /** Cuánto por debajo del piso cae la propuesta, en % del piso (siempre > 0 cuando la
   *  violación existe — útil para ordenar/priorizar violaciones al alertar). */
  readonly deficitPct: number;
}

export interface ParityCheckResult {
  readonly hotelId: string;
  readonly mode: ParityMode;
  readonly proposedRate: number;
  /** `false` únicamente cuando `mode === "bloquea"` y existe al menos una violación.
   *  En modo "alerta" siempre es `true` (nunca bloquea la ejecución) aunque
   *  `violations` no esté vacío — la propia razón de ser del modo "alerta". Con
   *  `channels` vacío (sin cláusula de paridad vigente) también es siempre `true`. */
  readonly allowed: boolean;
  /** Una entrada por cada canal cuya paridad pactada la propuesta rompe. Vacío cuando
   *  la propuesta respeta la paridad con todos los canales configurados. */
  readonly violations: readonly ParityChannelViolation[];
  /** Vacío cuando `violations` está vacío. Cada razón es un código estable seguido de
   *  una explicación en español, mismo estilo que `revenueEngineGate.ts`. */
  readonly reasons: readonly string[];
}

// Épsilon para tolerar error de punto flotante en la frontera exacta del piso (ej. una
// propuesta calculada como floor - 1e-12 por redondeo no debe leerse como violación).
const FLOOR_EPSILON = 1e-9;

/**
 * Evalúa si `proposedRate` (la tarifa directa que se propone fijar) respeta la
 * paridad pactada en `config` con CADA canal configurado — la paridad debe cumplirse
 * individualmente con cada OTA, no en promedio: una propuesta que respeta a Expedia
 * pero rompe con Booking.com sigue siendo una violación de paridad con Booking.com.
 *
 * Nunca lanza por violaciones de paridad (esas se reportan en el resultado); sí lanza
 * `ParityGuardError` si `config` o `proposedRate` son inválidos — un error de
 * configuración no debe disfrazarse de "sin violaciones".
 */
export function evaluateParityGuard(config: ParityGuardConfig, proposedRate: number): ParityCheckResult {
  assertValidParityGuardConfig(config);
  if (!isPositiveFiniteNumber(proposedRate)) {
    throw new ParityGuardError(`tarifa_propuesta_invalida: la tarifa propuesta debe ser un número positivo, recibido ${proposedRate}`);
  }

  const violations: ParityChannelViolation[] = [];
  for (const channel of config.channels) {
    const floorRate = computeParityFloor(channel.referenceRate, channel.toleranceAllowedPct);
    if (proposedRate < floorRate - FLOOR_EPSILON) {
      const deficitPct = ((floorRate - proposedRate) / floorRate) * 100;
      violations.push({
        channel: channel.channel,
        referenceRate: channel.referenceRate,
        toleranceAllowedPct: channel.toleranceAllowedPct,
        floorRate,
        proposedRate,
        deficitPct,
      });
    }
  }

  const reasons = violations.map(
    (v) =>
      `paridad_rota:${v.channel}: la tarifa propuesta (${v.proposedRate}) cae ${v.deficitPct.toFixed(2)}% por debajo del piso pactado ` +
      `(${v.floorRate.toFixed(2)} = referencia ${v.referenceRate} × (1 - ${v.toleranceAllowedPct}% de tolerancia)) para el canal "${v.channel}"`,
  );

  // "bloquea/alerta si una tarifa propuesta rompe la paridad pactada" (texto literal
  // del requisito): en "alerta" la propuesta sigue siendo elegible, solo se reportan
  // las violaciones para que quien llama decida notificar sin impedir el cambio.
  const allowed = config.mode === "alerta" || violations.length === 0;

  return { hotelId: config.hotelId, mode: config.mode, proposedRate, allowed, violations, reasons };
}
