// REQ-CRM-002 (P1/F): clasificador de reseñas/encuestas por TEMA + SENTIMIENTO, y
// decisión de la acción reglada correspondiente (ticket de mantenimiento, mensaje
// proactivo, compensación reglada). Confirmado por grep antes de este archivo: no
// existía ningún clasificador de reseñas/sentimiento en el repositorio.
//
// Deterministico y PURO (sin I/O, mismo principio que fraude/deteccion.ts): nada aquí
// llama a un LLM ni a un servicio de terceros -- el criterio de REQUISITOS.md declara
// la dependencia de este requisito como "ninguna", y REQ-CRM-001 (el inbox real de
// Google/Booking/TripAdvisor) sigue "pendiente-credenciales" -- este módulo clasifica
// CUALQUIER texto de reseña/encuesta que ya llegó al sistema (por el canal que sea,
// hoy típicamente una encuesta propia capturada por el staff), sin fabricar ni asumir
// esa integración pendiente.
//
// "Temas locales no entrenados previamente" (parte explícita del criterio de
// aceptación): en vez de requerir una lista cerrada de temas o un modelo entrenado,
// `detectarTemas` primero busca el diccionario base (+ el diccionario propio que cada
// hotel puede configurar, `temasLocalesConfigurados`, para temas ya vistos antes) y
// SIEMPRE intenta además un descubrimiento heurístico: cualquier palabra de contenido
// (no genérica) que aparece cerca de una palabra con carga de sentimiento y que ningún
// tema conocido/configurado ya cubrió se reporta como un tema local nuevo
// (`local:<palabra>`, `esConocido: false`) -- exactamente el caso "sargazo" antes de
// que alguien lo hubiera agregado nunca a ningún diccionario, generalizado a
// cualquier palabra nueva (una plaga local, un olor, una obra de construcción vecina).

const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o", "u", "en", "a", "al",
  "del", "que", "con", "por", "para", "se", "su", "sus", "es", "fue", "fueron", "era", "eran",
  "muy", "mas", "pero", "nos", "no", "si", "lo", "le", "les", "este", "esta", "esto", "eso",
  "esa", "esas", "esos", "estos", "como", "cuando", "donde", "porque", "tambien", "todo",
  "toda", "todos", "todas", "hay", "habia", "estaba", "estuvo", "estan", "son", "ser", "estar",
  "nuestra", "nuestro", "nuestros", "nuestras", "mi", "mis", "tu", "tus", "yo", "usted",
  "ustedes", "ellos", "ellas", "nosotros", "algo", "nada", "sin", "sobre", "entre", "durante",
  "hasta", "desde", "solo", "solamente", "bien", "mal", "mucho", "muchos", "muchas", "poco",
  "pocos", "pocas", "vez", "veces", "dia", "dias", "noche", "noches", "hotel", "cuarto",
  "cuartos", "habitacion", "habitaciones", "vacaciones", "viaje", "estadia", "estancia",
  "todo", "hicimos", "fuimos", "tuvimos", "tenia", "tenian",
]);

// ---------------------------------------------------------------------------
// 1) Detección de temas.
// ---------------------------------------------------------------------------

export const KNOWN_REVIEW_TOPICS = [
  "limpieza",
  "personal",
  "ubicacion",
  "wifi",
  "ruido",
  "aire_acondicionado",
  "desayuno",
  "check_in",
  "precio",
  "sargazo",
  "alberca",
  "seguridad",
] as const;
export type KnownReviewTopic = (typeof KNOWN_REVIEW_TOPICS)[number];

/** Un tema "local" (no entrenado previamente) siempre trae el prefijo `local:` para
 *  que nunca pueda colisionar por accidente con un `KnownReviewTopic` real, y para que
 *  REQ-CRM-003 (conteo de menciones repetidas del MISMO tema) pueda seguir agrupando
 *  por esta cadena estable aunque el tema nunca se haya visto antes de esta reseña. */
export type ReviewTopicId = KnownReviewTopic | `local:${string}`;

