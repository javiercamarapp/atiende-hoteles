/**
 * REQ-REC-010: "la bóveda de identidad debe validar el MRZ del pasaporte/INE por
 * dígitos de control antes de considerar el documento válido." Módulo de dominio
 * PURO (sin I/O, sin red): implementa el algoritmo de dígito de control ICAO 9303 y
 * el parseo/validación de la Zona de Lectura Mecánica (MRZ) formato TD3 (pasaporte,
 * dos líneas de 44 caracteres).
 *
 * Límite honesto de este módulo (REQ-UX-002 "nunca simular"): esto NO es OCR -- no
 * convierte una foto/imagen en texto. Recibe el TEXTO de la MRZ ya extraído (lo que
 * en producción produciría el servicio de OCR/MRZ dedicado y autoalojado de
 * REQ-AGT-013, todavía sin construir -- requiere infraestructura de reconocimiento de
 * imagen que este pase de cierre de P0 no puede añadir de forma verificable sin ese
 * servicio real) y hace la parte que SÍ es 100% determinista y verificable sin ninguna
 * dependencia externa: la aritmética de validación de dígitos de control, exactamente
 * como la exige el estándar ICAO 9303 Parte 4/5.
 */

export class InvalidMrzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMrzError";
  }
}

const MRZ_WEIGHTS = [7, 3, 1] as const;

function mrzCharValue(ch: string): number {
  if (ch === "<") return 0;
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55; // A=10 .. Z=35 (ICAO 9303)
  throw new InvalidMrzError(`caracter_mrz_invalido: "${ch}" no es 0-9, A-Z ni '<'.`);
}

/** Dígito de control ICAO 9303: suma de `valor(caracter) * peso` con pesos [7,3,1]
 *  cíclicos sobre la cadena, mod 10. */
export function computeMrzCheckDigit(field: string): number {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    sum += mrzCharValue(field[i]!) * MRZ_WEIGHTS[i % MRZ_WEIGHTS.length]!;
  }
  return sum % 10;
}

export interface ParsedPassportMrz {
  documentType: "pasaporte";
  /** Sin los rellenos `<` -- el número de documento real. */
  documentNumber: string;
  /** Código de país ISO 3166-1 alpha-3 tal como aparece en la MRZ. */
  nationality: string;
  fullName: string;
  /** YYMMDD tal como aparece en la MRZ (sin resolver el siglo -- ambiguo por diseño
   *  del estándar; quien lo consuma decide la regla de siglo, no este parser). */
  birthDateYyMmDd: string;
  sex: "M" | "F" | "X";
  expiryDateYyMmDd: string;
}

function verificarDigito(field: string, checkChar: string, nombre: string): void {
  const esperado = computeMrzCheckDigit(field);
  if (String(esperado) !== checkChar) {
    throw new InvalidMrzError(
      `digito_control_invalido_${nombre}: esperado ${esperado}, recibido "${checkChar}" para el campo "${field}".`,
    );
  }
}

/**
 * Parsea y valida (por dígitos de control) una MRZ TD3 (pasaporte, ICAO 9303 Parte 4).
 * Lanza `InvalidMrzError` ante CUALQUIER dígito de control que no cuadre -- nunca
 * devuelve datos de un documento cuya MRZ no pasó la validación (REQ-REC-010).
 */
