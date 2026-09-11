// REQ-AB-001 (P1/F): "El menú QR con video debe estar disponible en habitación,
// alberca, camastro, playa y mesa, con reglas de all-inclusive/day-pass y alérgenos
// multilingües, y numeración física única por ubicación codificada en el QR."
//
// Mismo patrón que h4-reserva-real-desde-ui.spec.ts/login-real-y-resumen.spec.ts:
// arranca apps/api (embedded-postgres efímero, seeds reales) + apps/web (`vite dev`)
// y ejercita el flujo real de negocio de punta a punta -- da de alta el menú y dos
// ubicaciones físicas de QR por la API real (con el token de un usuario `fnb` real de
// la seed, sin UI de gestión todavía construida para ese paso), y verifica en el
// NAVEGADOR REAL la pantalla pública que un huésped ve al escanear cada QR: el video
// del platillo carga, las reglas de todo-incluido/day-pass cambian el precio en
// pantalla, los alérgenos se traducen al cambiar de idioma, y los dos QR registrados
// codifican `location_code` distintos.
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const API_DIR = path.resolve(import.meta.dirname, "../../apps/api");
const WEB_DIR = path.resolve(import.meta.dirname, "../../apps/web");
const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, "screenshots");
const TINY_MP4_BASE64_PATH = path.resolve(import.meta.dirname, "fixtures/menu-qr-video-tiny-mp4-base64.txt");

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

