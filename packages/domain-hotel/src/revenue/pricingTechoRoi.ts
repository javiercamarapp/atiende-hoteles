// REQ-REV-019 (P2/GOB, fuentes BP-149, H17-004, H17-005): "techo de precio de venta ≤20-30%
// del valor conservador deduplicado, con descuentos por tamaño/ADR, y un factor de
// deduplicación cuando dos o más agentes con valor solapado se activan juntos".
//
// Por qué existe este módulo: H17 modela 16 agentes con una fórmula de valor propia cada
// uno; cuando un hotel activa varios agentes cuyo valor se solapa (ej. voz+WhatsApp+directo
// capturan en parte la MISMA reserva que antes se perdía; RM+reputación+CRM influyen en la
// MISMA tarifa realizada), sumar sus valores "brutos" sin ajuste infla el ROI mostrado al
// dueño y, con él, el precio máximo que la regla dura permite cobrar (BP-149: "regla dura:
// precio ≤30% del valor conservador"). Esta es la MISMA regla de gobierno que
// `roiBaseline.ts` aplica a la activación del cobro por resultado (REQ-REV-018) y que
// `revenueEngineGate.ts` aplica a la promoción del motor de tarifas: una autoridad de
// negocio explícita, pura y auditable, para que nadie -- ni el vendedor, ni un LLM
// generando una cotización -- pueda proponer un precio que el hotel no puede justificar
// contra su propio valor conservador. `packages/db` NO tiene una tabla equivalente porque
// REQ-REV-019 se declara "unit" en docs/ACEPTACION.md (sin dependencia de credenciales ni
// de I/O) -- el precio de lista de cada plan (BP-149: "Vende"/"Opera") se calibra a mano
// contra esta función, no se recalcula en producción por transacción.
//
// docs/ARQUITECTURA.md §"Cifra de ROI de la suite sin reconciliar": el "valor conservador"
// de entrada a este módulo es la cifra del catálogo H17 (escenario conservador, ya deflactado
// del bruto/optimista), NUNCA la cifra de mercadeo de "10 palancas" del blueprint -- ese
// deflactado ocurre AGUAS ARRIBA de este módulo (calculadora de ROI, REQ-REV-018/H17-001..003)
// y no se reimplementa aquí.

export class PricingTechoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingTechoError";
  }
}

/** H17-004: el techo nunca puede superar el 30% del valor conservador deduplicado --
 *  "regla dura" (BP-149) antes de aplicar ningún descuento. */
export const TECHO_FRACCION_MAXIMA = 0.3;

/** H17-004 ("techo ≤20-30%"): piso documentado de la banda -- los descuentos por
 *  tamaño/ADR abaratan el techo relativo a medida que el hotel es más grande o más
 *  económico, pero nunca lo empujan por debajo de este piso (evita que un hotel muy
 *  grande y de ADR muy bajo termine con un techo % ridículamente pequeño que no cubre
 *  ni el costo de servirlo). */
export const TECHO_FRACCION_PISO = 0.2;

/** H17-004: descuento de tamaño -- hoteles grandes concentran más valor absoluto por
 *  habitación adicional, así que el % techo baja para que el precio en pesos no crezca
 *  linealmente con el tamaño. */
export const DESCUENTO_TAMANO_FACTOR = 0.6;
export const DESCUENTO_TAMANO_UMBRAL_HABITACIONES = 80;

/** H17-004: descuento de ADR bajo -- un hotel económico tiene menor capacidad de pago en
 *  términos absolutos aunque el % de valor capturado sea el mismo. */
export const DESCUENTO_ADR_FACTOR = 0.85;
export const DESCUENTO_ADR_UMBRAL_MXN = 2500;

/** H17-005: factor de deduplicación default cuando ≥2 agentes de un mismo grupo de
 *  solapamiento se activan juntos (ejemplos de H17: voz+WhatsApp+directo;
 *  RM+reputación+CRM). */
export const FACTOR_DEDUPLICACION_DEFAULT = 0.75;

/** Un agente vendible con su valor conservador mensual y, opcionalmente, el grupo de
 *  agentes con los que solapa valor. Dos agentes solo se consideran "solapados" si
 *  comparten el mismo `grupoSolapamiento` -- un agente sin grupo (`undefined`) nunca se
 *  deduplica contra nadie. */
export interface AgenteValorConservador {
  readonly nombre: string;
  /** Valor conservador mensual en MXN, YA en escenario conservador (deflactado aguas
   *  arriba por la calculadora de ROI) -- este módulo no vuelve a aplicar ningún factor
   *  de escenario, solo el de deduplicación por solapamiento. */
  readonly valorConservadorMensualMxn: number;
  readonly grupoSolapamiento?: string;
}