export function parsePassportMrz(line1: string, line2: string): ParsedPassportMrz {
  const l1 = line1.trim().toUpperCase();
  const l2 = line2.trim().toUpperCase();

  if (l1.length !== 44 || l2.length !== 44) {
    throw new InvalidMrzError(`longitud_mrz_invalida: cada línea TD3 debe tener 44 caracteres (recibido ${l1.length}/${l2.length}).`);
  }
  if (l1[0] !== "P") {
    throw new InvalidMrzError('tipo_documento_no_soportado: solo TD3 (pasaporte, línea 1 inicia con "P") está implementado.');
  }

  // Línea 1: P<CCC APELLIDOS<<NOMBRES<<<<<<<<<<<<<<<<<<<<<<<<<<<<
  const namesRaw = l1.slice(5, 44); // 39 caracteres tras "P<CCC"
  const separatorIdx = namesRaw.indexOf("<<");
  const surnamePart = separatorIdx === -1 ? namesRaw : namesRaw.slice(0, separatorIdx);
  const givenPart = separatorIdx === -1 ? "" : namesRaw.slice(separatorIdx + 2);
  const surname = surnamePart.replace(/</g, " ").trim();
  const givenNames = givenPart.replace(/</g, " ").trim();
  const fullName = [givenNames, surname].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

  // Línea 2, layout fijo TD3 (ICAO 9303 Parte 4 §4.2.2).
  const documentNumberField = l2.slice(0, 9);
  const documentNumberCheck = l2[9]!;
  const nationality = l2.slice(10, 13);
  const birthDate = l2.slice(13, 19);
  const birthDateCheck = l2[19]!;
  const sexChar = l2[20]!;
  const expiryDate = l2.slice(21, 27);
  const expiryDateCheck = l2[27]!;
  const personalNumberField = l2.slice(28, 42);
  const personalNumberCheck = l2[42]!;
  const finalCheckChar = l2[43]!;

  verificarDigito(documentNumberField, documentNumberCheck, "numero_documento");
  verificarDigito(birthDate, birthDateCheck, "fecha_nacimiento");
  verificarDigito(expiryDate, expiryDateCheck, "fecha_expiracion");
  verificarDigito(personalNumberField, personalNumberCheck, "numero_personal");

  const compuesto =
    documentNumberField + documentNumberCheck + birthDate + birthDateCheck + expiryDate + expiryDateCheck + personalNumberField + personalNumberCheck;
  verificarDigito(compuesto, finalCheckChar, "compuesto_final");

  const documentNumber = documentNumberField.replace(/</g, "");
  if (documentNumber.length === 0) {
    throw new InvalidMrzError("numero_documento_vacio: el campo de número de documento no puede estar vacío.");
  }
  const sex: ParsedPassportMrz["sex"] = sexChar === "M" ? "M" : sexChar === "F" ? "F" : "X";

  return {
    documentType: "pasaporte",
    documentNumber,
    nationality,
    fullName,
    birthDateYyMmDd: birthDate,
    sex,
    expiryDateYyMmDd: expiryDate,
  };
}

/**
 * Construye una MRZ TD3 VÁLIDA (dígitos de control calculados con
 * `computeMrzCheckDigit`, nunca hardcodeados) a partir de campos ya normalizados --
 * usado por pruebas y por cualquier generador de datos de desarrollo/fixtures, nunca
 * en el camino de validación real (que siempre exige que el dígito de control YA
 * venga correcto en el texto recibido).
 */
export function buildPassportMrz(input: {
  countryCode: string;
  surname: string;
  givenNames: string;
  documentNumber: string;
  nationality: string;
  birthDateYyMmDd: string;
  sex: "M" | "F" | "X";
  expiryDateYyMmDd: string;
  personalNumber?: string;
}): { line1: string; line2: string } {
  const pad = (s: string, len: number) => (s + "<".repeat(len)).slice(0, len);

  const surnameMrz = input.surname.toUpperCase().replace(/[^A-Z<]/g, "<").replace(/\s+/g, "<");
  const givenMrz = input.givenNames.toUpperCase().replace(/[^A-Z<]/g, "<").replace(/\s+/g, "<");
  const line1 = pad(`P<${pad(input.countryCode, 3)}${surnameMrz}<<${givenMrz}`, 44);

  const documentNumberField = pad(input.documentNumber.toUpperCase(), 9);
  const documentNumberCheck = computeMrzCheckDigit(documentNumberField);
  const nationality = pad(input.nationality.toUpperCase(), 3);
  const birthDate = pad(input.birthDateYyMmDd, 6);
  const birthDateCheck = computeMrzCheckDigit(birthDate);
  const expiryDate = pad(input.expiryDateYyMmDd, 6);
  const expiryDateCheck = computeMrzCheckDigit(expiryDate);
  const personalNumberField = pad(input.personalNumber ?? "", 14);
  const personalNumberCheck = computeMrzCheckDigit(personalNumberField);

  const compuesto =
    documentNumberField + documentNumberCheck + birthDate + birthDateCheck + expiryDate + expiryDateCheck + personalNumberField + personalNumberCheck;
  const finalCheck = computeMrzCheckDigit(compuesto);

  const line2 = `${documentNumberField}${documentNumberCheck}${nationality}${birthDate}${birthDateCheck}${input.sex}${expiryDate}${expiryDateCheck}${personalNumberField}${personalNumberCheck}${finalCheck}`;

  return { line1, line2 };
}
