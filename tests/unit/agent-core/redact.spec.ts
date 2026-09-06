// REQ-AGT-006 / GOB-035: PII redactada antes de persistir cualquier traza.
import { describe, expect, it } from "vitest";
import { redact } from "@atiende-hoteles/agent-core";

describe("redact", () => {
  it("redacta un email", () => {
    expect(redact("contacto: ana.perez@example.com por favor")).toBe("contacto: [EMAIL] por favor");
  });

  it("redacta un telefono MX de 10 digitos sin separadores", () => {
    expect(redact("llamame al 5512345678 hoy")).toBe("llamame al [TEL] hoy");
  });

  it("redacta un telefono MX con lada +52 y separadores", () => {
    expect(redact("tel +52 55 1234 5678")).toBe("tel [TEL]");
  });

  it("redacta un numero de tarjeta de 16 digitos agrupado en bloques de 4", () => {
    expect(redact("tarjeta 4111 1111 1111 1111 vence en dic")).toBe("tarjeta [TARJETA] vence en dic");
  });

  it("redacta un numero de tarjeta de 16 digitos sin separadores", () => {
    expect(redact("numero 4111111111111111 guardado")).toBe("numero [TARJETA] guardado");
  });

  it("redacta un codigo tipo INE (18 alfanumericos)", () => {
    expect(redact("documento ABCDEF800101GH12Z9 recibido")).toBe("documento [INE] recibido");
  });

  it("redacta un pasaporte mexicano (1 letra + 8 digitos)", () => {
    expect(redact("pasaporte G12345678 escaneado")).toBe("pasaporte [PASAPORTE] escaneado");
  });

  // aud-1 agentico.md CRITICO: CURP y RFC son los dos identificadores de huesped mas
  // comunes en el dominio hotelero mexicano (check-in y CFDI) y no calzan con ningun
  // patron existente (INE exige 6 letras iniciales, CURP tiene 4; RFC no es puro digito
  // como CARD_RE ni 1-letra+8-digitos como PASSPORT_RE).
  it("redacta un CURP (18 caracteres: 4 letras+6 digitos+sexo+2 letras+3 consonantes+homoclave+digito)", () => {
    expect(redact("CURP: PEGJ800101HDFRRN09 en el folio")).toBe("CURP: [CURP] en el folio");
  });

  it("redacta un RFC de persona fisica (4 letras+6 digitos+3 alfanumericos, 13 caracteres)", () => {
    expect(redact("RFC del huesped para CFDI: PEGJ800101AB1")).toBe(
      "RFC del huesped para CFDI: [RFC]",
    );
  });

  it("redacta un RFC de persona moral (3 letras+6 digitos+3 alfanumericos, 12 caracteres)", () => {
    expect(redact("RFC de la empresa: ABC800101XY9")).toBe("RFC de la empresa: [RFC]");
  });

  it("redacta un CURP escrito con guiones entre grupos", () => {
    expect(redact("curp con guiones: PEGJ-800101-HDFRRN-09 anotado")).toBe(
      "curp con guiones: [CURP] anotado",
    );
  });

  it("redacta un RFC escrito con espacios entre grupos", () => {
    expect(redact("rfc con espacios: PEGJ 800101 AB1 anotado")).toBe(
      "rfc con espacios: [RFC] anotado",
    );
  });

  it("no confunde un CURP con un RFC (el CURP se redacta completo, no en dos pedazos)", () => {
    const out = redact("PEGJ800101HDFRRN09");
    expect(out).toBe("[CURP]");
    expect(out).not.toContain("RFC");
  });

  it("no modifica texto sin PII", () => {
    expect(redact("la habitacion 301 esta lista para check-in")).toBe(
      "la habitacion 301 esta lista para check-in",
    );
  });

  it("redacta multiples PII distintas en el mismo texto", () => {
    const input = "huesped ana@example.com tel 5512345678";
    const out = redact(input);
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[TEL]");
    expect(out).not.toContain("ana@example.com");
    expect(out).not.toContain("5512345678");
  });

  it("devuelve cadena vacia intacta", () => {
    expect(redact("")).toBe("");
  });
});
