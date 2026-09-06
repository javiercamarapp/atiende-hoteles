// H12c · LAUNCH-025: captura real de la landing pública en los dos viewports exigidos
// (1280×800 desktop, 390×844 móvil vía los proyectos "desktop"/"mobile" de
// apps/web/playwright.config.ts) — sin scroll horizontal, con las imágenes reales del
// producto cargadas (no placeholders). Las capturas se revisan visualmente (evidencia en
// docs/PROGRESO.md), no solo se generan.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const here = fileURLToPath(import.meta.url);
const SCREENSHOTS_DIR = path.resolve(path.dirname(here), "screenshots");

test("landing pública (/): renderiza, sin scroll horizontal, capturas 1280/390 guardadas", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /prueba gratis|prueba gratuita/i }).first()).toBeVisible();

  // Sin scroll horizontal en ningún viewport (REQ-UX-001/móvil real, no `hidden md:flex`
  // sin equivalente): el ancho de scroll del documento nunca excede el viewport.
  const desbordaHorizontal = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(desbordaHorizontal, "la landing no debe generar scroll horizontal").toBe(false);

  // 6 imágenes con /landing/*: 5 secciones de producto + la del hero (que reutiliza a
  // propósito la captura de back-office-cfdi.png como imagen principal del hero).
  // `expect.poll` (en vez de una sola lectura de `naturalWidth`) tolera que el decode
  // de un PNG de ~100KB no haya terminado en el instante exacto de `networkidle`.
  const imagenesProducto = page.locator('main img[src^="/landing/"]');
  await expect(imagenesProducto).toHaveCount(6);
  for (const img of await imagenesProducto.all()) {
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        message: "la captura del producto debe cargar (naturalWidth > 0)",
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
  }

  const vp = testInfo.project.use.viewport;
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h12c-landing-${vp?.width}x${vp?.height}.png`), fullPage: true });
});

test("landing pública (/): CTA a /registro y a /login presentes; footer con enlaces legales", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /iniciar sesión/i })).toHaveAttribute("href", "/login");
  await expect(page.getByRole("link", { name: /prueba gratis|prueba gratuita/i }).first()).toHaveAttribute("href", "/registro");
  // Se acota al footer (getByRole("contentinfo")): el banner de cookies TAMBIÉN enlaza
  // "aviso de privacidad" en su texto (a propósito, ver CookieConsentBanner.tsx), así
  // que un locator sin acotar encuentra 2 coincidencias válidas -- no es un defecto.
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: /aviso de privacidad/i })).toHaveAttribute("href", "/privacidad");
  await expect(footer.getByRole("link", { name: /términos y condiciones/i })).toHaveAttribute("href", "/terminos");
});

test("banner de cookies: aparece sin decisión previa, desaparece tras aceptar, y persiste la decisión", async ({ page }) => {
  await page.goto("/");
  const banner = page.getByRole("region", { name: /consentimiento de cookies/i });
  await expect(banner).toBeVisible();

  await banner.getByRole("button", { name: /aceptar analítica/i }).click();
  await expect(banner).toBeHidden();

  await page.reload();
  await expect(page.getByRole("region", { name: /consentimiento de cookies/i })).toBeHidden();
});
