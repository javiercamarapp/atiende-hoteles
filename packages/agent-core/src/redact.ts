// REQ-AGT-006 / GOB-035: PII debe redactarse ANTES de persistir cualquier traza de
// observabilidad de agentes. `redact()` es deliberadamente conservador (prefiere
// sobre-redactar antes que dejar pasar un dato personal) porque el costo de un falso
// positivo (un texto de traza un poco menos legible) es mucho menor que el de una fuga.
//
// Patrones cubiertos: email, telefono MX, INE/documento de identidad tipo clave de
// elector, pasaporte mexicano y numero de tarjeta. Son patrones representativos para
// redaccion de trazas, NO validadores oficiales de esos documentos.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// 13-19 digitos, con o sin separadores (espacio/guion) cada 4: cubre la mayoria de
// numeros de tarjeta reales. Se evalua ANTES que telefono para no dejar residuos.
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

// INE / clave de elector y codigos de identidad gubernamentales similares: 18
// caracteres alfanumericos en mayuscula con la forma tipica 6 letras + 6 digitos + 6
// alfanumericos. Patron representativo, no un validador oficial de INE.
const INE_RE = /\b[A-Z]{6}\d{6}[A-Z0-9]{6}\b/g;

// Pasaporte mexicano: 1 letra + 8 digitos.
const PASSPORT_RE = /\b[A-Z]\d{8}\b/g;

// Telefono MX: 10 digitos nacionales, con lada opcional +52/52/01 y separadores comunes
// (espacio, guion, parentesis).
const PHONE_MX_RE = /(?:\+?52[\s.-]?)?(?:01[\s.-]?)?\(?\d{2,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g;

function onlyDigits(value: string): string {
  return value.replace(/[^\d]/g, "");
}

export function redact(text: string): string {
  if (!text) return text;

  let out = text;
  out = out.replace(EMAIL_RE, "[EMAIL]");
  out = out.replace(CARD_RE, (match) => {
    const digits = onlyDigits(match);
    return digits.length >= 13 && digits.length <= 19 ? "[TARJETA]" : match;
  });
  out = out.replace(INE_RE, "[INE]");
  out = out.replace(PASSPORT_RE, "[PASAPORTE]");
  out = out.replace(PHONE_MX_RE, (match) => {
    const digits = onlyDigits(match);
    return digits.length >= 10 ? "[TEL]" : match;
  });
  return out;
}
