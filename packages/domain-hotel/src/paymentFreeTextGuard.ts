/**
 * L-tarjeta (auditoría-2 legal CRÍTICO, REQ-HUE-010/H09-027): "detectar y bloquear
 * intentos de captura de PAN [número de tarjeta] en texto libre... borrando el dato y
 * redirigiendo a un link de pago seguro." Módulo de dominio PURO (mismo principio que
 * `checkinFreeTextGuard.ts`): detecta si un mensaje de texto libre de WhatsApp
 * contiene un número de tarjeta (u otro dato de pago sensible: CVV, fecha de
 * vencimiento) y produce la versión REDACTADA que es segura de persistir en
 * `message.body` -- la capa de mensajería (apps/api/src/routes/mensajeria.ts) es
 * quien decide qué hacer con el resultado (marcar `contiene_dato_sensible`, avisar al
 * huésped).
 *
 * A diferencia de `checkinFreeTextGuard.ts` (que solo detecta "parece MRZ/RFC"), aquí
 * SÍ se valida con el algoritmo de Luhn real -- un número de tarjeta real siempre lo
 * cumple, así que exigirlo reduce falsos positivos sobre cualquier racha larga de
 * dígitos (un código de confirmación, un teléfono largo con lada).
 */

// Candidatos a número de tarjeta: 12-19 dígitos, con separadores opcionales (espacio o
// guion) cada grupo -- mismo rango que `CARD_RE` de agent-core/redact.ts, para
// reconocer el mismo patrón en ambos lados del sistema (traza vs. mensaje entrante).
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){11,18}\d\b/g;

// CVV: 3-4 dígitos, casi siempre mencionado junto a una palabra explícita (para no
// confundir con cualquier número corto de la conversación).
const CVV_PHRASE_RE = /\bcvv\b\s*[:\s-]?\s*\d{3,4}\b/gi;
// Fecha de vencimiento de tarjeta: MM/AA o MM-AA, junto a una palabra explícita.
const EXPIRY_PHRASE_RE = /\bvenc\w*\b\s*[:\s-]?\s*\d{2}\s*[/-]\s*\d{2,4}\b|\bexp(?:ira|iracion|iración)?\b\s*[:\s-]?\s*\d{2}\s*[/-]\s*\d{2,4}\b/gi;

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Algoritmo de Luhn: verdadero si `digits` (solo dígitos) es un número de tarjeta
 *  matemáticamente válido -- no confirma que la tarjeta EXISTA, pero descarta rachas
 *  de dígitos aleatorias (un folio, un teléfono largo) que nunca pasarían esta suma. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface PaymentSensitiveDataResult {
  /** true si se encontró un PAN (Luhn-válido) y/o CVV/vencimiento explícitos. */
  readonly containsSensitiveData: boolean;
  /** true específicamente si se encontró un número de tarjeta (PAN) Luhn-válido. */
  readonly containsCardNumber: boolean;
  /** Texto seguro de persistir: cualquier PAN/CVV/vencimiento detectado se reemplaza
   *  por un marcador -- NUNCA el dato original. */
  readonly redactedText: string;
}

/** Único punto de detección+redacción de datos de pago en texto libre entrante. */
export function detectAndRedactPaymentData(text: string | null | undefined): PaymentSensitiveDataResult {
  if (!text) {
    return { containsSensitiveData: false, containsCardNumber: false, redactedText: text ?? "" };
  }

  let redacted = text;
  let containsCardNumber = false;

  redacted = redacted.replace(CARD_CANDIDATE_RE, (match) => {
    const digits = onlyDigits(match);
    if (luhnValid(digits)) {
      containsCardNumber = true;
      return "[TARJETA]";
    }
    return match;
  });

  let containsOtherSensitive = false;
  redacted = redacted.replace(CVV_PHRASE_RE, () => {
    containsOtherSensitive = true;
    return "[CVV]";
  });
  redacted = redacted.replace(EXPIRY_PHRASE_RE, () => {
    containsOtherSensitive = true;
    return "[VENCIMIENTO]";
  });

  return {
    containsSensitiveData: containsCardNumber || containsOtherSensitive,
    containsCardNumber,
    redactedText: redacted,
  };
}