/** Diccionario base -- entradas de una sola palabra o frase corta, todas ya
 *  normalizadas (ver `normalizar`, sin acentos ni mayúsculas) porque `detectarTemas`
 *  compara siempre contra texto normalizado. */
export const TOPIC_KEYWORDS: Record<KnownReviewTopic, readonly string[]> = {
  limpieza: ["limpieza", "limpio", "limpia", "sucio", "sucia", "suciedad", "polvo", "manchado", "manchada", "moho", "cochambre", "asqueroso", "asquerosa"],
  personal: ["personal", "staff", "recepcionista", "recepcionistas", "empleado", "empleada", "empleados", "mesero", "meseros", "mesera", "camarista", "camarero", "trato", "atencion", "grosero", "grosera", "descortes"],
  ubicacion: ["ubicacion", "ubicado", "ubicada", "zona", "distancia", "alejado", "alejada", "céntrico", "centrico"],
  wifi: ["wifi", "wi-fi", "internet", "conexion", "señal"],
  ruido: ["ruido", "ruidoso", "ruidosa", "bulla", "escandalo", "insonorizacion", "insonorizado"],
  aire_acondicionado: ["aire acondicionado", "climatizacion", "minisplit", "clima", "ac"],
  desayuno: ["desayuno", "buffet", "desayunar"],
  check_in: ["check-in", "checkin", "check in", "registro de entrada"],
  precio: ["precio", "precios", "caro", "cara", "costoso", "costosa", "tarifa", "sobreprecio", "carisimo", "carisima"],
  sargazo: ["sargazo", "sargazos", "algas"],
  alberca: ["alberca", "piscina", "pool"],
  seguridad: ["seguridad", "robo", "robaron", "inseguro", "insegura", "vigilancia"],
};

/** Temas de REQ-CRM-002 que corresponden a un defecto FÍSICO/operativo reparable --
 *  solo estos disparan `ticket_mantenimiento` (un tema como "precio" o "personal" no
 *  se arregla con un ticket de mantenimiento). */
export const TICKET_TOPICS: ReadonlySet<ReviewTopicId> = new Set<ReviewTopicId>([
  "limpieza",
  "wifi",
  "ruido",
  "aire_acondicionado",
  "alberca",
]);

export interface TopicMatch {
  topic: ReviewTopicId;
  /** `false` para un tema descubierto por heurística (nunca antes en el diccionario
   *  base ni en `temasLocalesConfigurados`) -- REQ-CRM-002: "temas locales no
   *  entrenados previamente". */
  esConocido: boolean;
  menciones: number;
  palabrasClave: string[];
}

/** Quita acentos/diacríticos y normaliza a minúsculas -- toda comparación de este
 *  módulo (temas, sentimiento) corre sobre este texto normalizado, nunca sobre el
 *  texto crudo, para que "Wifi", "WIFI" o "wifí" sean el mismo token. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Tokeniza en palabras Unicode (letras/números), descartando puntuación. */
