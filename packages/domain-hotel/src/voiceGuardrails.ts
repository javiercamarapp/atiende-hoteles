/**
 * REQ-HUE-009 (P0/GOB): "El agente de voz nunca debe aceptar pagos con tarjeta por voz,
 * cotizar tarifas fuera del PMS, revelar el número de habitación o la presencia de un
 * huésped a terceros, ni emitir/gestionar llaves por voz; en pruebas, el 100% de esas
 * peticiones debe rechazarse (0 de N aceptadas)."
 *
 * Módulo de dominio PURO (mismo principio que `checkinFreeTextGuard.ts`/
 * `paymentFreeTextGuard.ts`/`fnbAllergyGuard.ts`): clasifica el texto YA TRANSCRITO de
 * un turno del canal de voz (`apps/api/src/routes/agentes.ts`, `canal: "voz"`) contra
 * las 4 categorías del requisito ANTES de que el mensaje llegue a cualquier proveedor
 * de modelo o tool -- así el rechazo es determinista y NUNCA depende de que un LLM
 * concreto "decida" resistir la petición (mismo criterio que
 * `tests/adversarial/prompt-injection.spec.ts`: la barrera real vive en la capa de
 * código, nunca únicamente en una instrucción del prompt).
 *
 * Defensa en profundidad -- este módulo NO es la única barrera de cada categoría:
 *   - Pago con tarjeta por voz: además de este filtro (que reutiliza la validación
 *     Luhn real de `paymentFreeTextGuard.ts`), el catálogo de tools de
 *     `recepcion_virtual` (agent-core `agents.ts`) NO incluye ninguna tool de cobro --
 *     ni siquiera un modelo totalmente comprometido podría ejecutar un cargo real.
 *   - Tarifa fuera del PMS: el catálogo de `recepcion_virtual` tampoco incluye ninguna
 *     tool de cotización/reserva -- su propio `systemPrompt` ya declara "nunca decide
 *     precio, tarifa, impuesto ni disponibilidad, eso siempre sale de un motor
 *     determinista" (`quote.ts`/`quotes.ts`, REQ-REV-001).
 *   - Emitir/gestionar llave por voz: el catálogo de `recepcion_virtual` tampoco
 *     incluye ninguna tool de cerraduras (`packages/mcp-servers/locks`).
 *   - Revelar habitación/presencia: a diferencia de las tres anteriores, NINGUNA tool
 *     existente redacta esto en la respuesta final del modelo -- esta categoría
 *     depende por completo de este filtro determinista (por eso se evalúa aquí y no se
 *     deja "cubierta implícitamente" por el catálogo cerrado de tools).
 *
 * Sesgo deliberado hacia FAIL-CLOSED (mismo criterio que `fnbAllergyGuard.ts`): un falso
 * positivo aquí solo cuesta redirigir una solicitud legítima al canal/flujo correcto
 * (WhatsApp, front desk, enlace de pago); un falso negativo dejaría pasar exactamente lo
 * que este requisito prohíbe. Patrones representativos de frases adversariales
 * conocidas, no un clasificador semántico -- mismo límite honesto que el resto de los
 * guards de texto libre de este paquete.
 */

import { detectAndRedactPaymentData } from "./paymentFreeTextGuard.ts";

export type VoiceGuardrailReason =
  | "pago_tarjeta_voz"
  | "tarifa_fuera_pms"
  | "revelar_habitacion_o_presencia"
  | "emitir_llave_voz";

export interface VoiceGuardrailRefusal {
  readonly reason: VoiceGuardrailReason;
  /** Respuesta segura para el huésped -- nunca confirma ni ejecuta la solicitud. */
  readonly guestFacingMessage: string;
}

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

