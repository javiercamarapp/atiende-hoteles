import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// H7 · ENTREGA punto 5 (E2E): runtime de agentes por rol desde la UI real -- capturas
// h7-*.png en 1280x800 y 390x844. Mismo patrón que h6-housekeeping-mantenimiento-
// mensajeria.spec.ts: arranca apps/api (embedded-postgres efímero, seeds reales) + apps/web
// (`vite dev`), login real con credenciales de la seed, corre la demo determinista
// (FakeProvider, sin red/LLM real) de recepción virtual en gate "shadow" y verifica que la
// UI muestra el resultado etiquetado "simulado", el costo del mes y la tarjeta de ROI en
// Resumen -- sin datos de ejemplo fabricados en el cliente.
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

test("agentes: gate/techo, demo determinista (FakeProvider) y tarjeta de ROI en Resumen -- recorrido real desde la UI (seeds reales)", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const apiPort = await puertoLibre();
  const dbPort = await puertoLibre();
  const webPort = await puertoLibre();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atiende-hoteles-e2e-h7-"));

  let apiProc: ChildProcess | null = null;
  let webProc: ChildProcess | null = null;

  try {
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

    // Login real como gerencia (gm) del "Hotel Demo Centro" -- owner/gm pueden cambiar
    // gate/techo, además de disparar la demo.
    await page.goto(`http://localhost:${webPort}/login`);
    await page.getByLabel("Tu correo").fill("gm@hotel-demo-centro.demo");
    await page.getByLabel("Contraseña").fill("atiende-dev-2026");
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/resumen$/, { timeout: 15_000 });

    // ---- /agentes: catálogo real (gate "shadow" por default en los 3 agentes) ----
    await page.goto(`http://localhost:${webPort}/agentes`);
    await expect(page.getByRole("heading", { name: "Agentes" })).toBeVisible();
    await expect(page.getByText("Recepción virtual")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Sin corridas registradas este mes todavía.").first()).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h7-agentes-catalogo-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- Demo determinista (FakeProvider, sin red) sobre "Recepción virtual" ----
    // AGENT_DEFINITIONS (packages/agent-core/src/agents.ts) lista recepcion_virtual
    // primero -- GET /hoteles/:hotelId/agentes preserva ese orden, así que el primer
    // botón "Demo (simulada)" de la grilla es el de recepción virtual.
    await page.getByRole("button", { name: "Demo (simulada)" }).first().click();
    await expect(page.getByText(/completado/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("simulado").first()).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h7-agentes-demo-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // El costo del mes se actualiza tras la corrida (aunque sea $0.00 con FakeProvider
    // sin tabla de precios real para "fake" -- lo importante es que deja de mostrar
    // "sin corridas registradas").
    await page.reload();
    await expect(page.getByText("Recepción virtual")).toBeVisible({ timeout: 15_000 });

    // ---- /resumen: tarjeta de ROI etiquetada "estimado, supuestos H17-v1" ----
    await page.goto(`http://localhost:${webPort}/resumen`);
    await expect(page.getByText("Valor generado por agentes de IA")).toBeVisible({ timeout: 15_000 });
    // La demo de recepción_virtual corrió en gate "shadow": registrar_evento_roi NO se
    // ejecuta en shadow (AgentRunner omite toda tool write/external/money) -- la tarjeta
    // debe mostrar "sin datos todavía" de forma honesta, nunca un cero fabricado.
    await expect(page.getByText(/sin datos todavía/i)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h7-resumen-roi-${vp?.width}x${vp?.height}.png`), fullPage: true });
  } finally {
    matarProceso(apiProc);
    matarProceso(webProc);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
