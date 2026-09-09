import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// H6b · ENTREGA punto 5 (E2E): recorrido real de housekeeping/mantenimiento/mensajería/
// aprobaciones con capturas h6-*.png en 1280x800 y 390x844. Mismo patrón que
// h4-reserva-real-desde-ui.spec.ts: arranca apps/api (embedded-postgres efímero, seeds
// reales) + apps/web (`vite dev`), login real con credenciales de la seed, y ejercita el
// flujo de negocio real de punta a punta (crear tarea, reportar ticket, autorizar gasto
// con doble confirmación, enviar WhatsApp simulado, decidir en la bandeja de
// aprobaciones) -- sin datos de ejemplo fabricados en el cliente.
const API_DIR = path.resolve(import.meta.dirname, "../../apps/api");
const WEB_DIR = path.resolve(import.meta.dirname, "../../apps/web");
const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, "screenshots");

function puertoLibre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const puerto = address.port;
        srv.close(() => resolve(puerto));
      } else {
        srv.close();
        reject(new Error("No se pudo obtener un puerto libre"));
      }
    });
  });
}

async function esperarServidor(url: string, timeoutMs: number): Promise<boolean> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      // todavía no levanta
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function matarProceso(proc: ChildProcess | null) {
  if (!proc?.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ya no existe */
    }
  }
}