test("menú QR con video: reglas de all-inclusive/day-pass, alérgenos multilingües y 2 QR distintos -> 2 location_code distintos", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);

  const apiPort = await puertoLibre();
  const dbPort = await puertoLibre();
  const webPort = await puertoLibre();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atiende-hoteles-e2e-menu-qr-"));
  const tinyMp4Base64 = (await fs.readFile(TINY_MP4_BASE64_PATH, "utf8")).trim();
  const videoUrl = `data:video/mp4;base64,${tinyMp4Base64}`;

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
        CORS_ALLOWED_ORIGINS: `http://localhost:${webPort}`,
        NODE_ENV: "test",
      },
    });
    let apiOut = "";
    apiProc.stdout?.on("data", (d) => (apiOut += d.toString()));
    apiProc.stderr?.on("data", (d) => (apiOut += d.toString()));

    const apiOk = await esperarServidor(`http://localhost:${apiPort}/health`, 60_000);
    expect(apiOk, `apps/api no arrancó en 60s. Salida:\n${apiOut.slice(-4000)}`).toBeTruthy();

    // ---- Semilla del menú y las ubicaciones de QR por la API real (con el token de
    // un usuario `fnb` real de la seed) -- no existe todavía una UI de staff para dar
    // de alta el menú, así que se ejercita la API directamente, exactamente como lo
    // haría cualquier otro cliente HTTP real; lo que SÍ se verifica en el navegador es
    // la pantalla pública que un huésped ve al escanear el QR (el objeto de este REQ).
    const loginRes = await fetch(`http://localhost:${apiPort}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "fnb@hotel-demo-centro.demo", password: "atiende-dev-2026" }),
    });
    // No usar `.text()` para el mensaje de `expect` y luego `.json()` sobre la misma
    // `Response`: el cuerpo solo puede leerse una vez (`TypeError: Body is unusable:
    // Body has already been read`) -- se lee una sola vez como texto y se reusa.
    const loginBody = await loginRes.text();
    expect(loginRes.status, loginBody).toBe(200);
    const session = JSON.parse(loginBody) as { token: string; hoteles: { id: string; nombre: string }[] };
    const hotelId = session.hoteles.find((h) => h.nombre === "Hotel Demo Centro")!.id;
    const auth = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };

    const cevicheRes = await fetch(`http://localhost:${apiPort}/hoteles/${hotelId}/menu-items`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        nombre: "Ceviche de la casa",
        descripcion: "Pescado fresco del día con limón y cilantro",
        videoUrl,
        precio: 180,
        incluidoEnTodoIncluido: true,
        disponibleDayPass: true,
        recargoDayPass: 40,
        alergenos: ["pescado", "mariscos"],
      }),
    });
    expect(cevicheRes.status, await cevicheRes.text()).toBe(201);

    const corteRes = await fetch(`http://localhost:${apiPort}/hoteles/${hotelId}/menu-items`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        nombre: "Corte premium",
        videoUrl,
        precio: 650,
        incluidoEnTodoIncluido: false,
        disponibleDayPass: false,
      }),
    });
    expect(corteRes.status, await corteRes.text()).toBe(201);

    const mesaRes = await fetch(`http://localhost:${apiPort}/hoteles/${hotelId}/menu-qr/ubicaciones`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ tipoUbicacion: "mesa", numeroFisico: 7 }),
    });
    const mesaBody = await mesaRes.text();
    expect(mesaRes.status, mesaBody).toBe(201);
    const mesa = JSON.parse(mesaBody) as { locationCode: string };

    const camastroRes = await fetch(`http://localhost:${apiPort}/hoteles/${hotelId}/menu-qr/ubicaciones`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ tipoUbicacion: "camastro", numeroFisico: 3 }),
    });
    const camastroBody = await camastroRes.text();
    expect(camastroRes.status, camastroBody).toBe(201);
    const camastro = JSON.parse(camastroBody) as { locationCode: string };

    // Verificación literal del criterio de aceptación: "2 QR distintos -> 2
    // location_code distintos".
    expect(mesa.locationCode).not.toBe(camastro.locationCode);

    // ---- apps/web (vite dev) ----
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

    // ---- Pantalla pública del huésped que escaneó el QR de la mesa 7 ----
    await page.goto(`http://localhost:${webPort}/menu/${mesa.locationCode}`);
    await expect(page.getByRole("heading", { name: /Mesa 7/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(mesa.locationCode)).toBeVisible();

    // "menú QR CON VIDEO": el elemento <video> real carga el archivo (readyState > 0),
    // no un placeholder de imagen ni un enlace roto.
    const videos = page.locator("video");
    await expect(videos).toHaveCount(2);
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("video")).every((v) => (v as HTMLVideoElement).readyState > 0),
      undefined,
      { timeout: 15_000 },
    );

    // Regla por defecto (tarifa "a la carta"): ambos platillos a precio de lista.
    await expect(page.getByText("$180.00")).toBeVisible();
    await expect(page.getByText("$650.00")).toBeVisible();

    // Alérgenos multilingües en español por defecto.
    await expect(page.getByText(/Contiene: Pescado, Mariscos/)).toBeVisible();

    const vp = testInfo.project.use.viewport;
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `menu-qr-alacarta-${vp?.width}x${vp?.height}.png`),
      fullPage: true,
    });

    // ---- Regla de todo-incluido aplicada en vivo ----
    await page.getByLabel("Tu tarifa").selectOption("all_inclusive");
    await expect(page.getByText("Incluido")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("$650.00")).toBeVisible();
    await expect(page.getByText("$180.00")).toHaveCount(0);

    // ---- Regla de day-pass aplicada: el corte premium desaparece del menú ----
    await page.getByLabel("Tu tarifa").selectOption("day_pass");
    await expect(page.getByRole("heading", { name: "Corte premium" })).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText("$220.00")).toBeVisible(); // 180 + 40 de recargo day-pass

    // ---- Alérgenos multilingües: cambio de idioma a inglés ----
    await page.getByRole("button", { name: "English" }).click();
    await expect(page.getByText(/Contains: Fish, Shellfish/)).toBeVisible({ timeout: 10_000 });

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `menu-qr-reglas-${vp?.width}x${vp?.height}.png`),
      fullPage: true,
    });

    // ---- El mismo menú también está disponible en el camastro (otro tipo de
    // ubicación, otro QR, otro location_code) -- REQ-AB-001: "disponible en
    // habitación/alberca/camastro/playa/mesa". ----
    await page.goto(`http://localhost:${webPort}/menu/${camastro.locationCode}`);
    await expect(page.getByRole("heading", { name: /Camastro 3/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(camastro.locationCode)).toBeVisible();
  } finally {
    matarProceso(apiProc);
    matarProceso(webProc);
    try {
      await fs.rm(dataDir, { recursive: true, force: true });
    } catch {
      /* ya no existe */
    }
  }
});
