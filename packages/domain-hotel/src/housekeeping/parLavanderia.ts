// REQ-HK-007 (P2/F): el sistema debe calcular DIARIAMENTE los kg de lavandería esperados
// para el día siguiente y el PAR efectivo de blancos limpios, alertando si el PAR cae bajo
// 1.2x la necesidad proyectada o si la lavandería externa retrasa la entrega.
//
// Cruce puro (sin I/O), mismo criterio que `turnos-lft.ts` (REQ-HK-008): este módulo NO lee
// el pronóstico de ocupación del PMS ni el inventario real de blancos -- eso ya existe en
// otra parte del sistema (mirror de solo lectura del PMS + conteo de inventario) y lo pasa
// el llamador. Aquí solo vive la ARITMÉTICA y el UMBRAL de alerta, para que sean auditables
// y probables con un dataset fijo (mismo espíritu que `pickupForecast.ts`: no inventa el
// dato que falta, solo lo combina).
//
// Por qué "PAR" y no simplemente "inventario": en housekeeping/lavandería de hotelería el
// PAR es el múltiplo del consumo diario que se mantiene en circulación para cubrir el ciclo
// completo de lavado+secado+doblado+entrega (mientras un juego está sucio/en tránsito con la
// lavandería, otro debe estar limpio y disponible). El criterio de aceptación pide alertar
// cuando el PAR EFECTIVO (blancos limpios y disponibles HOY) cae bajo 1.2x la necesidad
// proyectada de MAÑANA -- ese 20% de colchón es, deliberadamente, un PARÁMETRO
// (`umbralParMinimo`, default 1.2) y no una constante enterrada en la fórmula, por si un
// hotel con lavandería propia (ciclo más corto) necesita un colchón distinto al de un hotel
// que depende de lavandería externa (ciclo más largo y con riesgo de retraso de entrega).
//
// Por qué se generan DOS motivos de alerta independientes (PAR bajo y entrega retrasada) en
// vez de uno solo: son señales distintas para el gerente -- un PAR bajo con entrega a tiempo
// es un problema de VOLUMEN (faltan blancos comprados); una entrega retrasada con PAR
// suficiente hoy es un problema de PROVEEDOR que se va a convertir en problema de volumen
// mañana si no se resuelve. Reportar ambas por separado (en vez de colapsarlas en un solo
// booleano "alerta") es lo que permite al gerente saber A QUIÉN llamar.

/** Pronóstico de rotación de habitaciones para el día siguiente -- ya calculado a partir
 *  de las salidas/estancias reales del PMS (mismo pronóstico que ya usa REQ-HK-001), NUNCA
 *  inventado aquí. */
export interface RoomTurnoverForecast {
  /** Habitaciones con salida (checkout) el día siguiente: requieren cambio COMPLETO de
   *  blancos (sábanas, fundas, toallas de baño y de playa si aplica). */
  checkoutRooms: number;
  /** Habitaciones que se quedan (stayover) el día siguiente: reposición PARCIAL salvo que
   *  el huésped no haya ejercido el opt-out de REQ-HK-005 (en cuyo caso pide cambio
   *  completo igual que un checkout). */
  stayoverRooms: number;
}

/** Consumo de blancos en kg por tipo de evento de limpieza -- PARÁMETRO por hotel (varía
 *  por categoría de habitación, gramaje de la tela y política de blancos), nunca una
 *  constante fija aquí. */
export interface LinenKgConfig {
  /** Kg de blancos sucios que genera UN checkout con cambio completo. */
  kgPerCheckoutRoom: number;
  /** Kg de blancos sucios que genera UN stayover con reposición PARCIAL (política eco:
   *  solo toallas de piso, sábanas se conservan). */
  kgPerStayoverPartialRoom: number;
  /** Fracción [0,1] de los stayovers que en la práctica reciben cambio COMPLETO (huésped
   *  que no ejerció el opt-out de REQ-HK-005, o que lo pidió explícitamente). Se pasa como
   *  parámetro -- calculado por el llamador a partir de la tasa histórica real de opt-out,
   *  nunca asumido en 0% ni en 100% aquí. */
  stayoverFullChangeRate: number;
}

