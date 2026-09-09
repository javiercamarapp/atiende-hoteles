/**
 * REQ-SEG-007 (P0/SEG): "todo mensaje de marketing incluye opción de baja" -- verificado
 * con "mensaje sin opción de baja -> rechazado por el linter de plantillas". Módulo de
 * dominio PURO (mismo principio que `checkinFreeTextGuard.ts`/`voiceGuardrails.ts`): NO
 * decide si una plantilla ES de marketing (eso lo decide el hotel al clasificarla en
 * `hotel_messaging_config.marketing_templates`, migración 0099) -- solo valida el TEXTO
 * de una plantilla YA clasificada como marketing, antes de que `PATCH
 * .../mensajeria/config` (apps/api/src/routes/mensajeria.ts) permita guardarla.
 *
 * Deny-by-default (mismo criterio que `isMarketingSendBlocked`): un texto sin ninguna
 * frase reconocible de opción de baja se rechaza, incluso si el hotel "jura" que sí la
 * tiene en otro idioma o formato no reconocido -- un falso positivo aquí solo cuesta
 * pedirle al hotel que use una frase estándar (p.ej. "Responde BAJA para dejar de
 * recibir estos mensajes"); un falso negativo dejaría salir mensajes de marketing reales
 * sin opción de baja, exactamente lo que REQ-SEG-007 prohíbe.
 */

export interface MarketingTemplateLintResult {
  readonly ok: boolean;
  /** Motivo del rechazo, solo presente cuando `ok` es `false`. */
  readonly reason?: string;
}

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

// Frases de opción de baja reconocidas -- español (México, formato más común en
// WhatsApp/SMS) e inglés (STOP/unsubscribe, formato exigido por Meta/carriers de EE.UU.,
// ver REQ-SEG-017 "TCPA/CASL"). Se evalúan sobre el texto YA normalizado (sin acentos,
// minúsculas), así que aquí van sin acentos.
const OPT_OUT_PATTERNS: readonly RegExp[] = [
  /\bbaja\b/, // "responde BAJA", "para darte de baja"
  /\bstop\b/, // estándar de EE.UU./carriers
  /dejar de recibir/,
  /cancelar (tu |la )?suscripcion/,
  /darte de baja/,
  /dejar de recibir estos? mensajes?/,
  /unsubscribe/,
  /opt[\s-]?out/,
];

const MIN_BODY_LENGTH = 1;

/**
 * Verifica que `body` (el texto completo que se enviaría al huésped) incluya una opción
 * de baja explícita y reconocible. Se usa tanto al REGISTRAR una plantilla de marketing
 * (`PATCH /mensajeria/config`, rechaza con 400 antes de guardar) como, en el futuro, para
 * re-validar plantillas ya registradas si su texto cambia.
 */
export function lintMarketingTemplateBody(body: string | null | undefined): MarketingTemplateLintResult {
  const trimmed = (body ?? "").trim();
  if (trimmed.length < MIN_BODY_LENGTH) {
    return { ok: false, reason: "El texto de la plantilla de marketing está vacío." };
  }

  const normalized = stripDiacritics(trimmed).toLowerCase();
  const hasOptOut = OPT_OUT_PATTERNS.some((re) => re.test(normalized));
  if (!hasOptOut) {
    return {
      ok: false,
      reason:
        'El texto no incluye una opción de baja reconocible (p.ej. "Responde BAJA para dejar de recibir estos mensajes" o "STOP to unsubscribe").',
    };
  }

  return { ok: true };
}
