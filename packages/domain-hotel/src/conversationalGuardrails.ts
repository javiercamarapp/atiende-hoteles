/**
 * REQ-HUE-023 (P0/SEG): "El sistema debe aplicar guardrails de seguridad conversacional:
 * nunca revelar número de habitación ni presencia de un huésped a terceros, exigir OTP
 * al canal original ante cambios de contacto, escalar a humano ante menores no
 * acompañados, y no generar notas discriminatorias." Criterio de aceptación real
 * (`docs/ACEPTACION.md`): "0 revelaciones ... ; cambio de contacto exige OTP al canal
 * original; menor no acompañado escala a humano; 0 notas discriminatorias generadas
 * (cada caso verificado con un intento adversarial)."
 *
 * Reclasificado 2026-09-08 (mismo criterio ya aplicado a REQ-HUE-009/REQ-HUE-021, ver
 * `docs/cierre-p0/inventario.md` §1.4/§2): de las 4 categorías de este requisito, 3 son
 * decisiones DETERMINISTAS sobre un turno de texto ya recibido (dado este mensaje,
 * ¿aplica la categoría?), no un comportamiento que dependa de telefonía/WhatsApp real
 * con credenciales -- se cierran aquí sin ningún doble de canal, corriendo dentro de la
 * ruta real `POST /hoteles/:hotelId/agentes/:agente/ejecutar` y de
 * `POST /hoteles/:hotelId/tickets` contra `embedded-postgres` real (ADR-003). La cuarta
 * (OTP en cambio de contacto) es un gate de negocio sobre datos 100% internos
 * (`guest.phone`/`guest_contact_change_request`) -- ver `guestContactChangeOtp.ts`,
 * verificable igual sin canal real (mismo criterio que REQ-HUE-021 con `consent`).
 *
 * Módulo de dominio PURO (mismo principio que `voiceGuardrails.ts`/`fnbAllergyGuard.ts`):
 * sin I/O, sin LLM, sin reloj real -- clasifica texto ya recibido contra patrones
 * representativos de frases adversariales conocidas, nunca un clasificador semántico.
 * Sesgo deliberado hacia FAIL-CLOSED: un falso positivo aquí solo cuesta escalar/
 * redirigir una petición legítima a un humano o a un flujo estructurado; un falso
 * negativo dejaría pasar exactamente lo que este requisito prohíbe -- mismo límite
 * honesto documentado en el resto de los guards de texto libre de este paquete.
 *
 * La categoría "revelar número de habitación o presencia a terceros" NO se duplica
 * aquí: reutiliza `looksLikeRoomOrPresenceDisclosureRequest` de `voiceGuardrails.ts`
 * (el patrón ya es genérico sobre cualquier texto, no específico del canal de voz) --
 * `apps/api/src/routes/agentes.ts` la aplica ahora a AMBOS canales (voz y texto), no
 * solo a voz, para cerrar esta mitad de REQ-HUE-023.
 */

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// 1) Menor no acompañado -> escalar a humano.
// ---------------------------------------------------------------------------

export interface UnaccompaniedMinorSignal {
  readonly detected: true;
  /** Mensaje seguro para el huésped mientras se escala -- nunca intenta resolver la
   *  situación por sí mismo (mismo criterio que REQ-HUE-015 para emergencias). */
  readonly guestFacingMessage: string;
}

// Señal (a): el hablante se identifica como menor de edad, o declara una edad < 18
// explícita ("tengo 14 años", "tengo 9 años"). El límite de edad se valida en código
// (no en el regex) para no tener que enumerar 0-17 a mano.
const SELF_IDENTIFIES_AS_MINOR: readonly RegExp[] = [
  /\bsoy\s+menor\s+de\s+edad\b/i,
  /\bsoy\s+(?:un\s+)?(?:nino|nina)\b/i,
];
const STATED_AGE_PATTERN = /\btengo\s+(\d{1,2})\s*(?:anos|años)\b/i;