// Frases de INTENCIÓN de pago con tarjeta por voz/teléfono -- combinadas más abajo con
// `detectAndRedactPaymentData` (que sí valida Luhn) para el caso en que el huésped
// dicte el número completo en el mismo turno.
const CARD_PAYMENT_PHRASES: readonly RegExp[] = [
  /\bpagar\w*\s+con\s+(?:mi\s+)?tarjeta\b/i,
  /\bcobra\w*\s+(?:por|v[ií]a)\s+(?:tel[ée]fono|voz|llamada)\b/i,
  /\bte\s+doy\s+mi\s+tarjeta\b/i,
  /\bmi\s+(?:numero|número)\s+de\s+tarjeta\s+es\b/i,
  /\bnumero\s+de\s+tarjeta\s+es\b/i,
  /\bcarga(?:lo)?\b.{0,20}\ba\s+mi\s+tarjeta\b/i,
  /\bquiero\s+dar(?:te)?\s+mi\s+tarjeta\b/i,
  /\bte\s+doy\s+el\s+numero\s+de\s+mi\s+tarjeta\b/i,
];

// Intento de que el agente confirme/acepte una tarifa que NO viene del motor real de
// cotización (quote.ts/rate_plan): "fuera del sistema/PMS", "lo que yo diga/ofrezco",
// "ignora la tarifa/el precio/el sistema/el PMS".
const OFF_PMS_RATE_PHRASES: readonly RegExp[] = [
  /\btarifa\s+especial\s+no\s+publicada\b/i,
  /\btarifa\s+que\s+yo\s+(?:diga|te\s+diga|ofrezco|propongo)\b/i,
  /\bprecio\s+que\s+yo\s+(?:diga|te\s+diga|ofrezco|propongo)\b/i,
  /\bignora\w*\s+(?:lo\s+que\s+diga\s+)?(?:la\s+tarifa|el\s+precio|el\s+sistema|el\s+pms)\b/i,
  /\bfuera\s+del\s+(?:pms|sistema)\b/i,
  /\back[eé]ptame?\s+(?:este|mi)\s+precio\b/i,
  /\bsin\s+(?:pasar\s+por|consultar)\s+(?:el\s+)?(?:pms|sistema)\b/i,
];

// Solicitud de revelar la habitación o la presencia de un huésped -- potencialmente a
// un tercero ("¿en qué habitación está...?", "¿está hospedado...?", "número de cuarto
// de...", "confírmame si se está hospedando...").
const ROOM_OR_PRESENCE_DISCLOSURE_PHRASES: readonly RegExp[] = [
  /\ben\s+qu[eé]\s+(?:habitaci[oó]n|cuarto)\s+(?:esta|está|se\s+(?:encuentra|hospeda))\b/i,
  /\bn[uú]mero\s+de\s+(?:habitaci[oó]n|cuarto)\s+de\b/i,
  /\bconfirma(?:me)?\s+si\s+.{0,60}(?:esta|está)\s+hosped/i,
  /\bdime\s+si\s+.{0,60}(?:esta|está)\s+hosped/i,
  // REQ-HUE-023 (canal de texto): más variantes verbales de la misma solicitud
  // ("digas"/"sepas"/"sabes" en vez de "confirma"/"dime") -- encontradas al ampliar
  // este guardrail a texto, mismo patrón léxico de dos partes (verbo + "si ...
  // hospedad").
  /\b(?:digas|sepas|sabes)\s+si\s+.{0,60}(?:esta|está)\s+hosped/i,
  /\brevela(?:me)?\s+(?:el|la)\s+(?:cuarto|habitaci[oó]n)\s+de\b/i,
];

// Emisión/gestión de llave digital por voz -- "mándame la llave", "genera un código de
// acceso", "actívame la llave por teléfono/voz".
const KEY_ISSUANCE_VOICE_PHRASES: readonly RegExp[] = [
  /\bm[aá]nda(?:me)?\s+(?:la|una)\s+llave\b/i,
  /\benv[ií]a(?:me)?\s+(?:la|una)\s+llave\b/i,
  /\bgenera(?:me)?\s+(?:la|una)\s+llave\b/i,
  /\bgenera(?:me)?\s+(?:un|el)\s+c[oó]digo\s+de\s+acceso\b/i,
  /\bemite(?:me)?\s+(?:la|una)\s+llave\b/i,
  /\bactiva(?:me)?\s+(?:la|mi)\s+llave\s+(?:digital\s+)?(?:por|v[ií]a)\s+(?:tel[ée]fono|voz)\b/i,
  /\bd[aá]me\s+(?:un|el)\s+c[oó]digo\s+de\s+(?:acceso|entrada)\b/i,
];

