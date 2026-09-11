// Patrón Likida/atiende.ai #8 (intent 3/3): un derecho ARCO/privacidad pedido por
// WhatsApp debe redirigirse a /privacidad/solicitud en vez de caer en la clasificación
// genérica de ticket, sin ningún rastro de que era un ejercicio de derechos de datos.
import { describe, expect, it } from "vitest";
import { looksLikeArcoRequest } from "../../../packages/domain-hotel/src/arcoIntentGuard.ts";

describe("looksLikeArcoRequest", () => {
  it("detecta mención explícita de 'derechos ARCO'", () => {
    expect(looksLikeArcoRequest("Quiero ejercer mis derechos ARCO sobre mis datos")).toBe(true);
  });

  it("detecta 'quiero borrar mis datos'", () => {
    expect(looksLikeArcoRequest("Hola, quiero borrar mis datos personales del hotel")).toBe(true);
  });

  it("detecta 'rectificar mis datos'", () => {
    expect(looksLikeArcoRequest("Necesito rectificar mis datos, mi apellido está mal escrito")).toBe(true);
  });

  it("detecta mención de 'protección de datos'/'aviso de privacidad'", () => {
    expect(looksLikeArcoRequest("Tengo una duda sobre protección de datos")).toBe(true);
    expect(looksLikeArcoRequest("¿Dónde puedo ver el aviso de privacidad?")).toBe(true);
  });

  it("NO marca una mención normal de 'mis datos' durante el check-in (sin verbo de acción ARCO)", () => {
    expect(looksLikeArcoRequest("Aquí están mis datos para la reserva: Juan Pérez, 2 noches")).toBe(false);
  });

  it("NO marca un mensaje que solo menciona 'borrar' sin relación a datos personales", () => {
    expect(looksLikeArcoRequest("¿Pueden borrar el cargo duplicado?")).toBe(false);
  });

  it("texto vacío/nulo nunca se marca", () => {
    expect(looksLikeArcoRequest("")).toBe(false);
    expect(looksLikeArcoRequest(null)).toBe(false);
    expect(looksLikeArcoRequest(undefined)).toBe(false);
  });
});
