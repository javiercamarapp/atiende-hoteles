/**
 * Patrón Likida/atiende.ai #8 (fast-path determinista antes del LLM, intent 3 de 3
 * pendientes): los derechos ARCO/privacidad (`apps/api/src/routes/privacidad.ts`,
 * REQ-SEG-002) solo eran alcanzables vía un endpoint estructurado separado
 * (`POST /privacidad/solicitud`) -- si un huésped los pedía por WhatsApp, no había
 * ninguna detección que lo redirigiera; caía en el mismo flujo genérico que cualquier
 * otro mensaje, sin ningún rastro de que se trataba de un ejercicio de derechos de
 * datos personales.
 *
 * Módulo de dominio PURO (mismo criterio que `checkinFreeTextGuard.ts`/
 * `paymentFreeTextGuard.ts`): detecta si un mensaje de texto libre PARECE una
 * solicitud de acceso/rectificación/cancelación/oposición sobre datos personales, para
 * que la capa de mensajería responda con la plantilla estructurada que enlaza a
 * `/privacidad/solicitud` ANTES de crear un ticket genérico -- nunca ejecuta ningún
 * borrado/exportación de datos en sí (eso sigue siendo exclusivo del flujo humano de
 * `routes/privacidad.ts`, con su propio SLA auditable).
 */

// Mención explícita del marco ARCO o de "protección de datos"/"aviso de privacidad".
const ARCO_TERM_RE = /\b(derechos?\s+arco|protecci[oó]n de datos( personales)?|aviso de privacidad)\b/i;
// Verbo de acción sobre "mis datos" (acceso, rectificación, cancelación/borrado,
// oposición) -- exige el verbo COMBINADO con "mis datos"/"mi información personal"
// para no confundir con cualquier otra mención de "datos" (p.ej. "mis datos de
// contacto para la reserva" al hacer check-in normal).
const ARCO_ACTION_RE =
  /\b(borrar|eliminar|borren|eliminen|rectificar|corregir|acceder a|exportar|opon(erme|go)( al tratamiento)?)\b.{0,20}\b(mis datos|mi informaci[oó]n personal|mis datos personales)\b|\b(mis datos|mi informaci[oó]n personal|mis datos personales)\b.{0,20}\b(borrar|eliminar|borren|eliminen|rectificar|corregir)\b/i;

export function looksLikeArcoRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return ARCO_TERM_RE.test(text) || ARCO_ACTION_RE.test(text);
}