function tokenizar(textoNormalizado: string): string[] {
  return textoNormalizado.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function contarOcurrencias(textoNormalizado: string, frase: string): number {
  if (frase.includes(" ") || frase.includes("-")) {
    // Frase de más de una palabra (p.ej. "aire acondicionado", "check-in"): cuenta
    // apariciones literales de la subcadena, ya que tokenizar por palabra unica
    // perdería el espacio/guion que la distingue de sus palabras sueltas.
    const escaped = frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = textoNormalizado.match(new RegExp(escaped, "g"));
    return matches ? matches.length : 0;
  }
  const escaped = frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = textoNormalizado.match(new RegExp(`\\b${escaped}\\b`, "g"));
  return matches ? matches.length : 0;
}

/**
 * Detecta los temas de una reseña/encuesta: primero el diccionario base
 * (`TOPIC_KEYWORDS`) y cualquier diccionario propio del hotel (`temasLocalesConfigurados`,
 * temas ya vistos antes y ahora "entrenados" para ese hotel), y SIEMPRE, además,
 * un descubrimiento heurístico de temas nunca vistos (REQ-CRM-002: "temas locales no
 * entrenados previamente") -- una palabra de contenido cerca de una palabra con carga
 * de sentimiento que ningún tema ya cubrió.
 */
export function detectarTemas(
  texto: string,
  temasLocalesConfigurados: Record<string, readonly string[]> = {},
): TopicMatch[] {
  const normalizado = normalizar(texto);
  const matches: TopicMatch[] = [];
  const palabrasCubiertas = new Set<string>();

  const diccionarios: [string, readonly string[], boolean][] = [
    ...KNOWN_REVIEW_TOPICS.map((t): [string, readonly string[], boolean] => [t, TOPIC_KEYWORDS[t], true]),
    ...Object.entries(temasLocalesConfigurados).map((e): [string, readonly string[], boolean] => [`local:${e[0]}`, e[1], true]),
  ];

  for (const [topic, keywords, esConocido] of diccionarios) {
    const palabrasEncontradas: string[] = [];
    let menciones = 0;
    for (const kw of keywords) {
      const kwNorm = normalizar(kw);
      const n = contarOcurrencias(normalizado, kwNorm);
      if (n > 0) {
        menciones += n;
        palabrasEncontradas.push(kw);
        for (const tok of tokenizar(kwNorm)) palabrasCubiertas.add(tok);
      }
    }
    if (menciones > 0) {
      matches.push({ topic: topic as ReviewTopicId, esConocido, menciones, palabrasClave: palabrasEncontradas });
    }
  }

  // Descubrimiento de temas locales no entrenados: para cada palabra con carga de
  // sentimiento (positiva o negativa, ver §2), toda la ORACIÓN que la contiene aporta
  // candidatos -- una reseña real suele nombrar el tema al inicio de la oración y la
  // emoción al final (o viceversa), así que una ventana fija de tokens pierde casos
  // reales; dividir por puntuación fuerte evita ese límite artificial de distancia.
  // Tope de 3 temas nuevos por reseña para no generar ruido en reseñas largas.
  const candidatosVistos = new Set<string>();
  for (const oracion of normalizado.split(/[.!?;¡¿\n]+/)) {
    const tokensOracion = tokenizar(oracion);
    const tieneSentimiento = tokensOracion.some((t) => t in NEGATIVE_WORDS || t in POSITIVE_WORDS);
    if (!tieneSentimiento) continue;
    for (const candidato of tokensOracion) {
      if (candidato.length < 4) continue;
      if (STOPWORDS.has(candidato)) continue;
      if (candidato in NEGATIVE_WORDS || candidato in POSITIVE_WORDS) continue;
      if (NEGATION_WORDS.has(candidato) || candidato in INTENSIFIERS) continue;
      if (palabrasCubiertas.has(candidato)) continue;
      candidatosVistos.add(candidato);
    }
  }
  const nuevosTemas = [...candidatosVistos]
    .map((palabra): [string, number] => [palabra, contarOcurrencias(normalizado, palabra)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [palabra, menciones] of nuevosTemas) {
    matches.push({ topic: `local:${palabra}`, esConocido: false, menciones, palabrasClave: [palabra] });
  }

  return matches;
}

// ---------------------------------------------------------------------------
// 2) Análisis de sentimiento.
// ---------------------------------------------------------------------------

export type SentimentLabel = "muy_negativo" | "negativo" | "neutral" | "positivo" | "muy_positivo";

export interface SentimentResult {
  etiqueta: SentimentLabel;
  /** -1 (lo peor posible) .. 1 (lo mejor posible). */
  puntaje: number;
}

const NEGATION_WORDS = new Set(["no", "nunca", "jamas", "tampoco", "ni"]);

const INTENSIFIERS: Record<string, number> = {
  muy: 1.4,
  super: 1.5,
  sumamente: 1.6,
  extremadamente: 1.7,
  bastante: 1.25,
  demasiado: 1.35,
  totalmente: 1.4,
  completamente: 1.4,
};

const POSITIVE_WORDS: Record<string, number> = {
  excelente: 2, excelentes: 2, increible: 2, increibles: 2, genial: 1.5, geniales: 1.5,
  comodo: 1, comoda: 1, comodos: 1, comodas: 1, agradable: 1, agradables: 1,
  amable: 1.2, amables: 1.2, delicioso: 1.2, deliciosa: 1.2, deliciosos: 1.2, deliciosas: 1.2,
  recomendable: 1.5, recomiendo: 1.5, bonito: 1, bonita: 1, perfecto: 2, perfecta: 2,
  bueno: 1, buena: 1, buenos: 1, buenas: 1, satisfecho: 1.3, satisfecha: 1.3,
  tranquilo: 1, tranquila: 1, impecable: 1.8, impecables: 1.8, maravilloso: 1.8, maravillosa: 1.8,
  espectacular: 1.8, espectaculares: 1.8, feliz: 1.3, felices: 1.3, encanto: 1.2, encanta: 1.3,
  hermoso: 1.3, hermosa: 1.3, hermosos: 1.3, hermosas: 1.3, bien: 0.8,
};

const NEGATIVE_WORDS: Record<string, number> = {
  sucio: 1.5, sucia: 1.5, sucios: 1.5, sucias: 1.5, ruidoso: 1.3, ruidosa: 1.3,
  terrible: 2, terribles: 2, pesimo: 2, pesima: 2, pesimos: 2, pesimas: 2,
  malo: 1, mala: 1, malos: 1, malas: 1, horrible: 2, horribles: 2,
  asqueroso: 2, asquerosa: 2, lento: 1, lenta: 1, caro: 1, cara: 1, carisimo: 1.5, carisima: 1.5,
  roto: 1.3, rota: 1.3, descompuesto: 1.3, descompuesta: 1.3, incomodo: 1.2, incomoda: 1.2,
  grosero: 1.5, grosera: 1.5, desagradable: 1.3, decepcionante: 1.5, decepcionado: 1.3,
  decepcionada: 1.3, apestoso: 1.5, apestosa: 1.5, infestado: 1.8, infestada: 1.8,
  plaga: 1.6, queja: 1, problema: 1, problemas: 1.1, pesadilla: 1.9,
  miedo: 1.2, asco: 1.6, decepcion: 1.6, molesto: 1.1, molesta: 1.1, peligroso: 1.5, peligrosa: 1.5, mal: 0.9,
  // "nunca"/"jamas" son EXCLUSIVAMENTE palabras de negación (ver NEGATION_WORDS) --
  // nunca entran aquí como palabra de carga propia, para no puntuar dos veces.
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Analiza el sentimiento de un texto libre (español) con un léxico ponderado que
 * maneja negación ("no", "nunca"... invierte el signo de la palabra que sigue, ventana
 * de 3 tokens) e intensificadores ("muy", "super"... multiplica la magnitud, ventana
 * de 2 tokens). Si se provee una `calificacion` (1-5 estrellas), se combina en partes
 * iguales con el puntaje léxico -- una reseña de 5 estrellas con texto breve y neutro
 * sigue siendo positiva, y viceversa.
 */
export function analizarSentimiento(texto: string, calificacion?: number): SentimentResult {
  // La ventana de negación/intensificador SOLO busca dentro de la misma cláusula (se
  // parte el texto por comas y puntuación fuerte) -- sin este límite, "no puedo
  // dormir, pésimo" invertía "pésimo" por el "no" de la cláusula anterior, que en
  // realidad negaba "puedo" y no tenía nada que ver con la segunda cláusula.
  const clausulas = normalizar(texto)
    .split(/[.,;:!?¡¿\n]+/)
    .map((c) => tokenizar(c));

  let suma = 0;
  let coincidencias = 0;

  for (const tokens of clausulas) {
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      let peso = 0;
      if (tok in NEGATIVE_WORDS) peso = -NEGATIVE_WORDS[tok]!;
      else if (tok in POSITIVE_WORDS) peso = POSITIVE_WORDS[tok]!;
      if (peso === 0) continue;
      coincidencias++;

      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        if (NEGATION_WORDS.has(tokens[j]!)) {
          peso = -peso;
          break;
        }
      }
      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        const factor = INTENSIFIERS[tokens[j]!];
        if (factor) {
          peso *= factor;
          break;
        }
      }
      suma += peso;
    }
  }

  const puntajeLexico = coincidencias === 0 ? 0 : clamp(Math.tanh(suma / 2.5), -1, 1);
  const puntajeCalificacion = calificacion != null ? clamp((calificacion - 3) / 2, -1, 1) : null;

  let puntaje: number;
  if (coincidencias === 0 && puntajeCalificacion == null) puntaje = 0;
  else if (coincidencias === 0) puntaje = puntajeCalificacion!;
  else if (puntajeCalificacion == null) puntaje = puntajeLexico;
  else puntaje = 0.5 * puntajeLexico + 0.5 * puntajeCalificacion;

  let etiqueta: SentimentLabel;
  if (puntaje <= -0.6) etiqueta = "muy_negativo";
  else if (puntaje <= -0.2) etiqueta = "negativo";
  else if (puntaje < 0.2) etiqueta = "neutral";
  else if (puntaje < 0.6) etiqueta = "positivo";
  else etiqueta = "muy_positivo";

  return { etiqueta, puntaje: Math.round(puntaje * 1000) / 1000 };
}