export interface ParametrosHotelPricing {
  readonly numHabitaciones: number;
  readonly adrPromedioMxn: number;
}

function assertAgentesValidos(agentes: readonly AgenteValorConservador[]): void {
  for (const agente of agentes) {
    if (!Number.isFinite(agente.valorConservadorMensualMxn) || agente.valorConservadorMensualMxn < 0) {
      throw new PricingTechoError(
        `valor_conservador_invalido: el agente "${agente.nombre}" tiene un valorConservadorMensualMxn inválido (${agente.valorConservadorMensualMxn}); debe ser un número >= 0`,
      );
    }
  }
  const nombres = new Set<string>();
  for (const agente of agentes) {
    if (nombres.has(agente.nombre)) {
      throw new PricingTechoError(
        `agente_duplicado: "${agente.nombre}" aparece más de una vez en la lista de agentes activos -- cada agente activo se declara una sola vez`,
      );
    }
    nombres.add(agente.nombre);
  }
}

/**
 * H17-005: suma el valor conservador de los agentes activos, aplicando `factorDeduplicacion`
 * al subtotal de cada grupo de solapamiento que tenga 2 o más agentes activos (el "valor
 * bruto sumado de agentes solapados se ajusta ... antes de mostrarse al cliente"). Un
 * grupo con un solo agente activo, o un agente sin `grupoSolapamiento`, no se deduplica:
 * conserva su valor completo. Determinista y sin I/O -- no lanza salvo entrada inválida
 * (valor negativo/NaN o agente repetido).
 */
export function calcularValorConservadorDeduplicado(
  agentesActivos: readonly AgenteValorConservador[],
  factorDeduplicacion: number = FACTOR_DEDUPLICACION_DEFAULT,
): number {
  assertAgentesValidos(agentesActivos);
  if (!Number.isFinite(factorDeduplicacion) || factorDeduplicacion <= 0 || factorDeduplicacion > 1) {
    throw new PricingTechoError(
      `factor_deduplicacion_invalido: debe ser un número en (0, 1] (recibido ${factorDeduplicacion}) -- un factor > 1 aumentaría el valor en vez de deduplicarlo`,
    );
  }

  const sinGrupo: AgenteValorConservador[] = [];
  const porGrupo = new Map<string, AgenteValorConservador[]>();
  for (const agente of agentesActivos) {
    if (!agente.grupoSolapamiento) {
      sinGrupo.push(agente);
      continue;
    }
    const grupo = porGrupo.get(agente.grupoSolapamiento) ?? [];
    grupo.push(agente);
    porGrupo.set(agente.grupoSolapamiento, grupo);
  }

  let total = sinGrupo.reduce((acc, a) => acc + a.valorConservadorMensualMxn, 0);
  for (const grupo of porGrupo.values()) {
    const subtotal = grupo.reduce((acc, a) => acc + a.valorConservadorMensualMxn, 0);
    // Solo se deduplica cuando ≥2 agentes del MISMO grupo están activos a la vez
    // (H17-005: "cuando dos o más agentes con solapamiento de valor se activan juntos").
    total += grupo.length >= 2 ? subtotal * factorDeduplicacion : subtotal;
  }
  return total;
}

/**
 * H17-004: fracción del valor conservador deduplicado que el precio de venta NUNCA puede
 * superar, después de aplicar los descuentos por tamaño (>80 habitaciones ×0.6) y por ADR
 * bajo (<MXN 2,500 ×0.85), siempre acotada a la banda [`TECHO_FRACCION_PISO`,
 * `TECHO_FRACCION_MAXIMA`] = [20%, 30%] documentada en REQ-REV-019/H17-004. Ambos
 * descuentos son independientes y se componen multiplicativamente (un hotel grande Y de
 * ADR bajo recibe los dos, no el mayor de los dos).
 */
