import { test, expect } from "@playwright/test";
import path from "node:path";
import { sembrarSesionFalsa } from "./utils/session";

// REQ-UX-001/ACEPTACION §5: capturas de login/resumen/reservas en
// 1280x800 (desktop) y 390x844 (móvil) — cada proyecto de playwright.config.ts
// fija uno de esos dos viewports; este spec corre igual en ambos y nombra el
// archivo con el tamaño real de la ventana para no adivinar cuál corrió.
const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, "screenshots");

test.describe("Paridad visual — capturas hoteles", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("login", async ({ page }, testInfo) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /bienvenido a atiende hoteles/i })).toBeVisible();
    const vp = testInfo.project.use.viewport;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `hoteles-login-${vp?.width}x${vp?.height}.png`), fullPage: true });
  });

  test("resumen", async ({ page }, testInfo) => {
    await sembrarSesionFalsa(page);
    await page.goto("/resumen");
    await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
    const vp = testInfo.project.use.viewport;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `hoteles-resumen-${vp?.width}x${vp?.height}.png`), fullPage: true });
  });

  test("reservas", async ({ page }, testInfo) => {
    await sembrarSesionFalsa(page);
    await page.goto("/reservas");
    await expect(page.getByRole("heading", { name: "Reservas" })).toBeVisible();
    const vp = testInfo.project.use.viewport;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `hoteles-reservas-${vp?.width}x${vp?.height}.png`), fullPage: true });
  });
});
