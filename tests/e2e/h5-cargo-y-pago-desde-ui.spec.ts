import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// H5 · ENTREGA punto 4 (E2E): "cargar cargo y pago desde UI, capturas h5-*.png 1280 y
// 390". Mismo patrón de arranque real que tests/e2e/h4-reserva-real-desde-ui.spec.ts:
// apps/api (embedded-postgres efímero, seeds reales) + apps/web (`vite dev`). La
// reserva se crea y confirma por la API real (login + fetch) porque /reservas (H4)
// todavía no tiene un botón de "confirmar" en la UI -- el flujo que SÍ se ejercita
// desde la UI real, que es lo que pide el encargo, es cargar un cargo y un pago sobre
// el folio ya existente desde /recepcion.
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

test("cargar un cargo y un pago sobre el folio de una reserva desde /recepcion (UI real)", async ({ page }, testInfo) => {
  test.setTimeout(150_000);

  const apiPort = await puertoLibre();
  const dbPort = await puertoLibre();
  const webPort = await puertoLibre();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atiende-hoteles-e2e-h5-"));

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

    // ---- Preparación de datos vía la API real (login + fetch): crea y confirma una
    // reserva para tener un folio abierto que ejercitar desde la UI ----
    const loginRes = await fetch(`http://localhost:${apiPort}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "gm@hotel-demo-centro.demo", password: "atiende-dev-2026" }),
    });
    const { token } = (await loginRes.json()) as { token: string };

    const hotelesRes = await fetch(`http://localhost:${apiPort}/hoteles`, { headers: { authorization: `Bearer ${token}` } });
    const hoteles = (await hotelesRes.json()) as { id: string; nombre: string }[];
    const hotel = hoteles[0]!;

    const disponibilidadRes = await fetch(`http://localhost:${apiPort}/hoteles/${hotel.id}/disponibilidad?desde=${isoDate(0)}&hasta=${isoDate(1)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const disponibilidad = (await disponibilidadRes.json()) as { tipoHabitacionId: string }[];
    const fila = disponibilidad[0]!;

    const offset = testInfo.project.name === "mobile" ? 24 : 26;
    const checkIn = isoDate(offset);
    const checkOut = isoDate(offset + 1);

    const crearRes = await fetch(`http://localhost:${apiPort}/hoteles/${hotel.id}/reservas`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ roomTypeId: fila.tipoHabitacionId, checkInDate: checkIn, checkOutDate: checkOut }),
    });
    const { id: reservationId } = (await crearRes.json()) as { id: string };

    await fetch(`http://localhost:${apiPort}/hoteles/${hotel.id}/reservas/${reservationId}/transicion`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ toStatus: "confirmada" }),
    });

    // ---- UI real: login + /recepcion, seleccionar la reserva y cargar cargo/pago ----
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`http://localhost:${webPort}/login`);
    await page.getByLabel("Tu correo").fill("gm@hotel-demo-centro.demo");
    await page.getByLabel("Contraseña").fill("atiende-dev-2026");
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/resumen$/, { timeout: 15_000 });

    await page.goto(`http://localhost:${webPort}/recepcion`);
    await expect(page.getByRole("heading", { name: "Recepción" })).toBeVisible();
    await expect(page.getByText("Folio del huésped en casa")).toBeVisible();

    const selectorReserva = page.getByLabel("Reserva");
    await expect(selectorReserva).toBeVisible({ timeout: 15_000 });
    await expect(selectorReserva.locator("option", { hasText: checkIn })).toHaveCount(1, { timeout: 15_000 });
    const opcionTexto = await selectorReserva.locator("option", { hasText: checkIn }).textContent();
    await selectorReserva.selectOption({ label: opcionTexto ?? "" });

    await expect(page.getByText("Saldo:")).toBeVisible({ timeout: 15_000 });

    // ---- Cargar un cargo ----
    await page.getByRole("button", { name: "Agregar cargo" }).click();
    await expect(page.getByRole("heading", { name: "Agregar cargo" })).toBeVisible();
    await page.getByLabel("Descripción").fill("Consumo de minibar");
    await page.getByLabel("Monto (antes de impuesto)").fill("250");
    await page.getByRole("button", { name: "Confirmar cargo" }).click();
    await expect(page.getByRole("heading", { name: "Agregar cargo" })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("Consumo de minibar")).toBeVisible({ timeout: 15_000 });

    const vp = testInfo.project.use.viewport;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h5-recepcion-folio-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- Registrar un pago ----
    await page.getByRole("button", { name: "Registrar pago" }).click();
    await expect(page.getByRole("heading", { name: "Registrar pago" })).toBeVisible();
    // El cargo de $250 va con concepto "extras" (default del formulario), que lleva
    // IVA 16% + ISH 3% = 19% -- 250 * 1.19 = 297.50, no 250 ni un redondeo arbitrario.
    await page.getByLabel("Monto").fill("297.50");
    await page.getByRole("button", { name: "Confirmar pago" }).click();
    await expect(page.getByRole("heading", { name: "Registrar pago" })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText("Saldo: $0.00")).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h5-recepcion-folio-pagado-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- /back-office: cierre diario y CFDI, capturas de la vista de gerencia ----
    await page.goto(`http://localhost:${webPort}/back-office`);
    await expect(page.getByRole("heading", { name: "Back office" })).toBeVisible();
    await expect(page.getByText("Cierre diario (night audit)")).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `h5-back-office-${vp?.width}x${vp?.height}.png`), fullPage: true });
  } finally {
    matarProceso(apiProc);
    matarProceso(webProc);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
