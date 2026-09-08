import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { sembrarSesionFalsa } from "./utils/session";

// REQ-UX-002 (ACEPTACION.md §criterio 10): "Pantalla de reportes/dashboard consultada
// sin datos reales cargados → muestra 'Sin datos'/'Sin datos aún', nunca una cifra
// simulada ni un error crudo; integración bloqueada por falta de credenciales muestra
// el estado 'pendiente de credenciales' explícito." Dos escenarios reales, ninguno con
// datos de negocio fabricados en el cliente:
//
//   A) Backend real (apps/api + embedded-postgres efímero) recién sembrado
//      (`packages/db/src/seed.ts`): la seed crea org/hoteles/tipos de habitación/tarifa/
//      disponibilidad/personal, pero A PROPÓSITO no siembra ninguna reserva, tarea de
//      housekeeping, ticket de mantenimiento, conversación ni solicitud de aprobación.
//      Con la API real respondiendo y filas real y genuinamente vacías, cada pantalla
//      debe mostrar su `EstadoVacio` honesto (nunca un cero/lista fabricados).
//   B) Sin backend disponible en absoluto (build de `vite preview` sin `VITE_API_URL`,
//      mismo patrón que axe-accesibilidad.spec.ts): cada pantalla debe mostrar
//      `EstadoError` con el badge explícito "Pendiente de credenciales", nombrando la
//      integración -- nunca un stack trace ni una pantalla en blanco.
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

// Frases que NUNCA deberían aparecer en una pantalla honesta: indicios de que se
// fabricó un dato o se dejó escapar un detalle técnico crudo en vez de un mensaje
// accionable.
const PROHIBIDO = [/undefined/i, /\bnan\b/i, /TypeError/, /at Object\./, /\$0\.00\b/];

function assertSinFabricarNiStackTrace(texto: string) {
  for (const patron of PROHIBIDO) {
    expect(texto, `texto sospechoso de dato fabricado o stack trace: ${patron}`).not.toMatch(patron);
  }
}

test.describe("REQ-UX-002 · A) backend real, datos genuinamente vacíos (seed sin reservas/tareas/tickets)", () => {
  // Setup/teardown inline en el propio test (no beforeAll/afterAll): el timeout por
  // defecto de un hook de Playwright es 30s, insuficiente para el arranque en frío de
  // embedded-postgres (extraer binario + initdb + migraciones + seed) -- mismo patrón
  // que h4-reserva-real-desde-ui.spec.ts/h6-housekeeping-mantenimiento-mensajeria.spec.ts,
  // donde `test.setTimeout(...)` sí cubre todo el cuerpo del test.
  test("login real y recorrido de pantallas con datos reales pero vacíos", async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const apiPort = await puertoLibre();
    const dbPort = await puertoLibre();
    const webPort = await puertoLibre();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atiende-hoteles-e2e-ux002-"));

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

      await ejecutarRecorrido(page, testInfo, webPort);
    } finally {
      matarProceso(apiProc);
      matarProceso(webProc);
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

async function ejecutarRecorrido(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo, webPort: number) {
  const vp = testInfo.project.use.viewport;

  await page.goto(`http://localhost:${webPort}/login`);
    await page.getByLabel("Tu correo").fill("gm@hotel-demo-centro.demo");
    await page.getByLabel("Contraseña").fill("atiende-dev-2026");
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/resumen$/, { timeout: 15_000 });

    // ---- /reservas: 0 reservas reales (la seed nunca inserta ninguna) ----
    await page.goto(`http://localhost:${webPort}/reservas`);
    await expect(page.getByRole("heading", { name: "Reservas" })).toBeVisible();
    await expect(page.getByText("No hay reservas registradas todavía para este hotel.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Sin conexión con el API")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    assertSinFabricarNiStackTrace((await page.locator("body").innerText()) ?? "");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `ux002-reservas-vacio-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- /huespedes: 0 huéspedes ----
    await page.goto(`http://localhost:${webPort}/huespedes`);
    await expect(page.getByRole("heading", { name: "Huéspedes" })).toBeVisible();
    await expect(page.getByText("No hay huéspedes registrados todavía para este hotel.")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `ux002-huespedes-vacio-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- /mantenimiento: 0 tickets ----
    await page.goto(`http://localhost:${webPort}/mantenimiento`);
    await expect(page.getByRole("heading", { name: "Mantenimiento" })).toBeVisible();
    await expect(page.getByText("No hay tickets de mantenimiento registrados.")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `ux002-mantenimiento-vacio-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- /mensajeria: 0 conversaciones ----
    await page.goto(`http://localhost:${webPort}/mensajeria`);
    await expect(page.getByRole("heading", { name: "Mensajería" })).toBeVisible();
    await expect(page.getByText("No hay conversaciones activas.")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `ux002-mensajeria-vacio-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- /aprobaciones: 0 solicitudes ----
    await page.goto(`http://localhost:${webPort}/aprobaciones`);
    await expect(page.getByRole("heading", { name: "Aprobaciones" })).toBeVisible();
    await expect(page.getByText("No hay solicitudes de aprobación.")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `ux002-aprobaciones-vacio-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- /resumen: la API real respondió (nunca "Sin conexión"); el ROI todavía no
    // tiene ningún evento real -- "Sin datos todavía", nunca un monto inventado.
    await page.goto(`http://localhost:${webPort}/resumen`);
    await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
    await expect(page.getByText("Sin conexión con el API")).toHaveCount(0);
    await expect(page.getByText(/ningún agente ha registrado un evento de ROI este período/)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `ux002-resumen-roi-vacio-${vp?.width}x${vp?.height}.png`), fullPage: true });

    // ---- /alimentos-bebidas y /reputacion: módulos sin backend construido todavía --
    // NUNCA una llamada fantasma a una ruta 404 ni una atribución falsa a
    // "credenciales"/"conexión": honesto "módulo no implementado" (REQ-UX-002, mismo
    // hallazgo ya corregido en AlimentosBebidas.tsx y ahora también en Reputacion.tsx).
    await page.goto(`http://localhost:${webPort}/alimentos-bebidas`);
    await expect(page.getByText("Módulo no implementado todavía")).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `ux002-alimentos-bebidas-no-implementado-${vp?.width}x${vp?.height}.png`), fullPage: true });

  await page.goto(`http://localhost:${webPort}/reputacion`);
  await expect(page.getByText("Módulo no implementado todavía")).toBeVisible();
  await expect(page.getByText(/no tiene backend construido en este repositorio todavía/)).toBeVisible();
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `ux002-reputacion-no-implementado-${vp?.width}x${vp?.height}.png`), fullPage: true });
}

