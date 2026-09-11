/**
 * Patrón Likida/atiende.ai #8 (fast-path determinista antes del LLM, intent 2 de 3
 * pendientes): "queja de pago" (disputa/cobro indebido) es DISTINTO de la captura de
 * PAN en texto libre que ya cubre `paymentFreeTextGuard.ts` (ese detecta un número de
 * tarjeta escrito por el huésped; este detecta una QUEJA sobre un cargo YA hecho --
 * "me cobraron de más", "no reconozco este cargo"). Ninguno de los dos existía para
 * este segundo caso: hasta este módulo, una queja de pago caía en la clasificación
 * genérica de ticket (o en el agente LLM) en vez de redirigirse al flujo estructurado
 * de privacidad/soporte de pagos.
 *
 * Módulo de dominio PURO (mismo criterio que `checkinFreeTextGuard.ts`/
 * `paymentFreeTextGuard.ts`): detecta si un mensaje de texto libre PARECE una queja
 * sobre un cobro/cargo (no una simple pregunta de saldo), para que la capa de
 * mensajería (apps/api/src/routes/mensajeria.ts) responda con la plantilla
 * estructurada ANTES de crear un ticket genérico -- nunca decide ni ejecuta ningún
 * reembolso/reverso (eso sigue siendo exclusivo de `POST .../folios/.../reverso`,
 * accionado por staff con `MONEY_ROLES`).
 */

// Frases explícitas de disputa/queja sobre un cargo ya realizado -- exige la queja
// COMBINADA con la palabra "cobro"/"cargo"/"pago" para no confundir con cualquier
// mención de dinero ("¿cuánto cuesta la habitación?" no es una queja).
const PAYMENT_COMPLAINT_RE =
  /\b(cobro indebido|cargo indebido|me cobraron (de m[aá]s|doble|dos veces|sin autorizaci[oó]n)|cargo duplicado|cobro duplicado|no reconozco (este|el) (cargo|cobro)|cobro no autorizado|cargo no autorizado|quiero (un reembolso|mi reembolso|que me regresen mi dinero|que me devuelvan mi dinero)|disputar? (el cobro|mi pago|este cargo|el cargo)|me cobraron mal|el cobro est[aá] mal|el cargo est[aá] mal)\b/i;

export function looksLikePaymentComplaint(text: string | null | undefined): boolean {
  if (!text) return false;
  return PAYMENT_COMPLAINT_RE.test(text);
}
