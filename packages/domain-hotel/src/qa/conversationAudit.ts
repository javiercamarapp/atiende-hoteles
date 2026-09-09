// REQ-HUE-007: "El sistema debe auditar semanalmente una muestra de
// conversaciones/llamadas (p. ej. 30) para detectar errores del bot
// (disponibilidad/precio erróneo, políticas inventadas, identidad no verificada,
// idioma incorrecto, alucinaciones)." (docs/REQUISITOS.md, H03-024). Dependencia
// externa declarada: "ninguna" -- el universo a auditar es `conversation`/`message`
// (packages/db/migrations/0044_conversation_message.sql), que ya existe hoy sobre el
// canal WhatsApp simulado (`FakeWhatsappAdapter`, ADR-007); no se necesita telefonía
// real para que "auditar una muestra semanal" tenga sentido y sea verificable.
//
// Puro, determinístico, sin I/O (mismo principio que tickets/slaPolicy.ts y
// fraude/deteccion.ts): la selección de la muestra es una función de (ids candidatos,
// semilla) -- nunca usa Math.random() ni Date.now()/new Date() internamente -- para
// que una auditoría sea reproducible: volver a pedir "la muestra de la semana del 1 de
// septiembre" debe devolver siempre el mismo conjunto, no un sorteo distinto cada vez
// que alguien la consulta. La capa de aplicación
// (apps/api/src/routes/auditoriaConversaciones.ts) persiste la muestra ya generada
// -- una vez guardada, volver a pedirla devuelve las filas existentes sin re-sortear.

export const DEFAULT_WEEKLY_AUDIT_SAMPLE_SIZE = 30;

/** Las 5 categorías de error que H03-024 pide poder detectar + "ninguno" (la
 *  conversación revisada no tenía ningún error del bot). */
export const CONVERSATION_AUDIT_CATEGORIES = [
  "ninguno",
  "disponibilidad_o_precio_incorrecto",
  "politica_inventada",
  "identidad_no_verificada",
  "idioma_incorrecto",
  "alucinacion",
] as const;
export type ConversationAuditCategory = (typeof CONVERSATION_AUDIT_CATEGORIES)[number];

export class ConversationAuditError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConversationAuditError";
    this.code = code;
  }
}

/** Lunes (00:00 UTC) de la semana ISO-8601 que contiene `date` -- identificador estable
 *  de "semana auditada", formato "YYYY-MM-DD". */
export function resolveIsoWeekStart(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new ConversationAuditError("fecha_invalida", "resolveIsoWeekStart recibió una fecha inválida");
  }
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=domingo .. 6=sábado
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

/** Ventana [inicio, fin) de 7 días completos que cubre la semana `weekOf`
 *  ("YYYY-MM-DD", se espera el lunes que devuelve `resolveIsoWeekStart`, pero esta
 *  función no lo exige -- solo exige una fecha válida). */
export function resolveAuditWindow(weekOf: string): { start: Date; end: Date } {
  const start = new Date(`${weekOf}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    throw new ConversationAuditError("week_of_invalido", `weekOf inválido: "${weekOf}" (se espera YYYY-MM-DD)`);
  }
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Hash determinístico (FNV-1a de 32 bits) de una cadena -- semilla del PRNG de abajo,
 *  nunca `Math.random()`. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** PRNG determinístico mulberry32: la misma semilla produce siempre la misma
 *  secuencia (a diferencia de `Math.random()`), condición necesaria para que la
 *  muestra semanal sea reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Selecciona hasta `sampleSize` ids de `candidateIds`, determinísticamente a partir de
 * `seed` (la capa de aplicación pasa `${hotelId}::${weekOf}`) -- Fisher-Yates parcial
 * con PRNG sembrado. Ids duplicados en la entrada se deduplican primero (defensivo) y
 * el pool se ordena antes de sortear, así el resultado no depende del orden en que la
 * query SQL entregó las filas -- mismo seed + mismo conjunto de ids siempre da la misma
 * muestra, sin importar el orden de llegada.
 */
export function selectWeeklyAuditSample(
  candidateIds: readonly string[],
  options: { seed: string; sampleSize?: number },
): string[] {
  const sampleSize = options.sampleSize ?? DEFAULT_WEEKLY_AUDIT_SAMPLE_SIZE;
  if (sampleSize <= 0) {
    throw new ConversationAuditError("sample_size_invalido", "sampleSize debe ser mayor a 0");
  }
  const pool = Array.from(new Set(candidateIds)).sort();
  if (pool.length <= sampleSize) return pool;

  const rng = mulberry32(hashSeed(options.seed));
  for (let i = 0; i < sampleSize; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, sampleSize).sort();
}

export interface AuditReviewInput {
  category: string;
  notes?: string | null;
}

export interface AuditReviewValidated {
  category: ConversationAuditCategory;
  notes: string | null;
}

/**
 * Valida la decisión de revisión de un ítem de la muestra: la categoría debe ser una
 * de las 6 reconocidas por REQ-HUE-007, y toda categoría de error real (todo menos
 * "ninguno") exige una nota no vacía que documente qué falló -- una auditoría que marca
 * "alucinacion" sin decir cuál no sirve para corregir nada (mismo criterio de "nota
 * obligatoria cuando hay algo que corregir" que `evaluateFolioClose`/discount
 * authorization ya aplican en otras partes de este dominio).
 */
export function assertValidAuditReview(input: AuditReviewInput): AuditReviewValidated {
  const category = input.category as ConversationAuditCategory;
  if (!(CONVERSATION_AUDIT_CATEGORIES as readonly string[]).includes(category)) {
    throw new ConversationAuditError(
      "categoria_invalida",
      `categoría de auditoría inválida: "${input.category}" (esperada una de: ${CONVERSATION_AUDIT_CATEGORIES.join(", ")})`,
    );
  }
  const notes = input.notes?.trim() ?? "";
  if (category !== "ninguno" && notes.length === 0) {
    throw new ConversationAuditError(
      "nota_requerida",
      `una revisión que marca un error ("${category}") debe incluir una nota que documente qué falló`,
    );
  }
  return { category, notes: notes.length > 0 ? notes : null };
}