// ---------------------------------------------------------------------------
// 3) Decisión de acción (ticket / mensaje proactivo / compensación reglada).
// ---------------------------------------------------------------------------

export type StayState = "en_estancia" | "post_estancia" | "desconocido";

export interface CompensacionPropuesta {
  tipo: "credito_fnb" | "descuento_noche" | "late_checkout";
  valor: number;
  unidad: "monto_mxn" | "porcentaje" | "aplicacion";
}

/** Tabla RE­GLADA (no discrecional, REQ-CRM-002: "compensación reglada") -- solo los
 *  temas más severos y objetivamente verificables tienen una compensación
 *  preconfigurada; el resto de los temas nunca dispara `compensacion_reglada`. */
export const COMPENSATION_CATALOG: Partial<Record<KnownReviewTopic, CompensacionPropuesta>> = {
  sargazo: { tipo: "credito_fnb", valor: 300, unidad: "monto_mxn" },
  aire_acondicionado: { tipo: "descuento_noche", valor: 15, unidad: "porcentaje" },
  ruido: { tipo: "descuento_noche", valor: 10, unidad: "porcentaje" },
  limpieza: { tipo: "credito_fnb", valor: 200, unidad: "monto_mxn" },
};

export type AccionReputacion =
  | {
      tipo: "ticket_mantenimiento";
      tema: ReviewTopicId;
      severidad: "alta" | "media";
      titulo: string;
      descripcion: string;
      razon: string;
    }
  | {
      tipo: "mensaje_proactivo";
      mensajeSugerido: string;
      razon: string;
    }
  | {
      tipo: "compensacion_reglada";
      tema: ReviewTopicId;
      compensacion: CompensacionPropuesta;
      razon: string;
    };