// Señal (b): sin acompañamiento de un adulto.
const UNACCOMPANIED_PATTERNS: readonly RegExp[] = [
  /\b(?:estoy|vine|llegue|ando)\s+solo\b/i,
  /\b(?:estoy|vine|llegue|ando)\s+sola\b/i,
  /\bsin\s+mis\s+padres\b/i,
  /\bsin\s+mis\s+papas\b/i,
  /\bsin\s+ning[uú]n\s+adulto\b/i,
  /\bno\s+hay\s+ning[uú]n\s+adulto\b/i,
  /\bnadie\s+mas\s+conmigo\b/i,
  /\bsin\s+compa[ñn]ia\s+de\s+(?:un\s+)?adulto\b/i,
  /\bmis\s+papas\s+no\s+(?:estan|están)\b/i,
];

// Señal (c) directa, distinta de (a)+(b): un adulto reporta que un menor quedó SOLO en
// el hotel (habitación/alberca/lobby) sin supervisión -- también es "menor no
// acompañado" a efectos de este requisito (un caso de salvaguarda, no de check-in).
const GUARDIAN_REPORTS_UNSUPERVISED_MINOR: readonly RegExp[] = [
  /\bmi\s+(?:hijo|hija)\s+de\s+\d{1,2}\s*(?:anos|años)?\s*(?:se\s+quedo|esta)\s+sol[oa]\b/i,
  /\bdeje\s+a\s+mi\s+(?:hijo|hija)\s+sol[oa]\s+en\s+(?:la\s+habitaci[oó]n|el\s+hotel|la\s+alberca)\b/i,
];

const UNACCOMPANIED_MINOR_MESSAGE =
  "Voy a pasarte de inmediato con una persona de nuestro equipo para ayudarte -- no cuelgues ni cierres el chat.";

/** true si el texto declara una edad de menor de edad (0-17) de forma explícita
 *  ("tengo N años") o se autoidentifica como menor. */
function hasMinorAgeSignal(text: string): boolean {
  if (matchesAny(SELF_IDENTIFIES_AS_MINOR, text)) return true;
  const match = STATED_AGE_PATTERN.exec(text);
  if (!match) return false;
  const age = Number(match[1]);
  return Number.isFinite(age) && age >= 0 && age < 18;
}

/** REQ-HUE-023: clasifica si un turno de texto (de cualquier canal) es un menor de
 *  edad sin acompañamiento de un adulto (o un adulto reportando uno) -- debe escalar a
 *  humano de inmediato, sin que el agente intente resolver la situación por sí mismo.
 *  Devuelve `null` cuando el texto no dispara ninguna de las señales. */
