/**
 * REQ-RES-016: "un intento de completar el check-in por chat libre (texto plano) es
 * rechazado y redirigido al flujo estructurado." Módulo de dominio PURO: detecta si un
 * mensaje de texto libre PARECE un intento de enviar datos de check-in (documento de
 * identidad, MRZ, RFC) para que la capa de mensajería (apps/api/src/routes/mensajeria.ts)
 * responda con el enlace estructurado de un solo uso en vez de intentar interpretarlo.
 *
 * Ninguna ruta de este repo extrae identidad de texto libre de chat -- la ÚNICA forma
 * de registrar un documento es `complete_checkin_public()`/`register_identity_document()`
 * (packages/db/migrations/0051/0054), así que esto es una capa adicional de UX (avisar
 * pronto), no la barrera de seguridad real (que es estructural: no existe código que
 * lea identidad de un mensaje de WhatsApp).
 */

// Línea MRZ TD3: 44 caracteres de [A-Z0-9<], típicamente con múltiples '<' de relleno
// -- se acepta un mínimo de 40 SIN tope superior (una TD3 real mide 44, pero exigir
// el rango exacto [40,44] fallaría si el huésped pegó algún carácter extra alrededor;
// lo que importa es reconocer "una racha larga y estructurada", no validarla como MRZ
// real -- esa validación real y estricta vive en packages/domain-hotel/src/mrz.ts).
const MRZ_LINE_PATTERN = /(?:^|\s)[A-Z0-9<]{40,}(?:\s|$)/;
// RFC mexicano (persona física/moral): 3-4 letras + 6 dígitos + 3 alfanuméricos.
const RFC_PATTERN = /\b[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}\b/i;
// Frases explícitas de intento de check-in con datos personales.
const CHECKIN_PHRASE_PATTERN = /\b(check[\s-]?in|mi pasaporte|mi ine|numero de pasaporte|número de pasaporte)\b/i;

export function looksLikeCheckinDataInFreeText(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.toUpperCase();
  const hasMrzLike = MRZ_LINE_PATTERN.test(normalized);
  const hasRfc = RFC_PATTERN.test(normalized);
  const hasPhrase = CHECKIN_PHRASE_PATTERN.test(text);
  // Exige la frase explícita COMBINADA con un dato que parezca sensible (MRZ/RFC) --
  // solo "check-in" a secas ("¿ya puedo hacer check-in?") es una pregunta normal, no
  // un intento de enviar datos por chat libre.
  return hasPhrase && (hasMrzLike || hasRfc);
}
