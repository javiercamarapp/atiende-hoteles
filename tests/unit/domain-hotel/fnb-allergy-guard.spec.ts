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

// AUDITORÍA (8-sep-2026, P0/GOB): el regex original NO reconocía frases naturales --
// ni siquiera la adversarial reportada "no tolero los mariscos, me hace mal comerlos"
// -- lo que dejaba `alergiaDeclarada=false` y `puedeAsegurarSeguridad=true`, y
// `POST /asegurar-seguridad` devolvía 200 SIN confirmación humana de cocina. Esta
// suite cubre >=20 frases naturales/coloquiales distintas (incluida la reportada) que
// DEBEN activar la guarda -- nunca deben terminar en una afirmación de seguridad sin
// confirmación humana (ver también el caso de extremo a extremo en
// `tests/adversarial/alergias-confirmacion.spec.ts`).
describe("looksLikeAllergyDeclaration -- adversarial: frases naturales de food-safety", () => {
  const frasesQueDebenActivarLaGuarda = [
    "no tolero los mariscos, me hace mal comerlos", // frase adversarial reportada por la auditoría
    "no tolero el marisco",
    "me hace mal el camarón",
    "me cae mal el marisco",
    "me enferma comer nueces",
    "me intoxico si como mariscos",
    "soy sensible a los lácteos",
    "soy sensible al gluten",
    "no como mariscos porque me hace daño",
    "no como cacahuate porque me pone mal",
    "me da reacción con el gluten",
    "me da reaccion si como cacahuate",
    "me da alergia el marisco",
    "me da urticaria con los mariscos",
    "me da comezon si como camaron",
    "me da ronchas el marisco",
    "se me hincha la garganta si como mariscos",
    "se me cierra la garganta con el marisco",
    "me cuesta respirar si hay nueces cerca",
    "estoy contraindicado para comer nueces por mis medicamentos",
    "tuve un shock anafiláctico con camarones antes",
    "si como nueces me da un choque anafilactico",
    "es mortal para mi comer cacahuates",
    "puede matarme si tiene mariscos",
    "riesgo de muerte si tiene nueces",
    "no debo comer gluten por mi condicion",
    "no deberia comer nueces, tengo una condicion",
  ];

  it.each(frasesQueDebenActivarLaGuarda)('detecta: "%s"', (frase) => {
    expect(looksLikeAllergyDeclaration(frase)).toBe(true);
  });

  it("la frase adversarial reportada, vía resolveAllergyDeclared, marca la orden con alergia declarada por texto libre", () => {
    const out = resolveAllergyDeclared({
      structuredFlag: false,
      freeTextFields: [null, "no tolero los mariscos, me hace mal comerlos"],
    });
    expect(out.allergyDeclared).toBe(true);
    expect(out.declaredVia).toBe("texto_libre");
  });

  it("la frase adversarial reportada, vía la guarda central, BLOQUEA asegurar seguridad sin confirmación humana", () => {
    const { allergyDeclared } = resolveAllergyDeclared({
      structuredFlag: false,
      freeTextFields: ["no tolero los mariscos, me hace mal comerlos"],
    });
    expect(canAssureDishIsSafe({ allergyDeclared, kitchenConfirmedBy: null })).toBe(false);
    expect(() => assertCanAssureDishIsSafe({ allergyDeclared, kitchenConfirmedBy: null })).toThrow(
      AllergySafetyAssuranceBlockedError,
    );
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

  it("sin campo estructurado y sin ninguna nota sospechosa, NO declara alergia", () => {
    const out = resolveAllergyDeclared({ structuredFlag: false, freeTextFields: ["sin cebolla", null, undefined] });
    expect(out.allergyDeclared).toBe(false);
    expect(out.declaredVia).toBeNull();
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
