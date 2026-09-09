// REQ-REV-018/REQ-GOB-016 (P0/OBS-GOB, BP-015/BP-131/BP-171/GOB-037): espejo PURO (sin
// acceso a BD, determinista) de la máquina de estados real que exige
// `packages/db/migrations/0120_roi_baseline_cobro_resultado.sql` -- mismo criterio que
// `revenue/revenueEngineGate.ts` frente a `0082_revenue_engine_gate.sql`: la autoridad
// final sobre si una línea base puede firmarse o si un cobro por resultado puede
// activarse es el trigger de Postgres (nadie puede saltarse esto escribiendo SQL a
// mano), este módulo permite validar/explicar la regla ANTES de un round-trip a la base
// y sirve de referencia única para cualquier UI/CLI que quiera mostrar por qué una
// activación está bloqueada.
//
// BP-015: "Cobro por resultado solo donde se puede medir ..., con línea base escrita en
// la semana 1" / "Sin línea base firmada por el dueño en la semana 1 no se activa ningún
// cobro por éxito." BP-131: "Cada agente debe reportar contra una línea base acordada
// por escrito en la semana 1; sin línea base no hay cobro por éxito ('medición
// honesta')."

/** BP-015/BP-131: "semana 1" = 7 días desde que el agente/módulo se activó para el
 *  hotel. Un solo lugar para este número -- si algún día cambia, cambia aquí y en el
 *  comentario espejo de la migración 0112, nunca en silencio en un solo lado. */
export const BASELINE_SIGNING_WINDOW_DAYS = 7;

export class RoiBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoiBaselineError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Días (con fracción, puede ser negativo) transcurridos de `from` a `to`. */
export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

/** ¿`firmadoEn` cae dentro de la ventana de "semana 1" contada desde `activadoEn`? Nunca
 *  antes de la activación (no se puede firmar un compromiso sobre algo que aún no
 *  arranca) ni más de `BASELINE_SIGNING_WINDOW_DAYS` después. */
export function isWithinWeek1(activadoEn: Date, firmadoEn: Date): boolean {
  const dias = daysBetween(activadoEn, firmadoEn);
  return dias >= 0 && dias <= BASELINE_SIGNING_WINDOW_DAYS;
}

/** Lanza `RoiBaselineError` con el mismo código estable que el trigger de Postgres
 *  (`firma_anterior_a_activacion` / `linea_base_fuera_de_semana_1`) si `firmadoEn` no
 *  cae dentro de la ventana de semana 1 contada desde `activadoEn`. */
export function assertBaselineSignableWithinWeek1(activadoEn: Date, firmadoEn: Date): void {
  const dias = daysBetween(activadoEn, firmadoEn);
  if (dias < 0) {
    throw new RoiBaselineError(
      `firma_anterior_a_activacion: la linea base no puede firmarse (${firmadoEn.toISOString()}) antes de que se activara (${activadoEn.toISOString()})`,
    );
  }
  if (dias > BASELINE_SIGNING_WINDOW_DAYS) {
    throw new RoiBaselineError(
      `linea_base_fuera_de_semana_1: la linea base debe firmarse dentro de los primeros ${BASELINE_SIGNING_WINDOW_DAYS} dias desde su activacion (REQ-REV-018/BP-015/BP-131), transcurrieron ${dias.toFixed(1)} dias`,
    );
  }
}

/** Forma mínima de una `roi_baseline` que necesita el gate de abajo -- deliberadamente
 *  no importa el tipo de fila completo de la tabla (packages/domain-hotel no depende de
 *  packages/db, mismo principio de separación de capas documentado en
 *  revenueEngineGate.ts). */
export interface RoiBaselineSummary {
  readonly hotelId: string;
  readonly agentName: string;
  readonly firmadoEn: Date | null;
}

export interface CobroPorResultadoActivationParams {
  readonly hotelId: string;
  readonly agentName: string;
}

export interface CobroPorResultadoActivationCheck {
  readonly allowed: boolean;
  /** Vacío cuando `allowed` es `true`. Cada razón es un código estable (prefijo antes de
   *  ":") seguido de una explicación en español -- mismo formato que
   *  `GateTransitionEvaluation` de revenueEngineGate.ts. */
  readonly reasons: readonly string[];
}

const ACTIVATION_ALLOWED: CobroPorResultadoActivationCheck = { allowed: true, reasons: [] };

/**
 * REQ-REV-018: "ningún cobro por resultado se activa sin línea base firmada." Evalúa si
 * activar un cobro por resultado para `params.hotelId`/`params.agentName` es elegible
 * dado el estado (posiblemente inexistente) de su línea base. Nunca lanza -- devuelve
 * las razones de bloqueo para que quien llama pueda mostrarlas, igual que
 * `evaluateGateTransition`.
 *
 * Nota deliberada: esta función NO verifica la aprobación del fundador para
 * `estructura_de_exito_compartido` (BP-150/GOB-052) -- esa es una condición
 * INDEPENDIENTE que solo la base de datos puede evaluar de verdad (requiere consultar
 * `founder_decision_approval`), igual que `evaluateGateTransition` tampoco valida el
 * catálogo cerrado de decisiones reservadas del fundador por sí solo. Este módulo cubre
 * únicamente la condición de línea base que es literal en REQ-REV-018.
 */
export function evaluateCobroPorResultadoActivation(
  baseline: RoiBaselineSummary | null,
  params: CobroPorResultadoActivationParams,
): CobroPorResultadoActivationCheck {
  if (!baseline) {
    return {
      allowed: false,
      reasons: [
        `linea_base_no_encontrada: no existe ninguna linea base registrada para el agente/modulo "${params.agentName}" en este hotel (REQ-REV-018)`,
      ],
    };
  }
  if (baseline.hotelId !== params.hotelId || baseline.agentName !== params.agentName) {
    return {
      allowed: false,
      reasons: [
        `linea_base_no_corresponde: la linea base disponible pertenece a otro hotel o a otro agente/modulo distinto de "${params.agentName}"`,
      ],
    };
  }
  if (!baseline.firmadoEn) {
    return {
      allowed: false,
      reasons: [
        `linea_base_no_firmada: existe una linea base en borrador para "${params.agentName}" pero aun no ha sido firmada (REQ-REV-018/BP-015/BP-131: "sin linea base firmada por el dueño en la semana 1 no se activa ningun cobro por exito")`,
      ],
    };
  }
  return ACTIVATION_ALLOWED;
}
