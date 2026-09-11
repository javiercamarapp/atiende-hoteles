// REQ-RES-018 (P1/F): "El agente de reservas debe capturar el teléfono/email real del
// huésped cuando la OTA lo enmascara, mediante un link de check-in enviado por la
// mensajería propia de esa OTA con consentimiento explícito, sin contactar antes por un
// canal ajeno a la plataforma de la OTA." (BP-027, H05-024, H09-010, BP-122).
//
// Contexto real: Booking.com/Expedia/Airbnb enmascaran por defecto el teléfono/email del
// huésped detrás de un relay propio de la OTA -- el hotel nunca ve el contacto real hasta
// que el huésped lo comparte voluntariamente (típicamente al completar el check-in
// online, ver `routes/checkinOnline.ts`). Mandar un WhatsApp/SMS/email directo a ese
// contacto enmascarado no llega al huésped real (es un relay de la OTA, no su teléfono) y
// viola la política de la OTA de contactar al huésped solo a través de su propia
// plataforma antes de que él mismo comparta su contacto real -- de ahí la segunda mitad
// del criterio, "sin contactar antes por un canal ajeno a la plataforma de la OTA".
//
// REQ-RES-022/REQ-REV-008 (H15-006) siguen prohibiendo construir conectividad OTA propia
// (API directa a Booking/Expedia/Airbnb) durante esta fase -- este módulo NO asume ni
// simula un conector real de mensajería por OTA (eso requeriría certificación/credenciales
// de cada OTA, fuera de alcance declarado). Lo que SÍ es 100% real y verificable sin
// ninguna credencial es la PREGUNTA que ambas capas de la API necesitan responder
// idénticamente: "¿el contacto de este huésped sigue siendo el relay enmascarado de una
// OTA, o ya es su contacto real?" -- `routes/checkinOnline.ts` la usa para decidir si el
// enlace de check-in debe salir por el canal 'ota' en vez de mostrarse/enviarse
// directamente, y `packages/agent-core/src/tools/messagingTools.ts` la usa para bloquear
// un envío de WhatsApp directo mientras la respuesta sea `true`. Mismo principio de
// separación dominio/IO que `atribucionCanal.ts`/`revenue/parity-guard.ts`: el CÁLCULO
// vive aquí (puro, sin DB), la LECTURA de `reservation.channel`/
// `reservation.guest_contact_masked_by_ota` vive en cada capa que llama.
import { DIRECT_CHANNEL } from "./atribucionCanal.ts";

export interface ReservaContactoOtaInput {
  /** `reservation.channel` (migración 0014). 'directo' significa que este huésped nunca
   *  pasó por una OTA, sin importar el valor de `guestContactMaskedByOta` -- defensa en
   *  profundidad: un dato inconsistente (flag en `true` sobre una reserva directa) nunca
   *  bloquea contacto directo real ni fuerza un envío por un canal 'ota' que no aplica. */
  readonly channel: string;
  /** `reservation.guest_contact_masked_by_ota` (migración 0130). */
  readonly guestContactMaskedByOta: boolean;
}

/**
 * `true` cuando el contacto de este huésped SIGUE siendo el relay enmascarado de la OTA
 * de origen -- ni `channel` distinto de `'directo'` ni el flag por sí solos bastan, deben
 * coincidir los dos: un `channel` de OTA con el flag ya en `false` significa que el
 * huésped YA compartió su contacto real (p. ej. al completar el check-in online, que
 * limpia el flag -- ver `complete_checkin_public`/`routes/checkinOnline.ts`), así que el
 * contacto directo deja de estar bloqueado desde ese momento sin necesidad de otra
 * migración ni de tocar `channel`.
 */
export function esContactoEnmascaradoPorOta(input: ReservaContactoOtaInput): boolean {
  return input.channel !== DIRECT_CHANNEL && input.guestContactMaskedByOta === true;
}

/**
 * REQ-RES-018 (segunda mitad del criterio de aceptación): "verificado que ningún
 * contacto sale por un canal ajeno a la OTA antes del consentimiento". Mientras
 * `esContactoEnmascaradoPorOta()` sea `true`, ninguna tool de mensajería directa
 * (WhatsApp/SMS/email) puede dirigirse a este huésped -- el único canal permitido es el
 * de la propia OTA (`channel = 'ota'` en `conversation`/`message`, ver
 * `routes/checkinOnline.ts`). Alias semántico de la misma condición para que cada
 * llamador exprese su propia pregunta con claridad (agent-core pregunta "¿debo bloquear
 * este envío directo?", checkinOnline pregunta "¿debo enviar este enlace por el canal de
 * la OTA en vez de mostrarlo directo?") sin duplicar la lógica ni poder divergir.
 */
export function debeBloquearContactoPorCanalAjenoALaOta(input: ReservaContactoOtaInput): boolean {
  return esContactoEnmascaradoPorOta(input);
}
