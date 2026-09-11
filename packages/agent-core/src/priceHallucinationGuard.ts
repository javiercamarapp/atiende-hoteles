/**
 * Patrón Likida/atiende.ai #4 (guardia anti-alucinación determinista): el único
 * mecanismo que impedía que un agente conversacional inventara un precio/tarifa/
 * disponibilidad era una instrucción en el `systemPrompt` ("Nunca decides precio,
 * tarifa, impuesto ni disponibilidad -- eso siempre sale de un motor determinista",
 * agents.ts `RECEPCION_VIRTUAL`) -- se confiaba en que el modelo obedeciera el prompt,
 * sin ninguna capa que verificara el texto de salida antes de que saliera hacia el
 * huésped. Este módulo es esa capa: escanea el `closingMessage` que `AgentRunner`
 * está a punto de emitir (runner.ts `close()`, ANTES de `run_finished`) buscando
 * menciones de cifras monetarias/disponibilidad, y las deja pasar SOLO si el mismo
 * texto aparece literalmente en el resultado (`result.summary`) de una tool ya
 * ejecutada en ESTA corrida -- la única fuente legítima de un precio/disponibilidad
 * real (`packages/domain-hotel/src/quote.ts`/`overbooking.ts`, vía una tool con
 * `effect="read"`/"money"`).
 *
 * Vive en `agent-core` (no en `domain-hotel`, a pesar de que el resto de guardas de
 * texto libre -- `checkinFreeTextGuard.ts`/`paymentFreeTextGuard.ts` -- viven ahí):
 * `agent-core` está deliberadamente construido SIN depender de `domain-hotel` (H6a,
 * "núcleo puro sin dependencias", ver comentario de cabecera de
 * `tools/ticketTools.ts`) y este módulo es puro texto (sin tipos ni vocabulario de
 * dominio hotelero), así que vive junto a su único consumidor real (`runner.ts`),
 * mismo criterio que `redact.ts` (guarda de texto libre que YA vive en este paquete).
 *
 * Igual que `redact.ts`: deliberadamente conservador (prefiere bloquear un mensaje
 * legítimo raro -- p.ej. un precio mencionado casualmente sin relación a una tarifa
 * real -- antes que dejar pasar una cifra inventada). No es un parser de lenguaje
 * natural: heurística de patrones de texto, como el resto de guardas de este repo.
 */

// Cifra monetaria: "$1,200", "$1200.00", "1200 MXN"/"1,200 pesos"/"50 USD"/"€50" --
// símbolo de moneda antes o código/palabra de moneda después de un número.
const MONEY_MENTION_RE =
  /(?:[$€]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:mxn|usd|pesos?|d[oó]lares?))/gi;

// Afirmación explícita de disponibilidad (positiva o negativa) de habitaciones/tarifa.
const AVAILABILITY_CLAIM_RE =
  /\b(s[ií]\s+hay\s+disponibilidad|no\s+hay\s+disponibilidad|hay\s+habitaciones?\s+disponibles?|tenemos\s+disponibilidad|(?:est[aá]|quedan?)\s+disponibles?|no\s+quedan\s+habitaciones?|quedan?\s+\d+\s+habitaciones?)\b/gi;

export interface PriceHallucinationFinding {
  readonly kind: "money" | "availability";
  readonly matchedText: string;
}

/** Normaliza espacios/mayúsculas para comparar dos fragmentos de texto de forma
 *  tolerante (el modelo puede reformatear ligeramente una cifra que sí citó una tool,
 *  p.ej. "$1200.00" vs "$1,200.00") -- se compara solo la SECUENCIA DE DÍGITOS para
 *  las cifras monetarias, que es lo que realmente identifica una tarifa real. */
function digitsOnly(value: string): string {
  return value.replace(/[^\d]/g, "");
}

/**
 * Busca en `message` menciones de dinero/disponibilidad que NO aparezcan (para dinero:
 * la misma secuencia de dígitos; para disponibilidad: la misma frase-patrón) en
 * `sourcedText` -- los `result.summary` de las tools YA ejecutadas en esta corrida. Sin
 * ninguna tool de tarifa/disponibilidad en el catálogo del agente (como
 * `recepcion_virtual` hoy, ver comentario de cabecera), `sourcedText` normalmente
 * viene vacío y CUALQUIER mención se marca -- ese es el comportamiento correcto: no
 * hay ninguna fuente legítima que citar todavía.
 */
export function findPriceHallucinations(
  message: string,
  sourcedText: readonly string[] = [],
): PriceHallucinationFinding[] {
  const findings: PriceHallucinationFinding[] = [];
  const sourcedJoined = sourcedText.join("\n");
  const sourcedDigitSequences = sourcedText.map(digitsOnly);

  for (const match of message.matchAll(MONEY_MENTION_RE)) {
    const matchedText = match[0];
    const digits = digitsOnly(matchedText);
    // Una cifra de 0-1 dígitos (p.ej. "$5" recortado por un límite de moneda no
    // capturado) no es una tarifa real -- evita ruido; el patrón ya exige al menos un
    // dígito, esto es solo defensivo.
    if (digits.length === 0) continue;
    const sourced = sourcedDigitSequences.some((seq) => seq === digits);
    if (!sourced) findings.push({ kind: "money", matchedText });
  }

  // Se calcula UNA vez fuera del bucle (no dentro de cada iteración) para no depender
  // del estado mutable (`lastIndex`) de una regex global reutilizada con `.test()`.
  const sourcedHasAvailabilityPhrase = new RegExp(AVAILABILITY_CLAIM_RE.source, "i").test(sourcedJoined);
  for (const match of message.matchAll(AVAILABILITY_CLAIM_RE)) {
    if (!sourcedHasAvailabilityPhrase) findings.push({ kind: "availability", matchedText: match[0] });
  }

  return findings;
}

/** Mensaje de reemplazo, fijo y siempre igual (nunca generado por el modelo) --
 *  nunca inventa una disculpa distinta que pudiera, ella misma, alucinar algo. */
export const PRICE_HALLUCINATION_FALLBACK_MESSAGE =
  "Para confirmarte la tarifa/disponibilidad exacta necesito verificarlo con el sistema del hotel; " +
  "un miembro del staff te confirma en breve.";

export interface SanitizeClosingMessageResult {
  readonly message: string;
  readonly blocked: boolean;
  readonly findings: readonly PriceHallucinationFinding[];
}

/**
 * Punto de uso real (runner.ts `close()`): si `message` contiene una mención de
 * precio/disponibilidad no sourced, la REEMPLAZA por completo por
 * `PRICE_HALLUCINATION_FALLBACK_MESSAGE` -- nunca se recorta solo el fragmento
 * ofensor (dejaría una oración del modelo gramaticalmente rota o, peor, engañosa a
 * medias) -- y `blocked=true` para que el llamador pueda emitir un evento de traza.
 */
export function sanitizeClosingMessage(message: string, sourcedText: readonly string[] = []): SanitizeClosingMessageResult {
  const findings = findPriceHallucinations(message, sourcedText);
  if (findings.length === 0) {
    return { message, blocked: false, findings: [] };
  }
  return { message: PRICE_HALLUCINATION_FALLBACK_MESSAGE, blocked: true, findings };
}
