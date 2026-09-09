// REQ-SEG-001 (H19-001/H19-009) — "El sistema debe publicar y mantener actualizado un
// Aviso de Privacidad conforme a la LFPDPPP vigente, accesible desde el primer contacto
// por WhatsApp/voz/web...". Este archivo es el acceptance test que docs/ACEPTACION.md ya
// declaraba (`tests/e2e/aviso-privacidad-primer-contacto.spec.ts`) pero que no existía en
// el repo.
//
// Alcance HONESTO de este archivo: este `playwright.config.ts` solo levanta `vite
// preview` de apps/web (sin apps/api real detrás, ver README.md "sin backend disponible
// cada pantalla muestra EstadoError honesto") -- cubre el primer contacto público (la
// landing, sin sesión ni backend) y el propio contenido del aviso.
//   - WEB: la landing pública enlaza al aviso desde el footer, Y la página del aviso
//     renderiza con el contenido real (secciones + banner "pendiente de redacción
//     legal", nunca fingido como texto legal definitivo).
// Otras superficies de "primer contacto" de REQ-SEG-001, ya cubiertas en otro nivel:
//   - El check-in en línea (`CheckinPublico.tsx`) exige el checkbox de aceptación del
//     aviso ANTES de poder enviar -- requiere apps/api real detrás (embedded postgres),
//     probado end-to-end vía API en
//     tests/adversarial/auditoria-2-lote-a-seguridad-legal.spec.ts (describe "[L3
//     ALTOS]", caso "sin aceptar el aviso de privacidad es rechazado (400)").
//   - WhatsApp (disclosure de primer turno con el enlace real, agent-core
//     `buildDisclosureMessageConAvisoPrivacidad`) se prueba a nivel de API/webhook en
//     tests/adversarial/disclosure-ia.spec.ts -- no es alcanzable desde este runner de UI.
// El canal de VOZ depende de telefonía/PBX real (Telnyx) que no existe todavía en este
// repo (mismo límite ya documentado en disclosure-ia.spec.ts) -- no se simula aquí.
import { test, expect } from "@playwright/test";

test.describe("aviso de privacidad accesible desde el primer contacto (REQ-SEG-001)", () => {
  test("web: la landing pública enlaza el aviso de privacidad en el primer contacto (footer)", async ({ page }) => {
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    const enlace = footer.getByRole("link", { name: /aviso de privacidad/i });
    await expect(enlace).toHaveAttribute("href", "/privacidad");
  });

  test("web: /privacidad renderiza el aviso real, con sus secciones y el banner honesto de pendiente de redacción legal final", async ({
    page,
  }) => {
    await page.goto("/privacidad");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/^aviso de privacidad$/i)).toBeVisible();

    // Secciones sustantivas reales (no un placeholder vacío): responsable de los datos,
    // transferencia internacional al proveedor de IA, y derechos ARCO.
    await expect(page.getByText(/proveedor de inteligencia artificial/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /derechos arco/i })).toBeVisible();

    // REQ-SEG-001 (instrucción explícita de esta ronda): NUNCA se inventa el texto legal
    // definitivo -- la página debe declarar honestamente que sigue pendiente de
    // confirmación por el fundador/equipo legal, no presentarse como aviso final.
    await expect(page.getByText(/pendiente/i).first()).toBeVisible();
    await expect(page.getByText(/equipo legal del fundador/i)).toBeVisible();
  });
});