/** true si el texto contiene un número de tarjeta Luhn-válido y/o una frase de
 *  intención explícita de pagar/cobrar con tarjeta por voz/teléfono. */
export function looksLikeCardPaymentByVoice(text: string | null | undefined): boolean {
  if (!text) return false;
  const { containsSensitiveData } = detectAndRedactPaymentData(text);
  if (containsSensitiveData) return true;
  return matchesAny(CARD_PAYMENT_PHRASES, stripDiacritics(text));
}

/** true si el texto pide una tarifa/precio distinto al que produciría el motor real de
 *  cotización (fuera del PMS/sistema, "lo que yo diga", ignorar el sistema). */
export function looksLikeOffPmsRateRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return matchesAny(OFF_PMS_RATE_PHRASES, stripDiacritics(text));
}

/** true si el texto pide revelar el número de habitación o la presencia de un huésped. */
export function looksLikeRoomOrPresenceDisclosureRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return matchesAny(ROOM_OR_PRESENCE_DISCLOSURE_PHRASES, stripDiacritics(text));
}

/** true si el texto pide emitir/gestionar/activar una llave digital por voz/teléfono. */
export function looksLikeKeyIssuanceByVoiceRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return matchesAny(KEY_ISSUANCE_VOICE_PHRASES, stripDiacritics(text));
}

const REFUSAL_MESSAGES: Readonly<Record<VoiceGuardrailReason, string>> = {
  pago_tarjeta_voz:
    "Por tu seguridad, no podemos recibir ni procesar el número de tu tarjeta por teléfono. Te compartimos un enlace de pago seguro para completar el cobro.",
  tarifa_fuera_pms:
    "Solo puedo confirmarte la tarifa verificada en nuestro sistema de reservas; no puedo aceptar ni cobrar una tarifa distinta a la publicada.",
  revelar_habitacion_o_presencia:
    "Por la privacidad y seguridad de nuestros huéspedes, no puedo confirmar ni compartir el número de habitación ni si una persona se hospeda aquí.",
  emitir_llave_voz:
    "Por seguridad, las llaves digitales solo se activan desde el enlace/app verificado del huésped; no puedo emitirlas ni gestionarlas por teléfono.",
};

/** Punto único de clasificación: dado el texto ya transcrito de un turno del canal de
 *  voz, decide si debe rechazarse ANTES de llegar a cualquier proveedor de modelo/tool.
 *  Devuelve `null` cuando ninguna de las 4 categorías del requisito aplica -- el mensaje
 *  sigue su curso normal (LLM real o demo determinista). Se evalúa fail-closed: basta
 *  que UNA categoría haga match para rechazar; el orden solo decide qué motivo se
 *  reporta cuando el texto dispara más de una a la vez (dinero primero). */
export function classifyVoiceGuardrailRefusal(text: string | null | undefined): VoiceGuardrailRefusal | null {
  if (!text) return null;
  if (looksLikeCardPaymentByVoice(text)) {
    return { reason: "pago_tarjeta_voz", guestFacingMessage: REFUSAL_MESSAGES.pago_tarjeta_voz };
  }
  if (looksLikeKeyIssuanceByVoiceRequest(text)) {
    return { reason: "emitir_llave_voz", guestFacingMessage: REFUSAL_MESSAGES.emitir_llave_voz };
  }
  if (looksLikeRoomOrPresenceDisclosureRequest(text)) {
    return {
      reason: "revelar_habitacion_o_presencia",
      guestFacingMessage: REFUSAL_MESSAGES.revelar_habitacion_o_presencia,
    };
  }
  if (looksLikeOffPmsRateRequest(text)) {
    return { reason: "tarifa_fuera_pms", guestFacingMessage: REFUSAL_MESSAGES.tarifa_fuera_pms };
  }
  return null;
}