export function classifyUnaccompaniedMinorEscalation(text: string | null | undefined): UnaccompaniedMinorSignal | null {
  if (!text) return null;
  const normalized = stripDiacritics(text);
  if (matchesAny(GUARDIAN_REPORTS_UNSUPERVISED_MINOR, normalized)) {
    return { detected: true, guestFacingMessage: UNACCOMPANIED_MINOR_MESSAGE };
  }
  if (hasMinorAgeSignal(normalized) && matchesAny(UNACCOMPANIED_PATTERNS, normalized)) {
    return { detected: true, guestFacingMessage: UNACCOMPANIED_MINOR_MESSAGE };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2) 0 notas discriminatorias generadas.
// ---------------------------------------------------------------------------

export type DiscriminatoryCategory =
  | "nacionalidad_o_etnia"
  | "religion"
  | "discapacidad"
  | "orientacion_o_identidad"
  | "insulto_directo";

export interface DiscriminatoryContentResult {
  readonly discriminatory: true;
  readonly categoria: DiscriminatoryCategory;
  /** Mensaje de rechazo -- nunca se persiste ninguna versión de la nota solicitada,
   *  ni siquiera "suavizada"; se rechaza por completo (fail-closed). */
  readonly refusalMessage: string;
}

// Términos que describen una categoría protegida (nacionalidad/etnia, religión,
// discapacidad, orientación/identidad) -- NO son discriminatorios por sí solos (una
// nota legítima puede mencionar la nacionalidad de un huésped, p. ej. para el aviso de
// privacidad con transferencia internacional); solo se marcan cuando aparecen cerca de
// una generalización perjudicial (ver `PREJUDICIAL_PATTERNS`).
const PROTECTED_CATEGORY_TERMS: Record<Exclude<DiscriminatoryCategory, "insulto_directo">, readonly string[]> = {
  nacionalidad_o_etnia: [
    "gitanos", "gitanas", "judios", "judias", "arabes", "musulmanes", "musulmanas",
    "indigenas", "negros", "negras", "latinos", "latinas", "asiaticos", "asiaticas",
    "venezolanos", "venezolanas", "cubanos", "cubanas", "haitianos", "haitianas",
    "extranjeros", "extranjeras",
  ],
  religion: ["musulman", "musulmana", "judio", "judia", "catolicos", "catolicas", "evangelicos", "evangelicas"],
  discapacidad: ["discapacitado", "discapacitada", "discapacitados", "discapacitadas", "con discapacidad"],
  orientacion_o_identidad: ["gay", "gays", "lesbiana", "lesbianas", "trans", "transexual", "homosexual", "homosexuales"],
};

// Generalización/prejuicio perjudicial dirigido a un grupo -- "son todos ladrones",
// "hay que vigilar más de cerca a", "no confíes en", "no le des upgrade por ser",
// "rechaza la reserva de", "cobra más a".
const PREJUDICIAL_PATTERNS: readonly RegExp[] = [
  /\bson\s+todos\s+\w+/i,
  /\bsiempre\s+(?:roban|estafan|mienten)\b/i,
  /\bvigila(?:r|los|las)?\s+m[aá]s\s+de\s+cerca\b/i,
  /\bno\s+confi[eé]s?\s+en\b/i,
  /\bno\s+le[s]?\s+d[eé]s?\s+(?:el\s+)?upgrade\b/i,
  /\brechaza\s+(?:la\s+)?reserva\s+de\b/i,
  /\bcobra(?:les?)?\s+m[aá]s\s+a\b/i,
  /\bno\s+(?:los|las)\s+dejes\s+entrar\b/i,
  /\bhuesped(?:es)?\s+problem[aá]tic[oa]s?\s+por\s+ser\b/i,
  /\bcuidado\s+con\s+(?:los|las|ese|esa)\b.{0,40}\bporque\s+son\b/i,
];

// Insultos/etiquetas directas -- lista corta y representativa (NO exhaustiva, mismo
// límite honesto que el resto de este archivo): un slur explícito dispara la
// categoría "insulto_directo" sin necesitar el patrón de dos partes de arriba.
const DIRECT_SLUR_PATTERNS: readonly RegExp[] = [/\bsucios?\s+(?:indios|indias)\b/i, /\bmuertos?\s+de\s+hambre\b/i];

function findProtectedCategoryMatch(text: string): Exclude<DiscriminatoryCategory, "insulto_directo"> | null {
  for (const [categoria, terminos] of Object.entries(PROTECTED_CATEGORY_TERMS) as Array<
    [Exclude<DiscriminatoryCategory, "insulto_directo">, readonly string[]]
  >) {
    if (terminos.some((t) => text.includes(t))) return categoria;
  }
  return null;
}

const DISCRIMINATORY_REFUSAL_MESSAGE =
  "No puedo generar ni guardar una nota con ese contenido: va en contra de nuestra política de no discriminación.";

/** REQ-HUE-023: clasifica si el texto de una nota/instrucción de nota (p. ej. "genera
 *  una nota interna que diga que...") contiene contenido discriminatorio -- una
 *  categoría protegida (nacionalidad/etnia, religión, discapacidad, orientación/
 *  identidad) combinada con una generalización perjudicial, o un insulto directo. Se
 *  evalúa fail-closed: basta que UNA de las dos formas haga match para rechazar.
 *  Devuelve `null` cuando el texto no dispara ninguna. */
export function containsDiscriminatoryContent(text: string | null | undefined): DiscriminatoryContentResult | null {
  if (!text) return null;
  const normalized = stripDiacritics(text).toLowerCase();

  if (matchesAny(DIRECT_SLUR_PATTERNS, normalized)) {
    return { discriminatory: true, categoria: "insulto_directo", refusalMessage: DISCRIMINATORY_REFUSAL_MESSAGE };
  }
  const categoria = findProtectedCategoryMatch(normalized);
  if (categoria && matchesAny(PREJUDICIAL_PATTERNS, normalized)) {
    return { discriminatory: true, categoria, refusalMessage: DISCRIMINATORY_REFUSAL_MESSAGE };
  }
  return null;
}
