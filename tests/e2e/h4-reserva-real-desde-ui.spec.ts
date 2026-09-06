import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// H4 · ENTREGA punto 4 (E2E): "crear reserva desde la UI con seeds y verla en la grid
// con capturas 1280 y 390 en tests/e2e/screenshots/h4-*.png". Mismo patrón que
// login-real-y-resumen.spec.ts (H2): arranca apps/api (embedded-postgres efímero,
// seeds reales) + apps/web (`vite dev`, para poder inyectar VITE_API_URL) y corre el
// flujo real de negocio -- login con credenciales de la seed, crear una reserva desde
// el formulario de /reservas, verla aparecer en la tabla, y confirmar que
// /disponibilidad refleja el inventario reducido. Corre en AMBOS proyectos
// (desktop 1280x800, mobile 390x844) porque el encargo pide capturas de los dos
// tamaños, no solo una corrida.
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

function isoDate(diasDesdeHoy: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + diasDesdeHoy);
  return d.toISOString().slice(0, 10);
}

test("crear una reserva real desde /reservas (seeds reales) y verla en la tabla y en la grid de /disponibilidad", async ({ page }, testInfo) => {
  test.setTimeout(150_000);

  const apiPort = await puertoLibre();
  const dbPort = await puertoLibre();
  const webPort = await puertoLibre();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atiende-hoteles-e2e-h4-"));

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
        // H8: CORS ahora exige una lista blanca explícita (auditoria-1/seguridad.md
        // [MEDIO]) -- este apps/web de prueba corre en un puerto dinámico, así que hay
        // que declararlo aquí (mismo principio que un despliegue real: el backend debe
        // conocer el origen exacto del frontend).
        CORS_ALLOWED_ORIGINS: `http://localhost:${webPort}`,
        NODE_ENV: "test",
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

    // Login real con credenciales de la seed (packages/db/src/seed.ts) — el rol
    // "reservations" puede crear/gestionar reservas (MANAGE_RESERVATIONS_ROLES).
    await page.goto(`http://localhost:${webPort}/login`);
    await page.getByLabel("Tu correo").fill("reservations@hotel-demo-centro.demo");
    await page.getByLabel("Contraseña").fill("atiende-dev-2026");
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/resumen$/, { timeout: 15_000 });

    // ---- /reservas: crear una reserva real desde el formulario ----
    await page.goto(`http://localhost:${webPort}/reservas`);
    await expect(page.getByRole("heading", { name: "Reservas" })).toBeVisible();

    // Fecha bien adentro del horizonte de 30 días sembrado (evita colisión con otras
    // pruebas/corridas que usan las primeras fechas) — única por proyecto (desktop vs
    // mobile corren el flujo por separado, con inventario compartido de 5
    // habitaciones/tipo, así que fechas distintas evitan que una reserva le gane el
    // cupo a la otra).
    const offset = testInfo.project.name === "mobile" ? 20 : 22;
    const checkIn = isoDate(offset);
    const checkOut = isoDate(offset + 1);

    await page.getByRole("button", { name: /nueva reserva/i }).click();
    await expect(page.getByRole("heading", { name: "Nueva reserva" })).toBeVisible();

    const selectorTipo = page.getByLabel("Tipo de habitación");
    await expect(selectorTipo.locator("option").nth(1)).toHaveCount(1, { timeout: 15_000 });
    const tipoHabitacionTexto = await selectorTipo.locator("option").nth(1).textContent();
    await selectorTipo.selectOption({ index: 1 });

    await page.getByLabel("Llegada").fill(checkIn);
    await page.getByLabel("Salida").fill(checkOut);
    await page.getByRole("button", { name: "Crear reserva" }).click();

    // El diálogo se cierra y la tabla se refresca con la reserva recién creada.
    await expect(page.getByRole("heading", { name: "Nueva reserva" })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole("cell", { name: checkIn })).toBeVisible({ timeout: 15_000 });

    // La fila de la tabla expone `role="button"` (no "row") a propósito, para que sea
    // activable por teclado como un botón de detalle (ver Reservas.tsx) -- se localiza
    // por la etiqueta accesible de ESE botón en vez de por role="row".
    const fila = page.getByRole("button", { name: /ver detalle de la reserva/i }).filter({ hasText: checkIn });
    await expect(fila).toBeVisible();
    if (tipoHabitacionTexto) {
      await expect(fila.getByText(tipoHabitacionTexto, { exact: true })).toBeVisible();
    }
    // Estado inicial real de la máquina de estados (packages/domain-hotel): toda
    // reserva nueva nace "Cotizada", nunca simulada como ya confirmada.
    await expect(fila.getByText("Cotizada")).toBeVisible();

    const vp = testInfo.project.use.viewport;
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `h4-reservas-${vp?.width}x${vp?.height}.png`),
      fullPage: true,
    });

    // ---- /disponibilidad: la grid refleja el inventario recién reservado ----
    await page.goto(`http://localhost:${webPort}/disponibilidad`);
    await expect(page.getByRole("heading", { name: "Disponibilidad" })).toBeVisible();
    // Espera a que la grid de "hoy" termine de cargar (fila real con el nombre del tipo
    // de habitación, no el esqueleto de carga) ANTES de navegar semanas -- navegar
    // mientras el query sigue en vuelo dispara otra carga y la captura puede quedar en
    // el esqueleto.
    if (tipoHabitacionTexto) {
      await expect(page.getByRole("row").filter({ hasText: tipoHabitacionTexto }).first()).toBeVisible({ timeout: 15_000 });
    }
    const semanasAvanzar = Math.floor(offset / 7);
    for (let i = 0; i < semanasAvanzar; i += 1) {
      await page.getByRole("button", { name: "Semana siguiente" }).click();
      if (tipoHabitacionTexto) {
        await expect(page.getByRole("row").filter({ hasText: tipoHabitacionTexto }).first()).toBeVisible({ timeout: 15_000 });
      }
    }
    // Confirma que la noche reservada aparece con al menos 1 habitación menos
    // disponible que el total (inventario real, no un valor congelado en el esqueleto).
    await expect(page.getByText(/\d+\/\d+/).first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `h4-disponibilidad-${vp?.width}x${vp?.height}.png`),
      fullPage: true,
    });
  } finally {
    matarProceso(apiProc);
    matarProceso(webProc);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