export function calcularFraccionTecho(params: ParametrosHotelPricing): number {
  if (!Number.isFinite(params.numHabitaciones) || params.numHabitaciones <= 0) {
    throw new PricingTechoError(
      `num_habitaciones_invalido: debe ser un número positivo (recibido ${params.numHabitaciones})`,
    );
  }
  if (!Number.isFinite(params.adrPromedioMxn) || params.adrPromedioMxn <= 0) {
    throw new PricingTechoError(
      `adr_promedio_invalido: debe ser un número positivo (recibido ${params.adrPromedioMxn})`,
    );
  }

  let fraccion = TECHO_FRACCION_MAXIMA;
  if (params.numHabitaciones > DESCUENTO_TAMANO_UMBRAL_HABITACIONES) {
    fraccion *= DESCUENTO_TAMANO_FACTOR;
  }
  if (params.adrPromedioMxn < DESCUENTO_ADR_UMBRAL_MXN) {
    fraccion *= DESCUENTO_ADR_FACTOR;
  }
  return Math.min(TECHO_FRACCION_MAXIMA, Math.max(TECHO_FRACCION_PISO, fraccion));
}

/**
 * Precio de venta MÁXIMO permitido (MXN/mes) para un hotel con `params`, dado el valor
 * conservador YA deduplicado (ver `calcularValorConservadorDeduplicado`). Compone
 * H17-004 (fracción techo) con el valor conservador deduplicado -- esta es la cifra
 * contra la que se calibra el precio de lista de cada plan (BP-149).
 */
export function calcularPrecioTechoMxn(
  valorConservadorDeduplicadoMxn: number,
  params: ParametrosHotelPricing,
): number {
  if (!Number.isFinite(valorConservadorDeduplicadoMxn) || valorConservadorDeduplicadoMxn < 0) {
    throw new PricingTechoError(
      `valor_conservador_deduplicado_invalido: debe ser un número >= 0 (recibido ${valorConservadorDeduplicadoMxn})`,
    );
  }
  return valorConservadorDeduplicadoMxn * calcularFraccionTecho(params);
}

export interface EvaluacionPrecioVenta {
  readonly allowed: boolean;
  /** Vacío cuando `allowed` es `true`. Cada razón es un código estable (prefijo antes de
   *  ":") seguido de una explicación en español -- mismo formato que
   *  `GateTransitionEvaluation` de revenueEngineGate.ts y `CobroPorResultadoActivationCheck`
   *  de roiBaseline.ts. */
  readonly reasons: readonly string[];
  readonly valorConservadorDeduplicadoMxn: number;
  readonly fraccionTechoAplicada: number;
  readonly precioTechoMxn: number;
}

/**
 * Evalúa si `precioPropuestoMxn` (lo que un vendedor, una cotización automática, o un
 * agente de ventas está a punto de ofrecer) respeta la regla dura de REQ-REV-019/BP-149
 * dado el conjunto de agentes activos y los parámetros del hotel. Nunca lanza por un
 * precio que exceda el techo -- devuelve la razón para que quien llama la muestre (mismo
 * criterio que `evaluateGateTransition`/`evaluateCobroPorResultadoActivation`); SÍ lanza
 * (`PricingTechoError`) ante datos de entrada inválidos, porque ahí no hay una "razón de
 * negocio" que mostrar, hay un bug de quien llama.
 */
export function evaluarPrecioVentaPropuesto(
  precioPropuestoMxn: number,
  agentesActivos: readonly AgenteValorConservador[],
  params: ParametrosHotelPricing,
  factorDeduplicacion: number = FACTOR_DEDUPLICACION_DEFAULT,
): EvaluacionPrecioVenta {
  if (!Number.isFinite(precioPropuestoMxn) || precioPropuestoMxn < 0) {
    throw new PricingTechoError(
      `precio_propuesto_invalido: debe ser un número >= 0 (recibido ${precioPropuestoMxn})`,
    );
  }

  const valorConservadorDeduplicadoMxn = calcularValorConservadorDeduplicado(agentesActivos, factorDeduplicacion);
  const fraccionTechoAplicada = calcularFraccionTecho(params);
  const precioTechoMxn = valorConservadorDeduplicadoMxn * fraccionTechoAplicada;

  // Épsilon para tolerar error de punto flotante en la frontera exacta, mismo patrón que
  // `isPriceChangeWithinProponeLimit` de revenueEngineGate.ts.
  const allowed = precioPropuestoMxn <= precioTechoMxn + 1e-6;

  return {
    allowed,
    reasons: allowed
      ? []
      : [
          `precio_excede_techo: el precio propuesto (MXN ${precioPropuestoMxn.toFixed(2)}) supera el techo de REQ-REV-019 (MXN ${precioTechoMxn.toFixed(2)} = ${(fraccionTechoAplicada * 100).toFixed(1)}% del valor conservador deduplicado de MXN ${valorConservadorDeduplicadoMxn.toFixed(2)})`,
        ],
    valorConservadorDeduplicadoMxn,
    fraccionTechoAplicada,
    precioTechoMxn,
  };
}
