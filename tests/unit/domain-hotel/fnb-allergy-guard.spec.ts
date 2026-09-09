// REQ-AB-004 (P0/GOB): "cuando el huésped declare alergia/restricción alimentaria en
// un pedido de F&B, la orden debe marcarse explícitamente y requerir confirmación
// humana del cocinero antes de que el sistema asegure al huésped que el platillo es
// seguro; sin confirmación, el sistema no debe afirmarlo."
import { describe, expect, it } from "vitest";
import {
  AllergySafetyAssuranceBlockedError,
  assertCanAssureDishIsSafe,
  canAssureDishIsSafe,
  describeSafetyAssuranceMessage,
  looksLikeAllergyDeclaration,
  resolveAllergyDeclared,
} from "@atiende-hoteles/domain-hotel";

describe("looksLikeAllergyDeclaration", () => {
  it("detecta declaraciones explícitas de alergia", () => {
    expect(looksLikeAllergyDeclaration("soy alérgico a los mariscos")).toBe(true);
    expect(looksLikeAllergyDeclaration("tengo alergia al gluten")).toBe(true);
    expect(looksLikeAllergyDeclaration("Alergias: cacahuate")).toBe(true);
  });

  it("detecta intolerancias y enfermedad celiaca", () => {
    expect(looksLikeAllergyDeclaration("soy intolerante a la lactosa")).toBe(true);
    expect(looksLikeAllergyDeclaration("soy celiaco, sin gluten por favor")).toBe(true);
    expect(looksLikeAllergyDeclaration("tengo una condición de anafilaxia con nueces")).toBe(true);
  });

  it("detecta restricciones alimentarias declaradas en frase libre", () => {
    expect(looksLikeAllergyDeclaration("tengo una restricción alimentaria importante")).toBe(true);
    expect(looksLikeAllergyDeclaration("no puedo comer camarón")).toBe(true);
  });

  it("NO marca un pedido normal sin ninguna mención de alergia/restricción", () => {
    expect(looksLikeAllergyDeclaration("dos pizzas margarita y una coca cola, por favor")).toBe(false);
    expect(looksLikeAllergyDeclaration("sin cebolla, gracias")).toBe(false);
  });

  it("null/undefined/vacío no truena y no detecta nada", () => {
    expect(looksLikeAllergyDeclaration(null)).toBe(false);
    expect(looksLikeAllergyDeclaration(undefined)).toBe(false);
    expect(looksLikeAllergyDeclaration("")).toBe(false);
  });
});

describe("resolveAllergyDeclared", () => {
  it("el campo estructurado en true siempre declara, sin importar el texto", () => {
    const out = resolveAllergyDeclared({ structuredFlag: true, freeTextFields: ["dos pizzas, nada especial"] });
    expect(out.allergyDeclared).toBe(true);
    expect(out.declaredVia).toBe("estructurado");
  });

  it("red de seguridad: campo estructurado en false pero una nota libre PARECE declarar alergia", () => {
    const out = resolveAllergyDeclared({
      structuredFlag: false,
      freeTextFields: [null, "soy alérgico a los cacahuates, por favor tengan cuidado"],
    });
    expect(out.allergyDeclared).toBe(true);
    expect(out.declaredVia).toBe("texto_libre");
  });

  it("sin campo estructurado y con notas realmente vacías (null/undefined/blanco), NO declara alergia", () => {
    const out = resolveAllergyDeclared({ structuredFlag: false, freeTextFields: [null, undefined, "   "] });
    expect(out.allergyDeclared).toBe(false);
    expect(out.declaredVia).toBeNull();
  });

  it("MITIGACIÓN INTERIM (P0/SEG, ver comentario en fnbAllergyGuard.ts): cualquier nota NO vacía que no calce con el regex igual declara alergia -- sobre-disparar es aceptable, un falso negativo no", () => {
    const out = resolveAllergyDeclared({ structuredFlag: false, freeTextFields: ["sin cebolla", null, undefined] });
    expect(out.allergyDeclared).toBe(true);
    expect(out.declaredVia).toBe("texto_libre_no_reconocido");
  });
});

