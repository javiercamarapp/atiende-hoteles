/**
 * REQ-HK-005 (P2/F): "El sistema debe registrar el opt-out de limpieza/reposición de
 * blancos con incentivo (sin culpar al huésped en el mensaje) y contar blancos/
 * amenidades por foto contra el consumo teórico, alertando desviaciones."
 * (docs/REQUISITOS.md; criterio literal en docs/ACEPTACION.md: "Opt-out de limpieza
 * registrado con mensaje sin culpar al huésped (verificado por texto del mensaje);
 * consumo de blancos/amenidades contado por foto contra consumo teórico, alertando
 * desviación sobre el umbral configurado.")
 *
 * Módulo de dominio PURO (mismo principio que `fnbAllergyGuard.ts`/`marketingTemplateLinter.ts`):
 * ninguna función de aquí toca I/O -- `apps/api/src/routes/housekeeping.ts` es quien
 * persiste el opt-out/conteo y decide cuándo invocar estas guardas antes de escribir o
 * responder.
 *
 * Dos responsabilidades independientes, ambas exigidas por el mismo REQ:
 *
 *   1. Guarda de mensaje (fail-closed): el criterio de aceptación exige poder VERIFICAR,
 *      por el texto exacto del mensaje que confirma el opt-out al huésped, que ese
 *      mensaje nunca lo culpa de nada (mismo espíritu que `OPT_OUT_PATTERNS` de
 *      `marketingTemplateLinter.ts`, pero exigiendo la AUSENCIA de un patrón en vez de
 *      su presencia). Un mensaje que culpa al huésped ("por tu culpa no se limpió",
 *      "te niegas a que limpiemos", "eres responsable de no recibir blancos limpios")
 *      nunca debe poder registrarse ni mostrarse -- `assertLinenOptOutMessageDoesNotBlameGuest`
 *      truena antes de que la ruta llegue al INSERT.
 *
 *   2. Cálculo de desviación de consumo (puro): dado un conteo verificado por foto y el
 *      consumo teórico esperado, calcula la desviación en unidades/porcentaje y si cruza
 *      el umbral configurado -- la misma función que decide si el reporte debe marcar
 *      "alerta" para housekeeping/gerencia.
 */

// Palabras/frases que atribuyen culpa o responsabilidad negativa al huésped por el
// opt-out -- deliberadamente amplio (mismo criterio fail-closed que
// `ALLERGY_KEYWORDS_RE` de `fnbAllergyGuard.ts`): un falso positivo aquí solo cuesta
// reescribir el mensaje de confirmación; un falso negativo deja salir un mensaje que
// culpa al huésped, justo lo que el REQ prohíbe explícitamente. Se aplica sobre texto
// sin acentos (ver `stripDiacritics`) por la misma razón que `fnbAllergyGuard.ts`: un
// huésped/staff escribiendo desde el teclado de un celular omite acentos con frecuencia.
const BLAME_PATTERNS_RE: readonly RegExp[] = [
  /\bpor\s+tu\s+culpa\b/i,
  /\bpor\s+su\s+culpa\b/i,
  /\btu\s+culpa\b/i,
  /\bsu\s+culpa\b/i,
  /\beres\s+responsable\s+de\b/i,
  /\bes\s+usted\s+responsable\s+de\b/i,
  /\bte\s+niegas\s+a\b/i,
  /\bse\s+niega\s+a\b/i,
  /\bno\s+quisiste\s+que\b/i,
  /\bno\s+quiso\s+que\b/i,
  /\begoista\b/i,
  /\bdesconsiderad[oa]\b/i,
  /\bdeberias\s+haber\b/i,
  /\bdebio\s+haber\b/i,
];

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** true si `text` PARECE culpar/responsabilizar negativamente al huésped. */
export function messageBlamesGuest(text: string): boolean {
  const normalized = stripDiacritics(text);
  return BLAME_PATTERNS_RE.some((re) => re.test(normalized));
}

export class LinenOptOutMessageBlamesGuestError extends Error {
  code = "housekeeping_opt_out_mensaje_culpa_huesped";
  constructor() {
    super(
      "El mensaje de confirmación del opt-out de limpieza no puede registrarse: culpa o " +
        "responsabiliza negativamente al huésped, lo que REQ-HK-005 prohíbe explícitamente. " +
        "Reescribe el mensaje sin atribuir culpa antes de registrar el opt-out.",
    );
    this.name = "LinenOptOutMessageBlamesGuestError";
  }
}

