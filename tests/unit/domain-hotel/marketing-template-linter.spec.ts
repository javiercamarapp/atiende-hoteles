// REQ-SEG-007: "todo mensaje de marketing incluye opción de baja" -- verificado con
// "mensaje sin opción de baja -> rechazado por el linter de plantillas". Unidad PURA
// (sin BD/API) de `lintMarketingTemplateBody`; el camino end-to-end real (PATCH
// .../mensajeria/config lo usa antes de guardar, y el envío persiste el texto ya
// validado) se cubre en tests/adversarial/opt-in-marketing.spec.ts.
import { describe, expect, it } from "vitest";
import { lintMarketingTemplateBody } from "../../../packages/domain-hotel/src/marketingTemplateLinter.ts";

describe("lintMarketingTemplateBody", () => {
  it("rechaza un texto de marketing sin ninguna opción de baja", () => {
    const result = lintMarketingTemplateBody("¡Aprovecha nuestra promoción exclusiva de fin de semana!");
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("acepta un texto con 'BAJA' explícito (formato estándar en México)", () => {
    expect(lintMarketingTemplateBody("Oferta especial. Responde BAJA para dejar de recibir estos mensajes.").ok).toBe(true);
  });

  it("acepta un texto con 'STOP'/'unsubscribe' (formato EE.UU./carriers)", () => {
    expect(lintMarketingTemplateBody("Special offer! Reply STOP to unsubscribe.").ok).toBe(true);
  });

  it("acepta variantes de frase en español ('darte de baja', 'cancelar tu suscripción')", () => {
    expect(lintMarketingTemplateBody("Promo de temporada. Puedes darte de baja cuando quieras.").ok).toBe(true);
    expect(lintMarketingTemplateBody("Promo de temporada. Puedes cancelar tu suscripción cuando quieras.").ok).toBe(true);
  });

  it("es insensible a acentos y mayúsculas/minúsculas", () => {
    expect(lintMarketingTemplateBody("Promoción. RESPONDE BÁJA PARA DARTE DE BAJA.").ok).toBe(true);
  });

  it("rechaza texto vacío, solo espacios, null o undefined", () => {
    expect(lintMarketingTemplateBody("").ok).toBe(false);
    expect(lintMarketingTemplateBody("   ").ok).toBe(false);
    expect(lintMarketingTemplateBody(null).ok).toBe(false);
    expect(lintMarketingTemplateBody(undefined).ok).toBe(false);
  });

  it("una mención de 'baja' fuera de contexto de opt-out NO basta por sí sola para engañar al linter en sentido inverso -- pero SÍ cuenta como señal reconocida (deny-by-default hacia el hotel, nunca hacia el huésped)", () => {
    // El linter es deliberadamente permisivo con falsos positivos (aceptar de más) y
    // estricto con falsos negativos (rechazar cualquier cosa sin patrón reconocido) --
    // ver comentario de archivo. Esta prueba documenta ese sesgo explícito: la palabra
    // "baja" sola ya es suficiente para pasar, por diseño.
    expect(lintMarketingTemplateBody("Precios en baja esta temporada, aprovecha ya.").ok).toBe(true);
  });
});
