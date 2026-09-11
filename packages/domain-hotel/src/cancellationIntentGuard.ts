/**
 * Patrón Likida/atiende.ai #8 (fast-path determinista antes del LLM, intent 1 de 3
 * pendientes): "cancelar mi reserva" en chat ya tiene un endpoint estructurado y
 * verificado real (`POST /reservas/cancelacion-publica`, REQ-RES-005 -- exige código de
 * reserva + apellido antes de cancelar), pero hasta este módulo un huésped que lo pedía
 * por WhatsApp caía en la clasificación genérica de ticket (o en el agente LLM) en vez
 * de redirigirse a ese flujo ya verificado -- exactamente el mismo problema que
 * `checkinFreeTextGuard.ts`/`paymentFreeTextGuard.ts` ya resuelven para check-in/pago.
 *
 * Módulo de dominio PURO (mismo criterio que esos dos): detecta si un mensaje de texto
 * libre PARECE una solicitud de cancelación de reserva, para que la capa de mensajería
 * (apps/api/src/routes/mensajeria.ts) responda con el enlace/plantilla estructurada
 * ANTES de crear un ticket genérico o invocar al agente conversacional -- nunca
 * ejecuta la cancelación en sí (eso sigue siendo exclusivo de
 * `cancel_reservation_public()`, verificado por código+apellido).
 */

// Verbo de cancelación/anulación, en cualquiera de sus formas conjugadas comunes en
// este contexto (imperativo/infinitivo/sustantivo).
const CANCEL_VERB_RE = /\b(cancelar|cancela|cancelo|cancelaci[oó]n|anular|anula|anulaci[oó]n)\b/i;
// Objeto: la reserva/reservación (propia o genérica) -- sin esto, "cancelar" a secas
// podría referirse a otra cosa (p.ej. "cancelar mi pedido de room service").
const RESERVATION_OBJECT_RE = /\b(mi reserva|la reserva|mi reservaci[oó]n|la reservaci[oó]n|mi habitaci[oó]n reservada|mi estad[ií]a)\b/i;

export function looksLikeCancellationIntent(text: string | null | undefined): boolean {
  if (!text) return false;
  return CANCEL_VERB_RE.test(text) && RESERVATION_OBJECT_RE.test(text);
}
