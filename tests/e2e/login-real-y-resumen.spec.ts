import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// H2 punto 6: arranca apps/api (con seeds reales, embedded-postgres efímero) + apps/web
// (`vite dev`, para poder inyectar VITE_API_URL sin rebuild) y verifica un login REAL
// contra la API (credenciales de la seed, apps/api/README.md) y que Resumen muestra
// cifras reales calculadas por la API (ADR de la seed), no "Sin conexión con el API"
// ni datos simulados. Corre solo en el proyecto desktop (una vez basta) y aislado del
// webServer compartido de playwright.config.ts (puertos propios, servidores propios).
const API_DIR = path.resolve(import.meta.dirname, "../../apps/api");
const WEB_DIR = path.resolve(import.meta.dirname, "../../apps/web");

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

test("login real (credenciales de la seed) → Resumen con cifras reales calculadas por la API", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Basta una corrida; el flujo no depende del viewport.");
  test.setTimeout(120_000);

  const apiPort = await puertoLibre();
  const dbPort = await puertoLibre();
  const webPort = await puertoLibre();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atiende-hoteles-e2e-api-"));

  let apiProc: ChildProcess | null = null;
  let webProc: ChildProcess | null = null;

  try {
    apiProc = spawn("node", ["--experimental-strip-types", "src/server.ts"], {
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

    await page.goto(`http://localhost:${webPort}/login`);
    await expect(page.getByRole("heading", { name: /bienvenido a atiende hoteles/i })).toBeVisible();

    // Credenciales de desarrollo de la seed real (packages/db/src/seed.ts,
    // documentadas en apps/api/README.md) — NO un mock, login contra la API real.
    await page.getByLabel("Tu correo").fill("gm@hotel-demo-centro.demo");
    await page.getByLabel("Contraseña").fill("atiende-dev-2026");
    await page.getByRole("button", { name: /entrar/i }).click();

    await page.waitForURL(/\/resumen$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();

    // Nunca "Sin conexión con el API": la API real respondió.
    await expect(page.getByText("Sin conexión con el API")).toHaveCount(0);

    // ADR real de la seed (Estándar $1200 + Suite $2500 ponderado por 5 habitaciones
    // cada uno → promedio 1850) debe aparecer como cifra real, no como guion "—".
    await expect(page.getByText("$1850 MXN")).toBeVisible();
  } finally {
    matarProceso(apiProc);
    matarProceso(webProc);
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