export interface DecidirAccionesInput {
  texto: string;
  temas: TopicMatch[];
  sentimiento: SentimentResult;
  estanciaEstado: StayState;
  /** `null`/`undefined` cuando la reseña no está ligada a un huésped identificado
   *  (p.ej. una reseña pública de una OTA sin match a una reserva) -- sin huésped no
   *  hay a quién escribirle ni a quién compensar. */
  huespedId?: string | null;
}

const NEGATIVOS: ReadonlySet<SentimentLabel> = new Set(["negativo", "muy_negativo"]);

/**
 * Decide, de forma determinista, qué acción(es) dispara una clasificación ya hecha
 * (REQ-CRM-002: "disparando la acción correspondiente: ticket, mensaje proactivo,
 * compensación reglada"). Puede devolver más de una acción (p.ej. un problema de aire
 * acondicionado severo durante la estancia dispara TICKET + mensaje proactivo), o
 * ninguna (reseña neutra/positiva, o negativa sin huésped identificado al que
 * contactar/compensar).
 */
export function decidirAcciones(input: DecidirAccionesInput): AccionReputacion[] {
  const acciones: AccionReputacion[] = [];
  const esNegativo = NEGATIVOS.has(input.sentimiento.etiqueta);
  const esMuyNegativo = input.sentimiento.etiqueta === "muy_negativo";

  if (esNegativo) {
    for (const tema of input.temas) {
      if (!TICKET_TOPICS.has(tema.topic)) continue;
      acciones.push({
        tipo: "ticket_mantenimiento",
        tema: tema.topic,
        severidad: esMuyNegativo ? "alta" : "media",
        titulo: `Queja de huésped en reseña/encuesta: ${tema.topic}`,
        descripcion: input.texto,
        razon:
          `El tema "${tema.topic}" tuvo sentimiento ${input.sentimiento.etiqueta} ` +
          `(${tema.menciones} mención(es) en el texto) -- corresponde a un defecto operativo/físico reparable.`,
      });
    }
  }

  if (esNegativo && input.estanciaEstado === "en_estancia" && input.huespedId) {
    acciones.push({
      tipo: "mensaje_proactivo",
      mensajeSugerido:
        "Notamos que tu experiencia hasta ahora no ha sido la esperada. Un miembro de nuestro equipo " +
        "te contactará en breve para resolverlo antes de tu salida.",
      razon:
        `Huésped identificado, todavía en estancia, con sentimiento ${input.sentimiento.etiqueta}: ` +
        "hay oportunidad real de recuperar la experiencia antes de que se vaya o publique la reseña.",
    });
  }

  if (esMuyNegativo && input.huespedId) {
    for (const tema of input.temas) {
      if (!tema.esConocido) continue;
      const compensacion = COMPENSATION_CATALOG[tema.topic as KnownReviewTopic];
      if (!compensacion) continue;
      acciones.push({
        tipo: "compensacion_reglada",
        tema: tema.topic,
        compensacion,
        razon:
          `El tema "${tema.topic}" con sentimiento muy_negativo cae en la tabla reglada de compensación ` +
          "(no discrecional): aplica automáticamente la compensación configurada para ese tema.",
      });
    }
  }

  return acciones;
}

