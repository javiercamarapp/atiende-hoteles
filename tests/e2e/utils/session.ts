import type { Page } from "@playwright/test";

/**
 * Siembra una sesión local falsa (NO datos de dominio) para poder llegar a
 * las rutas protegidas del panel sin backend real disponible en este
 * entorno de pruebas — igual que cualquier suite E2E de una SPA con auth
 * real necesita "estar ya logueado" para capturar pantallas internas. Las
 * pantallas siguen llamando a la API real (inexistente aquí) y muestran
 * `EstadoError`/`EstadoVacio` honestos: esto NUNCA inyecta datos de negocio
 * de ejemplo, solo el token de sesión que el guard de rutas exige.
 */
export async function sembrarSesionFalsa(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "atiende_hoteles_session",
      JSON.stringify({ token: "e2e-fake-token", email: "e2e@atiende.ai", rol: "gm" }),
    );
  });
}