function assertFraction(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${field} debe ser un número entre 0 y 1 (recibido: ${value})`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} debe ser un entero >= 0 (recibido: ${value})`);
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} debe ser un número >= 0 (recibido: ${value})`);
  }
}

/** Corazón de la mitad "kg esperados" de REQ-HK-007: kg de blancos sucios que HK debe
 *  entregar a lavandería mañana, a partir del pronóstico de rotación de habitaciones.
 *
 *  kg = checkoutRooms x kgPerCheckoutRoom
 *     + stayoverRooms x [ stayoverFullChangeRate x kgPerCheckoutRoom
 *                        + (1 - stayoverFullChangeRate) x kgPerStayoverPartialRoom ]
 *
 *  (un stayover con cambio completo consume lo mismo que un checkout -- mismo juego de
 *  blancos, mismo peso -- por eso reutiliza `kgPerCheckoutRoom` en vez de duplicar el
 *  parámetro). */
export function computeExpectedLaundryKg(forecast: RoomTurnoverForecast, config: LinenKgConfig): number {
  assertNonNegativeInteger(forecast.checkoutRooms, "forecast.checkoutRooms");
  assertNonNegativeInteger(forecast.stayoverRooms, "forecast.stayoverRooms");
  assertNonNegativeFinite(config.kgPerCheckoutRoom, "config.kgPerCheckoutRoom");
  assertNonNegativeFinite(config.kgPerStayoverPartialRoom, "config.kgPerStayoverPartialRoom");
  assertFraction(config.stayoverFullChangeRate, "config.stayoverFullChangeRate");

  const stayoverFullChangeRooms = forecast.stayoverRooms * config.stayoverFullChangeRate;
  const stayoverPartialRooms = forecast.stayoverRooms - stayoverFullChangeRooms;

  const kg =
    forecast.checkoutRooms * config.kgPerCheckoutRoom +
    stayoverFullChangeRooms * config.kgPerCheckoutRoom +
    stayoverPartialRooms * config.kgPerStayoverPartialRoom;

  // Redondeo a 2 decimales: kg es una magnitud física que se reporta al gerente y se
  // compara contra el pesaje real de lavandería -- evita arrastrar ruido de punto flotante
  // (mismo criterio de higiene numérica que `money.ts` usa para centavos).
  return Math.round(kg * 100) / 100;
}

/** Estado de la entrega prometida por la lavandería externa para el ciclo en curso.
 *  Ausente (`undefined` en `LinenParInput.entregaExterna`) cuando el hotel lava en sitio
 *  (sin proveedor externo que pueda "retrasarse"). */
export interface EntregaLavanderiaExterna {
  /** Fecha/hora ISO-8601 en que la lavandería prometió devolver el lote limpio. */
  fechaPrometida: string;
  /** Fecha/hora ISO-8601 en que de hecho se recibió el lote, o `null` si a `ahora` el
   *  lote todavía no ha llegado. */
  fechaRecibida: string | null;
  /** Instante de evaluación ("ahora"), ISO-8601. Se recibe como parámetro -- igual que
   *  `attendance.ts`/`consentLedger.ts` -- para que el módulo siga siendo puro y
   *  determinista (nunca llama `Date.now()` internamente). */
  ahora: string;
}

export interface LinenParInput {
  /** Necesidad proyectada de blancos LIMPIOS para el día siguiente, en kg -- normalmente
   *  el resultado de `computeExpectedLaundryKg`. */
  necesidadProyectadaKg: number;
  /** PAR efectivo: kg de blancos LIMPIOS y disponibles HOY (inventario ya contado, no
   *  incluye lo que sigue sucio o en tránsito con la lavandería). */
  parEfectivoKg: number;
  /** Multiplicador mínimo exigido sobre la necesidad proyectada (criterio de aceptación:
   *  1.2x) -- parámetro para no enterrar la cifra en la fórmula; default 1.2. */
  umbralParMinimo?: number;
  /** Estado de la entrega de la lavandería externa para este ciclo, si el hotel depende
   *  de una. Omitir cuando el hotel lava en sitio. */
  entregaExterna?: EntregaLavanderiaExterna;
}

export type MotivoAlertaLavanderia = "par_bajo_umbral" | "entrega_lavanderia_retrasada";

export interface LinenParEvaluation {
  necesidadProyectadaKg: number;
  parEfectivoKg: number;
  /** `necesidadProyectadaKg x umbralParMinimo` -- el piso que dispara la alerta. */
  umbralMinimoKg: number;
  /** `true` cuando `parEfectivoKg < umbralMinimoKg` (el criterio literal de REQ-HK-007). */
  parBajoUmbral: boolean;
  /** `true` cuando hay entrega externa configurada, aún no recibida, y `ahora` ya pasó
   *  `fechaPrometida`. */
  entregaRetrasada: boolean;
  /** `true` si CUALQUIERA de los dos motivos aplica (unión, no exclusión mutua: ambos
   *  pueden estar presentes a la vez). */
  alerta: boolean;
  /** Motivos que disparan `alerta`, en el orden en que se evaluaron. Vacío si `alerta` es
   *  `false`. */
  motivos: MotivoAlertaLavanderia[];
}

const DEFAULT_PAR_THRESHOLD_MULTIPLIER = 1.2;

/** Corazón de la mitad "PAR efectivo + alerta" de REQ-HK-007. Nunca lanza por un PAR bajo
 *  o una entrega retrasada -- esas son condiciones de NEGOCIO esperadas, no errores; solo
 *  lanza (`RangeError`) por datos estructuralmente inválidos, igual que `turnos-lft.ts`. */
export function evaluateLinenPar(input: LinenParInput): LinenParEvaluation {
  assertNonNegativeFinite(input.necesidadProyectadaKg, "necesidadProyectadaKg");
  assertNonNegativeFinite(input.parEfectivoKg, "parEfectivoKg");
  const umbralParMinimo = input.umbralParMinimo ?? DEFAULT_PAR_THRESHOLD_MULTIPLIER;
  if (!Number.isFinite(umbralParMinimo) || umbralParMinimo <= 0) {
    throw new RangeError(`umbralParMinimo debe ser un número > 0 (recibido: ${umbralParMinimo})`);
  }

  const umbralMinimoKg = Math.round(input.necesidadProyectadaKg * umbralParMinimo * 100) / 100;
  // Estrictamente "cae bajo" el umbral (criterio literal): igual al umbral NO alerta, solo
  // por debajo -- mismo criterio de frontera que `overbooking.ts` usa para `canBook`.
  const parBajoUmbral = input.parEfectivoKg < umbralMinimoKg;

  let entregaRetrasada = false;
  if (input.entregaExterna) {
    const { fechaPrometida, fechaRecibida, ahora } = input.entregaExterna;
    const prometidaMs = Date.parse(fechaPrometida);
    const ahoraMs = Date.parse(ahora);
    if (Number.isNaN(prometidaMs)) throw new RangeError(`entregaExterna.fechaPrometida inválida: "${fechaPrometida}"`);
    if (Number.isNaN(ahoraMs)) throw new RangeError(`entregaExterna.ahora inválida: "${ahora}"`);
    if (fechaRecibida !== null) {
      const recibidaMs = Date.parse(fechaRecibida);
      if (Number.isNaN(recibidaMs)) throw new RangeError(`entregaExterna.fechaRecibida inválida: "${fechaRecibida}"`);
    }
    // Retrasada = todavía no ha llegado (fechaRecibida null) Y ya se pasó la hora
    // prometida. Una entrega que llegó tarde pero YA llegó no sigue "retrasada" hacia
    // adelante -- ese hecho pasado se audita aparte, no bloquea la operación de hoy.
    entregaRetrasada = fechaRecibida === null && ahoraMs > prometidaMs;
  }

  const motivos: MotivoAlertaLavanderia[] = [];
  if (parBajoUmbral) motivos.push("par_bajo_umbral");
  if (entregaRetrasada) motivos.push("entrega_lavanderia_retrasada");

  return {
    necesidadProyectadaKg: input.necesidadProyectadaKg,
    parEfectivoKg: input.parEfectivoKg,
    umbralMinimoKg,
    parBajoUmbral,
    entregaRetrasada,
    alerta: motivos.length > 0,
    motivos,
  };
}

export interface CalculoDiarioLavanderiaInput {
  forecast: RoomTurnoverForecast;
  kgConfig: LinenKgConfig;
  parEfectivoKg: number;
  umbralParMinimo?: number;
  entregaExterna?: EntregaLavanderiaExterna;
}

export interface CalculoDiarioLavanderiaResult extends LinenParEvaluation {
  /** Alias explícito de `necesidadProyectadaKg` con el nombre del criterio de aceptación
   *  ("kg de lavandería esperados para el día siguiente"), para que el consumidor (job
   *  diario / reporte al gerente) no tenga que adivinar cuál de los dos kg es cuál. */
  kgLavanderiaEsperadosManana: number;
}

/** Punto de entrada único de REQ-HK-007: junta el cálculo de kg esperados y la evaluación
 *  de PAR efectivo en una sola llamada -- este es el que debe invocar el job diario (a las
 *  7:00, junto con la asignación de REQ-HK-001) y el reporte al gerente de REQ-HK-010. */
export function calcularLavanderiaDiaria(input: CalculoDiarioLavanderiaInput): CalculoDiarioLavanderiaResult {
  const kgLavanderiaEsperadosManana = computeExpectedLaundryKg(input.forecast, input.kgConfig);
  const evaluation = evaluateLinenPar({
    necesidadProyectadaKg: kgLavanderiaEsperadosManana,
    parEfectivoKg: input.parEfectivoKg,
    umbralParMinimo: input.umbralParMinimo,
    entregaExterna: input.entregaExterna,
  });
  return { ...evaluation, kgLavanderiaEsperadosManana };
}