// ---------------------------------------------------------------------------
// 4) Punto de entrada combinado.
// ---------------------------------------------------------------------------

export interface ClasificarResenaInput {
  texto: string;
  calificacion?: number;
  estanciaEstado?: StayState;
  huespedId?: string | null;
  /** Temas propios del hotel ya "entrenados" en corridas anteriores (p.ej. un tema
   *  local descubierto la primera vez se puede promover aquí para que las siguientes
   *  menciones ya lleguen como `esConocido: true` con el mismo id estable). */
  temasLocalesConfigurados?: Record<string, readonly string[]>;
}

export interface ResultadoClasificacion {
  temas: TopicMatch[];
  sentimiento: SentimentResult;
  acciones: AccionReputacion[];
}

/** Clasifica una reseña/encuesta completa: temas (conocidos + locales descubiertos),
 *  sentimiento, y las acciones regladas que corresponde disparar. Punto de entrada
 *  único que usa `apps/api/src/routes/reputacion.ts`. */
export function clasificarResena(input: ClasificarResenaInput): ResultadoClasificacion {
  const temas = detectarTemas(input.texto, input.temasLocalesConfigurados ?? {});
  const sentimiento = analizarSentimiento(input.texto, input.calificacion);
  const acciones = decidirAcciones({
    texto: input.texto,
    temas,
    sentimiento,
    estanciaEstado: input.estanciaEstado ?? "desconocido",
    huespedId: input.huespedId ?? null,
  });
  return { temas, sentimiento, acciones };
}
