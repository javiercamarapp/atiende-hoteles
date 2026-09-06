// REQ-AGT-006 / GOB-035: PII debe redactarse ANTES de persistir cualquier traza de
// observabilidad de agentes. `redact()` es deliberadamente conservador (prefiere
// sobre-redactar antes que dejar pasar un dato personal) porque el costo de un falso
// positivo (un texto de traza un poco menos legible) es mucho menor que el de una fuga.
//
// Patrones cubiertos: email, telefono MX, CURP, RFC (persona fisica y moral),
// INE/documento de identidad tipo clave de elector, pasaporte mexicano y numero de
// tarjeta. Son patrones representativos para redaccion de trazas, NO validadores
// oficiales de esos documentos.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// 13-19 digitos, con o sin separadores (espacio/guion) cada 4: cubre la mayoria de
// numeros de tarjeta reales. Se evalua ANTES que telefono para no dejar residuos.
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

// aud-1 agentico.md CRITICO: CURP y RFC son los dos identificadores de huesped mas
// comunes en un flujo de check-in/facturacion hotelera mexicana y NO calzaban con
// ningun patron previo (INE exige 6 letras iniciales, el CURP tiene 4; el RFC no es
// puro digito como CARD_RE ni 1-letra+8-digitos como PASSPORT_RE). Se evaluan ANTES que
// INE/pasaporte (mas especificos, mismo rango de longitud) para no dejar residuos.
// Cada grupo puede llevar un separador opcional (espacio o guion) -- variante comun al
// transcribir el documento a mano.
const S = "[ -]?";
// CURP: 4 letras + 6 digitos (fecha) + sexo(H/M) + 2 letras (entidad) + 3 consonantes
// internas + 1 alfanumerico (homoclave) + 1 digito (diferenciador) = 18 caracteres.
const CURP_RE = new RegExp(
  `\\b[A-Z]{4}${S}\\d{6}${S}[HM]${S}[A-Z]{2}${S}[A-Z]{3}${S}[A-Z0-9]${S}\\d\\b`,
  "g",
);
// RFC persona fisica: 4 letras + 6 digitos + 3 alfanumericos (homoclave) = 13 caracteres.
const RFC_PERSONA_FISICA_RE = new RegExp(`\\b[A-Z&Ñ]{4}${S}\\d{6}${S}[A-Z0-9]{3}\\b`, "g");
// RFC persona moral: 3 letras + 6 digitos + 3 alfanumericos (homoclave) = 12 caracteres.
const RFC_PERSONA_MORAL_RE = new RegExp(`\\b[A-Z&Ñ]{3}${S}\\d{6}${S}[A-Z0-9]{3}\\b`, "g");

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
  // CURP antes que RFC: es mas largo/especifico (18 vs 12-13 caracteres) y comparte
  // prefijo (4 letras+6 digitos) con el RFC de persona fisica.
  out = out.replace(CURP_RE, "[CURP]");
  out = out.replace(RFC_PERSONA_FISICA_RE, "[RFC]");
  out = out.replace(RFC_PERSONA_MORAL_RE, "[RFC]");
  out = out.replace(INE_RE, "[INE]");
  out = out.replace(PASSPORT_RE, "[PASAPORTE]");
  out = out.replace(PHONE_MX_RE, (match) => {
    const digits = onlyDigits(match);
    return digits.length >= 10 ? "[TEL]" : match;
  });
  return out;
}