describe("canAssureDishIsSafe / assertCanAssureDishIsSafe", () => {
  it("sin alergia declarada, siempre es seguro afirmar (nada que confirmar)", () => {
    expect(canAssureDishIsSafe({ allergyDeclared: false, kitchenConfirmedBy: null })).toBe(true);
    expect(() => assertCanAssureDishIsSafe({ allergyDeclared: false, kitchenConfirmedBy: null })).not.toThrow();
  });

  it("con alergia declarada y SIN confirmación del cocinero, NUNCA es seguro afirmar", () => {
    expect(canAssureDishIsSafe({ allergyDeclared: true, kitchenConfirmedBy: null })).toBe(false);
    expect(canAssureDishIsSafe({ allergyDeclared: true, kitchenConfirmedBy: undefined })).toBe(false);
    expect(() => assertCanAssureDishIsSafe({ allergyDeclared: true, kitchenConfirmedBy: null })).toThrow(
      AllergySafetyAssuranceBlockedError,
    );
  });

  it("con alergia declarada y CON confirmación del cocinero, es seguro afirmar", () => {
    const order = { allergyDeclared: true, kitchenConfirmedBy: "staff-123" };
    expect(canAssureDishIsSafe(order)).toBe(true);
    expect(() => assertCanAssureDishIsSafe(order)).not.toThrow();
  });

  it("el error lanzado trae el código estable para mapear a un 409 en la ruta", () => {
    try {
      assertCanAssureDishIsSafe({ allergyDeclared: true, kitchenConfirmedBy: null });
      expect.unreachable("debía lanzar");
    } catch (err) {
      expect(err).toBeInstanceOf(AllergySafetyAssuranceBlockedError);
      expect((err as AllergySafetyAssuranceBlockedError).code).toBe("fnb_alergia_confirmacion_requerida");
    }
  });
});

describe("describeSafetyAssuranceMessage", () => {
  it("sin alergia declarada: mensaje genérico, sin afirmación de seguridad", () => {
    const msg = describeSafetyAssuranceMessage({ allergyDeclared: false, kitchenConfirmedBy: null });
    expect(msg).not.toMatch(/es seguro/i);
  });

  it("con alergia declarada y SIN confirmación: el mensaje NUNCA afirma que el platillo es seguro", () => {
    const msg = describeSafetyAssuranceMessage({ allergyDeclared: true, kitchenConfirmedBy: null });
    expect(msg).not.toMatch(/es seguro/i);
    expect(msg.toLowerCase()).toContain("cocinero");
  });

  it("con alergia declarada y CON confirmación: el mensaje SÍ afirma seguridad, atribuida al cocinero", () => {
    const msg = describeSafetyAssuranceMessage({ allergyDeclared: true, kitchenConfirmedBy: "staff-123" });
    expect(msg).toMatch(/es seguro/i);
    expect(msg.toLowerCase()).toContain("confirmado");
  });
});

// Frases reales que dos auditorías adversariales independientes confirmaron que evadían
// ALLERGY_KEYWORDS_RE (docs/logs/allergy-bypass-regex/) -- la mitigación interim de
// resolveAllergyDeclared (cualquier texto no vacío sin match también declara) debe
// cubrirlas TODAS, no por el regex sino por el fallback de "texto no reconocido".
describe("resolveAllergyDeclared > mitigación interim cubre las frases que evadieron el regex", () => {
  const frasesQueEvadianElRegex = [
    "no tolero los mariscos, me hace mal comerlos",
    "no me caen bien los camarones, mejor no me den",
    "los mariscos me hacen mucho daño",
    "si como camaron me hincho como globo",
    "la ultima vez que comi camaron quede hospitalizado",
    "nomas no me den camaron que me pongo muy mal",
    "el marisco me choca feo, me hace enfermarme",
    "soy allergica a los mariscos, porfavor tengan cuidado",
    "traigo receta medica de evitar los cacahuates",
    "el marisco me cae bien gordo, ni de broma me den",
    "cuando como fresa me salen ronchas por todos lados",
    "el gluten no me sienta nada bien",
  ];

  it.each(frasesQueEvadianElRegex)("%s -> allergyDeclared=true vía texto_libre_no_reconocido (aunque no calce el regex)", (frase) => {
    const out = resolveAllergyDeclared({ structuredFlag: false, freeTextFields: [frase] });
    expect(out.allergyDeclared).toBe(true);
    expect(canAssureDishIsSafe({ allergyDeclared: out.allergyDeclared, kitchenConfirmedBy: null })).toBe(false);
  });
});