test.describe("REQ-UX-002 · B) sin backend disponible: error accionable de 'pendiente de credenciales'", () => {
  // Mismo patrón que axe-accesibilidad.spec.ts: build de `vite preview` servido por el
  // webServer compartido de playwright.config.ts, SIN `VITE_API_URL` -- cada llamada a
  // la API real lanza `ApiUnavailableError` con `pendienteCredenciales: true` antes de
  // siquiera intentar la red (ver `lib/api.ts`). Sesión falsa solo para pasar el guard
  // de rutas (utils/session.ts) -- nunca datos de negocio de ejemplo.
  const RUTAS_PROTEGIDAS_CON_API = [
    { nombre: "resumen", ruta: "/resumen", encabezado: "Resumen" },
    { nombre: "reservas", ruta: "/reservas", encabezado: "Reservas" },
    { nombre: "huespedes", ruta: "/huespedes", encabezado: "Huéspedes" },
    { nombre: "mantenimiento", ruta: "/mantenimiento", encabezado: "Mantenimiento" },
    { nombre: "mensajeria", ruta: "/mensajeria", encabezado: "Mensajería" },
    { nombre: "aprobaciones", ruta: "/aprobaciones", encabezado: "Aprobaciones" },
    { nombre: "housekeeping", ruta: "/housekeeping", encabezado: "Housekeeping" },
    { nombre: "configuracion", ruta: "/configuracion", encabezado: "Configuración" },
    { nombre: "agentes", ruta: "/agentes", encabezado: "Agentes" },
  ];

  for (const { nombre, ruta, encabezado } of RUTAS_PROTEGIDAS_CON_API) {
    test(`${nombre}: sin VITE_API_URL → "Pendiente de credenciales" explícito, nunca un stack trace`, async ({ page }, testInfo) => {
      await sembrarSesionFalsa(page);
      await page.goto(ruta);
      await expect(page.getByRole("heading", { name: encabezado })).toBeVisible();

      // El estado explícito que exige ACEPTACION.md §criterio 10 -- puede venir del
      // banner global de AppShell (la lista de hoteles nunca cargó, ver
      // BannerHotelesBloqueado) o del badge/mensaje de EstadoError de la propia
      // pantalla; cualquiera de los dos basta, pero al menos uno debe estar presente.
      await expect(page.getByText(/pendiente de credenciales/i).first()).toBeVisible({ timeout: 15_000 });

      const texto = (await page.locator("body").innerText()) ?? "";
      assertSinFabricarNiStackTrace(texto);

      const vp = testInfo.project.use.viewport;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `ux002-${nombre}-pendiente-credenciales-${vp?.width}x${vp?.height}.png`), fullPage: true });
    });
  }

  // Un módulo sin backend construido nunca hace su propia llamada fantasma ni atribuye
  // su ausencia a "credenciales de Google/Booking/POS pendientes" -- sigue mostrando
  // honestamente "módulo no implementado", exactamente igual con o sin API disponible.
  // (El banner global de AppShell sobre hoteles sin cargar sí puede seguir visible: es
  // un hecho real de toda la sesión, no una atribución falsa de este módulo en concreto.)
  test("alimentos-bebidas y reputación: siguen mostrando 'módulo no implementado', nunca inventan su propia integración", async ({ page }) => {
    await sembrarSesionFalsa(page);

    await page.goto("/alimentos-bebidas");
    await expect(page.getByText("Módulo no implementado todavía")).toBeVisible();
    await expect(page.getByText(/POS/)).toBeVisible();

    await page.goto("/reputacion");
    await expect(page.getByText("Módulo no implementado todavía")).toBeVisible();
    await expect(page.getByText(/Google\/Booking\/TripAdvisor/)).toBeVisible();
  });
});
