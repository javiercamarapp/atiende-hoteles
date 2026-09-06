// REQ-REC-010: validación de MRZ (pasaporte/INE) por dígitos de control ICAO 9303.
import { describe, expect, it } from "vitest";
import { buildPassportMrz, computeMrzCheckDigit, InvalidMrzError, parsePassportMrz } from "../../../packages/domain-hotel/src/mrz.ts";

describe("computeMrzCheckDigit: aritmética ICAO 9303 (valores calculados a mano)", () => {
  it("dígitos '0'..'9' con un solo carácter usan peso 7: checkDigit = (valor*7) mod 10", () => {
    expect(computeMrzCheckDigit("0")).toBe(0);
    expect(computeMrzCheckDigit("1")).toBe(7);
    expect(computeMrzCheckDigit("5")).toBe(5); // 5*7=35 -> mod10=5
  });

  it("'<' vale 0 en cualquier posición", () => {
    expect(computeMrzCheckDigit("<")).toBe(0);
    expect(computeMrzCheckDigit("<<<")).toBe(0);
  });

  it("letras valen 10 (A) .. 35 (Z): 'A' con peso 7 -> (10*7) mod 10 = 0", () => {
    expect(computeMrzCheckDigit("A")).toBe(0);
    // 'B' = 11 -> 11*7=77 -> mod10=7
    expect(computeMrzCheckDigit("B")).toBe(7);
  });

  it("cadena de 2 caracteres usa pesos [7,3]: 'AB' = 10*7 + 11*3 = 70+33=103 -> mod10=3", () => {
    expect(computeMrzCheckDigit("AB")).toBe(3);
  });

  it("cadena de 4 caracteres repite el ciclo de pesos [7,3,1,7]: '1111' = 1*7+1*3+1*1+1*7=18 -> mod10=8", () => {
    expect(computeMrzCheckDigit("1111")).toBe(8);
  });

  it("rechaza un carácter fuera de [0-9A-Z<]", () => {
    expect(() => computeMrzCheckDigit("ñ")).toThrow(/caracter_mrz_invalido/);
  });
});

describe("buildPassportMrz + parsePassportMrz: round-trip válido", () => {
  const datosBase = {
    countryCode: "MEX",
    surname: "GARCIA LOPEZ",
    givenNames: "ANA MARIA",
    documentNumber: "G1234567",
    nationality: "MEX",
    birthDateYyMmDd: "900115",
    sex: "F" as const,
    expiryDateYyMmDd: "300520",
  };

  it("una MRZ construida con dígitos de control correctos se parsea sin error", () => {
    const { line1, line2 } = buildPassportMrz(datosBase);
    expect(line1).toHaveLength(44);
    expect(line2).toHaveLength(44);

    const parsed = parsePassportMrz(line1, line2);
    expect(parsed.documentType).toBe("pasaporte");
    expect(parsed.documentNumber).toBe("G1234567");
    expect(parsed.nationality).toBe("MEX");
    expect(parsed.fullName).toBe("ANA MARIA GARCIA LOPEZ");
    expect(parsed.sex).toBe("F");
    expect(parsed.birthDateYyMmDd).toBe("900115");
    expect(parsed.expiryDateYyMmDd).toBe("300520");
  });

  it("acepta minúsculas y espacios extra (normaliza antes de validar)", () => {
    const { line1, line2 } = buildPassportMrz(datosBase);
    const parsed = parsePassportMrz(`  ${line1.toLowerCase()}  `, `  ${line2.toLowerCase()}  `);
    expect(parsed.documentNumber).toBe("G1234567");
  });
});

describe("parsePassportMrz: RECHAZA cualquier dígito de control alterado (REQ-REC-010)", () => {
  const { line1, line2 } = buildPassportMrz({
    countryCode: "MEX",
    surname: "PEREZ",
    givenNames: "JUAN",
    documentNumber: "H7654321",
    nationality: "MEX",
    birthDateYyMmDd: "850101",
    sex: "M",
    expiryDateYyMmDd: "290101",
  });

  it("dígito de control del número de documento alterado -> InvalidMrzError", () => {
    const digitoOriginal = line2[9]!;
    const digitoAlterado = digitoOriginal === "0" ? "1" : "0";
    const line2Alterada = line2.slice(0, 9) + digitoAlterado + line2.slice(10);
    expect(() => parsePassportMrz(line1, line2Alterada)).toThrow(/digito_control_invalido_numero_documento/);
  });

  it("dígito de control compuesto final alterado -> InvalidMrzError", () => {
    const digitoOriginal = line2[43]!;
    const digitoAlterado = digitoOriginal === "0" ? "1" : "0";
    const line2Alterada = line2.slice(0, 43) + digitoAlterado;
    expect(() => parsePassportMrz(line1, line2Alterada)).toThrow(/digito_control_invalido_compuesto_final/);
  });

  it("un solo carácter del número de documento alterado (sin tocar el check digit) también se detecta", () => {
    const line2Alterada = "X" + line2.slice(1);
    expect(() => parsePassportMrz(line1, line2Alterada)).toThrow(InvalidMrzError);
  });

  it("longitud incorrecta es rechazada antes de intentar parsear campos", () => {
    expect(() => parsePassportMrz(line1.slice(0, 40), line2)).toThrow(/longitud_mrz_invalida/);
  });

  it("una línea 1 que no inicia con 'P' (tipo de documento no soportado) es rechazada", () => {
    const line1Invalida = "I" + line1.slice(1);
    expect(() => parsePassportMrz(line1Invalida, line2)).toThrow(/tipo_documento_no_soportado/);
  });
});