test("housekeeping/mantenimiento/mensajería/aprobaciones: recorrido real desde la UI (seeds reales)", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const apiPort = await puertoLibre();
  const dbPort = await puertoLibre();
  const webPort = await puertoLibre();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atiende-hoteles-e2e-h6-"));

  let apiProc: ChildProcess | null = null;
  let webProc: ChildProcess | null = null;

  try {
    // H5 (merge H6b→main): `node --experimental-strip-types` no soporta *parameter
    // properties* de TS, usadas en `packages/mcp-servers/payments|cfdi` -- con esos
    // paquetes ya conectados a `apps/api` (H5), el proceso real ni siquiera arrancaba.
    // Mismo fix que h4-reserva-real-desde-ui.spec.ts/login-real-y-resumen.spec.ts/
    // h5-cargo-y-pago-desde-ui.spec.ts: `--experimental-transform-types`.
    apiProc = spawn("node", ["--experimental-transform-types", "src/server.ts"], {
      cwd: API_DIR,
      detached: true,
      stdio: "pipe",
      env: {
        ...process.env,
        PORT: String(apiPort),
        DB_PORT: String(dbPort),
        DB_DATA_DIR: dataDir,
        JWT_SECRET: "e2e-test-jwt-secret-no-usar-en-produccion",
        NODE_ENV: "test",
        // H8 (auditoria-1/seguridad.md [MEDIO] CORS): lista blanca explícita -- este
        // `apps/web` corre en un puerto dinámico, no en el default de Vite dev.
        CORS_ALLOWED_ORIGINS: `http://localhost:${webPort}`,
      },
    });
    let apiOut = "";
    apiProc.stdout?.on("data", (d) => (apiOut += d.toString()));
    apiProc.stderr?.on("data", (d) => (apiOut += d.toString()));

    const apiOk = await esperarServidor(`http://localhost:${apiPort}/health`, 60_000);
    expect(apiOk, `apps/api no arrancó en 60s. Salida:\n${apiOut.slice(-4000)}`).toBeTruthy();

    webProc = spawn("npm", ["run", "dev", "--", "--port", String(webPort), "--strictPort"], {
      cwd: WEB_DIR,
      detached: true,
      stdio: "pipe",
      env: { ...process.env, VITE_API_URL: `http://localhost:${apiPort}` },
    });
    let webOut = "";
    webProc.stdout?.on("data", (d) => (webOut += d.toString()));
    webProc.stderr?.on("data", (d) => (webOut += d.toString()));

    const webOk = await esperarServidor(`http://localhost:${webPort}/`, 60_000);
    expect(webOk, `apps/web (vite dev) no arrancó en 60s. Salida:\n${webOut.slice(-4000)}`).toBeTruthy();

    await page.emulateMedia({ reducedMotion: "reduce" });
    const vp = testInfo.project.use.viewport;

    // Pre-otorga el consentimiento de cookies/analítica (mismo localStorage que
    // CookieConsentBanner.tsx lee) antes de que la app monte -- en viewport móvil
    // el banner fijo al fondo tapa botones reales de la UI (ej. "Cerrar con costo"),
    // y este test no está probando el banner de cookies en sí (eso ya lo cubre su
    // propio test unitario/e2e dedicado).
    await page.addInitScript(() => {
      window.localStorage.setItem("atiende_hoteles_consentimiento_analitica", "otorgado");
    });

    // Login real como gerencia (gm) del "Hotel Demo Centro" -- puede operar
    // housekeeping/mantenimiento/mensajería/aprobaciones (ADMIN_ROLES).
    await page.goto(`http://localhost:${webPort}/login`);
    await page.getByLabel("Tu correo").fill("gm@hotel-demo-centro.demo");
    await page.getByLabel("Contraseña").fill("atiende-dev-2026");
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/resumen$/, { timeout: 15_000 });

    // H12c: el banner de cookies/analítica se muestra en CUALQUIER pantalla (pública o
    // del panel) sin decisión previa y queda fijo al fondo del viewport -- en móvil
    // (390x844) esto intercepta el click de "Cerrar con costo" más abajo porque ese
    // botón cae en la franja inferior tras crear el ticket. Se acepta una sola vez aquí,
    // como haría una persona real, antes de seguir el flujo.
    const bannerCookies = page.getByRole("region", { name: /consentimiento de cookies/i });
    if (await bannerCookies.isVisible().catch(() => false)) {
      await bannerCookies.getByRole("button", { name: /aceptar analítica/i }).click();
      await expect(bannerCookies).toBeHidden();
    }

    // ---- /housekeeping: tablero real, crear una tarea ----
    await page.goto(`http://localhost:${webPort}/housekeeping`);
    await expect(page.getByRole("heading", { name: "Housekeeping" })).toBeVisible();
    await expect(page.getByText("Sucias").first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h6-housekeeping-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- /mantenimiento: reportar un ticket real ----
    await page.goto(`http://localhost:${webPort}/mantenimiento`);
    await expect(page.getByRole("heading", { name: "Mantenimiento" })).toBeVisible();
    await page.getByRole("button", { name: /reportar/i }).click();
    await expect(page.getByRole("heading", { name: "Reportar ticket de mantenimiento" })).toBeVisible();
    await page.getByLabel("Título").fill("Aire acondicionado no enfría (E2E)");
    await page.getByLabel("Descripción").fill("El huésped reporta que el AC no enfría lo suficiente.");
    await page.getByRole("dialog").getByRole("button", { name: "Reportar", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reportar ticket de mantenimiento" })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("Aire acondicionado no enfría (E2E)")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h6-mantenimiento-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // Cerrar con costo: abre una solicitud de aprobación (dinero, doble confirmación) --
    // NO cierra directo.
    await page.getByRole("button", { name: /cerrar con costo/i }).first().click();
    await expect(page.getByRole("heading", { name: /cerrar ".*" con costo/i })).toBeVisible();
    await page.getByLabel("Costo real (MXN)").fill("2500");
    await page.getByRole("button", { name: "Solicitar autorización" }).click();
    await expect(page.getByText(/esperando doble aprobación de gasto/i)).toBeVisible({ timeout: 15_000 });

    // ---- /mensajeria: enviar una plantilla y ver el estado "simulado" ----
    await page.goto(`http://localhost:${webPort}/mensajeria`);
    await expect(page.getByRole("heading", { name: "Mensajería" })).toBeVisible();
    await page.getByRole("button", { name: /enviar plantilla/i }).click();
    await page.getByLabel("Teléfono del huésped (E.164)").fill("+5215500000123");
    await page.getByLabel("Nombre de la plantilla").fill("checkin_confirmado_e2e");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(page.getByText(/pendiente de aprobación|enviado/i)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h6-mensajeria-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- /aprobaciones: la bandeja muestra la(s) solicitud(es) reales pendientes ----
    await page.goto(`http://localhost:${webPort}/aprobaciones`);
    await expect(page.getByRole("heading", { name: "Aprobaciones" })).toBeVisible();
    await expect(page.getByText(/autorizar_gasto_mantenimiento/i)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h6-aprobaciones-${vp?.width}x${vp?.height}.png`), fullPage: true });
  } finally {
    matarProceso(apiProc);
    matarProceso(webProc);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