/** Guarda central, fail-closed: lanza `LinenOptOutMessageBlamesGuestError` si el texto
 *  culpa al huésped. Toda ruta que vaya a persistir/enviar un mensaje de confirmación de
 *  opt-out DEBE llamar esto primero -- si no truena, el mensaje es seguro de registrar. */
export function assertLinenOptOutMessageDoesNotBlameGuest(text: string): void {
  if (messageBlamesGuest(text)) throw new LinenOptOutMessageBlamesGuestError();
}

/** Genera el texto por defecto de confirmación del opt-out -- agradece al huésped,
 *  nunca lo culpa, y siempre menciona el incentivo ofrecido (el REQ exige registrar el
 *  opt-out "con incentivo"). Un mensaje personalizado sigue debiendo pasar
 *  `assertLinenOptOutMessageDoesNotBlameGuest`; este default existe para que la ruta
 *  tenga un texto seguro conocido cuando el staff no escribe uno propio. */
export function describeLinenOptOutConfirmationMessage(incentiveDescription: string): string {
  return (
    `¡Gracias por ayudarnos a cuidar el planeta! Registramos que hoy prefieres no recibir ` +
    `limpieza/cambio de blancos en tu habitación. Como agradecimiento, disfruta: ${incentiveDescription}.`
  );
}

export interface LinenCountDeviationInput {
  /** Unidades contadas por FOTO (evidencia obligatoria a nivel de ruta/BD -- este
   *  cálculo no valida la foto en sí, solo compara cantidades). */
  readonly countedQuantity: number;
  /** Consumo teórico esperado para el mismo ítem/periodo (estándar del hotel). */
  readonly theoreticalQuantity: number;
  /** Umbral de desviación, en porcentaje del consumo teórico, a partir del cual se
   *  considera una desviación que amerita alerta (p. ej. 15 = 15%). */
  readonly thresholdPct: number;
}

export interface LinenCountDeviationResult {
  /** Diferencia con signo (contado - teórico): positivo = se contó de más (posible
   *  sobre-reposición/desperdicio), negativo = se contó de menos (posible faltante/robo). */
  readonly deviationUnits: number;
  /** Desviación relativa al consumo teórico, en porcentaje absoluto. Cuando el consumo
   *  teórico es 0, cualquier unidad contada es una desviación del 100% (no hay forma de
   *  expresar "cuánto más" de cero sin dividir por cero; 0 contado sobre 0 teórico no es
   *  desviación) -- honesto en vez de fabricar un porcentaje sin sentido. */
  readonly deviationPct: number;
  /** true si `deviationPct` (absoluto) cruza `thresholdPct`. */
  readonly alertTriggered: boolean;
}

/** Calcula la desviación de un conteo verificado por foto contra el consumo teórico, y
 *  si cruza el umbral configurado -- puro, sin I/O. `apps/api/src/routes/housekeeping.ts`
 *  persiste el resultado junto con el conteo para que el reporte de desviaciones no
 *  tenga que recalcular nada. */
export function evaluateLinenCountDeviation(input: LinenCountDeviationInput): LinenCountDeviationResult {
  const deviationUnits = input.countedQuantity - input.theoreticalQuantity;
  const deviationPct =
    input.theoreticalQuantity === 0
      ? (input.countedQuantity === 0 ? 0 : 100)
      : (Math.abs(deviationUnits) / input.theoreticalQuantity) * 100;
  const alertTriggered = deviationPct > input.thresholdPct;
  return { deviationUnits, deviationPct, alertTriggered };
}

/** Umbral por defecto (%) cuando el hotel no configuró uno explícito -- ver
 *  `linenDeviationAlertThresholdPct()` en `apps/api/src/routes/housekeeping.ts` (mismo
 *  patrón de configuración por variable de entorno que `maintenanceApprovalThresholdMxn`,
 *  packages/agent-core/src/tools/housekeepingTools.ts). Documentado aquí como la
 *  constante de dominio que ambas capas comparten. */
export const DEFAULT_LINEN_DEVIATION_THRESHOLD_PCT = 15;
