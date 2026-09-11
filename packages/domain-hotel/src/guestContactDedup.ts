/**
 * REQ-RES-019 (P2/F): "El sistema debe deduplicar contactos con emails/teléfonos
 * enmascarados de distintas reservas del mismo huésped en un solo perfil."
 *
 * Módulo de dominio PURO (mismo patrón que folioEngine.ts/fnbAllergyGuard.ts): ninguna
 * función de aquí toca I/O -- `apps/api/src/routes/huespedes.ts` es quien consulta los
 * perfiles existentes en la base y decide si reutiliza uno o crea un huésped nuevo.
 *
 * EL PROBLEMA REAL que resuelve: cuando una OTA (Booking.com, Expedia, Airbnb...)
 * entrega el contacto de un huésped, ese email/teléfono es un PROXY de la OTA que
 * cambia en CADA reserva -- por diseño de la OTA, para que el hotel no pueda contactar
 * al huésped fuera de su plataforma. Dos reservas del MISMO huésped humano en la MISMA
 * OTA llegan casi siempre con dos contactos distintos que NUNCA van a coincidir por
 * diseño -- comparar email/teléfono entre ellas para deduplicar es comparar dos valores
 * que la propia OTA garantiza que serán diferentes. Intentarlo de todos modos (como
 * haría una deduplicación "obvia" por email/teléfono) simplemente nunca fusiona nada.
 *
 * LA SEÑAL QUE SÍ es estable entre dos reservas de la MISMA OTA: el nombre completo que
 * la OTA reporta (normalizado) + que ambas reservas vengan del MISMO canal. Esto es
 * DELIBERADAMENTE más débil que un identificador real de huésped (dos personas
 * distintas con el mismo nombre en la misma OTA se fusionarían por error) -- es el
 * límite real de lo que se puede deducir SIN conectividad OTA propia (REQ-RES-022
 * prohíbe construirla en esta fase) y sin un identificador de perfil de la OTA que este
 * repo no recibe hoy. Se documenta el límite explícitamente, no se simula una precisión
 * que no existe.
 *
 * FAIL-SAFE hacia el otro lado: el canal 'directo' (REQ-RES-022: el único que la app
 * produce hoy en producción) NUNCA se deduplica por nombre -- ahí el contacto lo da el
 * huésped directamente y es la fuente de verdad; fusionar por nombre fusionaría por
 * error a dos huéspedes reales distintos que solo comparten nombre. La deduplicación de
 * este módulo SOLO se activa para canales no-directos (OTA), donde el contacto ya es
 * sabido-y-documentado como no confiable.
 */
import { isDirectChannel } from "./reservas/atribucionCanal.ts";

/** Normaliza un nombre completo para comparación tolerante a acentos/mayúsculas/
 *  espacios repetidos -- mismo patrón que `normalizeForCompare` de `folioEngine.ts`. */
export function normalizeGuestName(fullName: string): string {
  return fullName
    .trim()
    .toLocaleLowerCase("es-MX")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
}

export interface GuestChannelProfile {
  readonly guestId: string;
  readonly fullName: string;
  /** Canales (OTA) en los que este huésped YA tiene al menos una reserva registrada en
   *  este hotel. Un huésped sin ninguna reserva todavía no es candidato a fusión --
   *  nada garantiza todavía que su contacto sea un proxy de OTA. */
  readonly channels: readonly string[];
}

export interface GuestDedupeCandidate {
  readonly fullName: string;
  /** Canal de la reserva/importación que trae a este huésped (p. ej. 'directo',
   *  'booking_com', 'airbnb'). */
  readonly channel: string;
}

/**
 * Decide si `candidate` (un huésped por crear) corresponde a un perfil YA EXISTENTE --
 * y si es así, devuelve su `guestId`. `null` cuando no hay fusión posible: el canal es
 * 'directo' (nunca se fusiona por nombre, ver comentario de módulo), el nombre viene
 * vacío, o ningún perfil existente coincide en canal + nombre normalizado.
 */
export function findGuestDedupeMatch(
  candidate: GuestDedupeCandidate,
  existingProfiles: readonly GuestChannelProfile[],
): string | null {
  if (isDirectChannel(candidate.channel)) return null;
  const normalizedCandidate = normalizeGuestName(candidate.fullName);
  if (normalizedCandidate.length === 0) return null;

  const match = existingProfiles.find(
    (profile) =>
      profile.channels.includes(candidate.channel) &&
      normalizeGuestName(profile.fullName) === normalizedCandidate,
  );
  return match?.guestId ?? null;
}
