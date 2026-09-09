// REQ-RES-006/H01-010,H02-011 (P1/F): lista de espera automática. El sistema debe
// ofrecer la habitación liberada por una cancelación al PRIMER contacto en cola
// (estricto FIFO), a precio directo sin comisión. Este módulo es la contraparte
// determinista/sin I/O de `apps/api/src/pms/waitlistOffer.ts` (que hace la lectura
// real de `public.hotel_waitlist_entry` bajo advisory row lock) y de la migración
// `packages/db/migrations/0119_waitlist.sql` -- mismo principio de "el motor de
// dominio es puro" que packages/domain-hotel/src/overbooking.ts/cancellationPolicy.ts.
//
// "Precio directo sin comisión": este sistema NUNCA modela una tarifa de OTA/canal
// externo (routes/reservas.ts documenta que `channel` siempre vale 'directo' en H4) --
// el precio de la oferta es, por diseño, el mismo neto que `quoteNetAmount()` cotiza
// para cualquier reserva directa. No existe una tarifa "con comisión" de la que restar
// nada: ofertar ese neto YA satisface el criterio, sin inventar una tarifa OTA que este
// repositorio no modela.

export const WAITLIST_STATUSES = ["esperando", "ofertada", "expirada", "confirmada", "cancelada"] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

/** Horas que un contacto tiene para aceptar una oferta antes de que expire. Una
 *  cancelación futura que vuelva a coincidir con el mismo room_type/fechas nunca
 *  vuelve a ofrecérsela a un contacto expirado -- ver comentario de cabecera de la
 *  migración 0096 sobre por qué esto es deliberado. */
export const WAITLIST_OFFER_WINDOW_HOURS = 24;

export interface WaitlistCandidate {
  id: string;
  roomTypeId: string;
  checkInDate: string;
  checkOutDate: string;
  status: WaitlistStatus;
  /** ISO 8601. */
  createdAt: string;
}

export interface WaitlistMatchCriteria {
  roomTypeId: string;
  checkInDate: string;
  checkOutDate: string;
}

/**
 * Un candidato es elegible para la oferta automática si sigue 'esperando' y pidió
 * EXACTAMENTE el mismo tipo de habitación y rango de fechas que la reserva recién
 * cancelada. H4 no implementa "habitación equivalente" ni fechas parcialmente
 * solapadas (fuera de alcance declarado): ofrecer una fecha distinta a la que el
 * contacto pidió sería inventarle disponibilidad que nunca solicitó.
 */
export function matchesWaitlistRequest(candidate: WaitlistCandidate, criteria: WaitlistMatchCriteria): boolean {
  return (
    candidate.status === "esperando" &&
    candidate.roomTypeId === criteria.roomTypeId &&
    candidate.checkInDate === criteria.checkInDate &&
    candidate.checkOutDate === criteria.checkOutDate
  );
}

/**
 * FIFO ESTRICTO: el contacto que se unió PRIMERO a la cola (created_at más antiguo,
 * `id` como desempate determinista ante un empate exacto de timestamp) es siempre el
 * elegido -- esta función ordena internamente, así que la garantía FIFO no depende de
 * que quien llama ya haya ordenado la fila (`ORDER BY` de la consulta SQL es una
 * optimización, no la fuente de verdad del orden).
 */
export function selectNextWaitlistCandidate(
  candidates: readonly WaitlistCandidate[],
  criteria: WaitlistMatchCriteria,
): WaitlistCandidate | null {
  const eligible = candidates.filter((c) => matchesWaitlistRequest(c, criteria));
  if (eligible.length === 0) return null;

  const sorted = [...eligible].sort((a, b) => {
    const byCreatedAt = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return sorted[0]!;
}

export function computeOfferExpiresAt(nowIso: string, windowHours: number = WAITLIST_OFFER_WINDOW_HOURS): string {
  const expiresAtMs = new Date(nowIso).getTime() + windowHours * 60 * 60 * 1000;
  return new Date(expiresAtMs).toISOString();
}

export function isOfferExpired(offerExpiresAtIso: string, nowIso: string): boolean {
  return new Date(nowIso).getTime() >= new Date(offerExpiresAtIso).getTime();
}
