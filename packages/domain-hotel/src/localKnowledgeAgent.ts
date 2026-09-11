/**
 * REQ-HUE-026 (H08-024): "El sistema debe mantener un panel de 'conocimiento local'
 * (sargazo, clima, cierres de playa, horarios de ferry, eventos) editable por el
 * gerente y reflejado en las respuestas del agente conversacional en <30 s." La fuente
 * de datos real ya existía (`local_knowledge_entry`, migración 0052;
 * `apps/api/src/routes/conocimientoLocal.ts`, CRUD completo) -- lo que faltaba, como el
 * propio comentario de cabecera de esa ruta admitía explícitamente, era la CONEXIÓN: que
 * el agente conversacional realmente la consultara al responder. Este módulo es esa
 * mitad puerta-de-entrada: puro, sin I/O (mismo principio que `fnbAllergyGuard.ts`/
 * `tickets/slaPolicy.ts`) -- decide SI un mensaje de huésped pregunta por conocimiento
 * local y QUÉ responder dado lo que el llamador ya leyó de Postgres. La lectura sin
 * caché (la parte que hace real el "<30 s") sigue viviendo donde ya vivía: el único
 * punto real de este repo que procesa un mensaje entrante de huésped
 * (`apps/api/src/routes/mensajeria.ts`, el mismo webhook que ya conecta disclosure/
 * "es humano"/ticket -- ver REQ-HUE-006/014), que ahora también llama a este módulo.
 */

/** Igual a las categorías `check` de `local_knowledge_entry.category` (migración 0052)
 *  salvo `otro`: un huésped nunca pregunta genéricamente por "otro", así que no hay
 *  frase que detectar para esa categoría -- sigue siendo editable desde el panel del
 *  gerente, solo no tiene una ruta de detección conversacional propia. */
export const LOCAL_KNOWLEDGE_QUERY_CATEGORIES = ["sargazo", "clima", "playa", "ferry", "eventos"] as const;
export type LocalKnowledgeQueryCategory = (typeof LOCAL_KNOWLEDGE_QUERY_CATEGORIES)[number];

/** Subconjunto de columnas de `local_knowledge_entry` que este módulo necesita para
 *  componer una respuesta -- el llamador pasa filas YA leídas (sin caché) para la
 *  categoría detectada, este módulo no sabe nada de Postgres. */
export interface LocalKnowledgeEntryForAgent {
  readonly title: string;
  readonly content: string;
  /** ISO 8601 -- se usa solo para ordenar (más reciente primero), nunca se muestra tal cual. */
  readonly updatedAt: string;
}

/** Quita acentos/diacríticos y normaliza a minúsculas -- mismo criterio de
 *  normalización que `tickets/slaPolicy.ts::normalizar`/`reputacion/clasificador.ts`,
 *  reimplementado aquí a propósito (sin importar esos módulos): son tres contextos de
 *  dominio distintos (petición operativa del huésped, reseña post-estancia, pregunta de
 *  conocimiento local) que no deben acoplarse por una utilidad compartida accidental. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function contieneAlguna(textoNormalizado: string, frases: readonly string[]): boolean {
  return frases.some((frase) => textoNormalizado.includes(frase));
}

// Frases deliberadamente específicas, NUNCA la palabra suelta "clima": en el vocabulario
// de un huésped de hotel en México "el clima no funciona" casi siempre reporta el AIRE
// ACONDICIONADO descompuesto, no pide el pronóstico del tiempo -- esa es exactamente la
// frase que `tickets/slaPolicy.ts::DEPARTMENT_KEYWORDS.maintenance` ya reconoce ("clima
// no", "no enfria") para enrutar a mantenimiento. Si esta lista usara "clima" a secas,
// un huésped con el aire descompuesto recibiría el pronóstico del tiempo en vez de un
// ticket de mantenimiento -- una regresión real, no hipotética. Se exige contexto de
// clima/pronóstico explícito para evitar esa colisión.
const CATEGORY_KEYWORDS: Record<LocalKnowledgeQueryCategory, readonly string[]> = {
  sargazo: ["sargazo"],
  clima: [
    "pronostico del clima", "pronostico del tiempo", "como esta el clima",
    "como va a estar el clima", "clima de hoy", "clima de manana", "va a llover",
    "va a hacer sol", "huracan", "tormenta tropical", "temperatura afuera", "temperatura hoy",
  ],
  playa: [
    "cierre de playa", "esta cerrada la playa", "se puede nadar", "bandera roja",
    "bandera amarilla", "bandera verde", "condiciones de la playa", "la playa esta",
  ],
  ferry: ["ferry", "transbordador", "horario del barco", "barco a la isla"],
  eventos: [
    "que eventos hay", "hay algun evento", "actividades en la zona", "que hacer hoy",
    "festival", "evento esta semana", "eventos del hotel",
  ],
};

/** Clasificación heurística de MEJOR ESFUERZO (determinística, sin LLM ni servicio
 *  externo -- mismo espíritu que `classifyGuestMessage`): `null` cuando el mensaje no
 *  pregunta por ninguna categoría de conocimiento local reconocida. Un falso negativo
 *  aquí solo deja caer el mensaje al enrutamiento normal (ticket a frontdesk), nunca
 *  bloquea nada. */
export function detectLocalKnowledgeCategory(message: string | undefined): LocalKnowledgeQueryCategory | null {
  if (!message || message.trim().length === 0) return null;
  const normalized = normalizar(message);
  for (const category of LOCAL_KNOWLEDGE_QUERY_CATEGORIES) {
    if (contieneAlguna(normalized, CATEGORY_KEYWORDS[category])) return category;
  }
  return null;
}

const CATEGORY_LABELS: Record<LocalKnowledgeQueryCategory, string> = {
  sargazo: "sargazo",
  clima: "el clima",
  playa: "la playa",
  ferry: "el ferry",
  eventos: "eventos",
};

/** Mismo límite que `SendTextMessageInput.body` (`packages/mcp-servers/whatsapp/src/port.ts`,
 *  4096 -- límite real de un mensaje de texto de WhatsApp Cloud API). */
export const WHATSAPP_TEXT_MESSAGE_MAX_LENGTH = 4096;

/**
 * Compone la respuesta del agente a partir de las entradas VIGENTES de la categoría
 * detectada (ya leídas por el llamador, sin caché -- eso es lo que hace el "<30 s" real:
 * la próxima vez que este webhook procese un mensaje después de que el gerente guarde un
 * cambio, la lectura trae la fila actualizada). `null` cuando no hay ninguna entrada
 * para esa categoría en ese hotel: el mismo criterio de "lista vacía honesta" que
 * `conocimientoLocal.ts`/REQ-UX-002 -- nunca se inventa contenido que el gerente no
 * escribió; el llamador decide el respaldo (dejar que el mensaje caiga a un ticket de
 * frontdesk en vez de una respuesta fabricada).
 */
export function buildLocalKnowledgeReply(
  category: LocalKnowledgeQueryCategory,
  entries: readonly LocalKnowledgeEntryForAgent[],
): string | null {
  if (entries.length === 0) return null;

  const masRecientesPrimero = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cuerpo = masRecientesPrimero.map((entrada) => `• ${entrada.title}: ${entrada.content}`).join("\n");
  const mensaje = `Información actualizada sobre ${CATEGORY_LABELS[category]}:\n${cuerpo}`;

  return mensaje.length > WHATSAPP_TEXT_MESSAGE_MAX_LENGTH
    ? `${mensaje.slice(0, WHATSAPP_TEXT_MESSAGE_MAX_LENGTH - 1)}…`
    : mensaje;
}
