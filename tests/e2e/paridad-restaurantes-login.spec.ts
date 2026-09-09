import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";

// ACEPTACION §5 (paridad visual): captura la pantalla de login REAL de
// atiende-restaurantes levantando su propio `npm run dev` (SIN modificar
// nada de esa carpeta, sin leer/copiar su .env, sin iniciar sesión) para
// comparar contra tests/e2e/screenshots/hoteles-login-*.png. Mata el
// proceso al terminar, incluso si la captura falla.
const REF_DIR = "/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes";
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
      // Todavía no levanta; reintentar.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function matarProceso(proc: ChildProcess) {
  if (!proc.pid) return;
  try {
    // Grupo de procesos completo (npm → vite → esbuild) — spawn con
    // detached:true crea un nuevo grupo cuyo líder es proc.pid.
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* proceso ya no existe */
    }
  }
}

test("paridad: login real de atiende-restaurantes (referencia, solo lectura)", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Una sola captura de referencia basta; se corre solo en el proyecto desktop.");
  // Este test compara contra un checkout LOCAL de atiende-restaurantes en la máquina
  // de desarrollo -- no existe (ni debería, es un repo hermano privado aparte) en el
  // runner de CI. Fuera de la máquina de Javier, no hay nada real que comparar.
  test.skip(!fs.existsSync(REF_DIR), `REF_DIR no existe en este entorno (${REF_DIR}) -- este test de paridad visual solo corre en la máquina de desarrollo con ambos repos hermanos presentes.`);
  test.setTimeout(120_000);

  const puerto = await puertoLibre();
  let proceso: ChildProcess | null = null;
  let arrancoOk = false;
  let motivoFallo = "";

  try {
    proceso = spawn("npm", ["run", "dev", "--", "--port", String(puerto), "--strictPort"], {
      cwd: REF_DIR,
      detached: true,
      stdio: "pipe",
      env: process.env,
    });

    let salida = "";
    proceso.stdout?.on("data", (d) => (salida += d.toString()));
    proceso.stderr?.on("data", (d) => (salida += d.toString()));

    const url = `http://localhost:${puerto}/restaurantes/admin/login`;
    arrancoOk = await esperarServidor(`http://localhost:${puerto}/restaurantes/`, 45_000);

    if (!arrancoOk) {
      motivoFallo = `El servidor de desarrollo de atiende-restaurantes no respondió en 45s en el puerto ${puerto}. Salida del proceso:\n${salida.slice(-4000)}`;
    } else {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const refPage = await context.newPage();
      await refPage.emulateMedia({ reducedMotion: "reduce" });
      await refPage.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await refPage.screenshot({ path: path.join(SCREENSHOTS_DIR, "restaurantes-login.png"), fullPage: true });
      await context.close();
    }
  } catch (err) {
    motivoFallo = `Excepción al intentar levantar/capturar atiende-restaurantes: ${(err as Error).message}`;
  } finally {
    if (proceso) matarProceso(proceso);
  }

  if (!arrancoOk) {
    // Documentar el motivo en vez de fallar todo H3 por un repo externo que
    // este agente no controla ni puede modificar (encargo: "si no arranca,
    // documenta por qué"). Se registra en docs/logs/ y el test se marca
    // `skipped` (no `failed`) con la razón visible en el reporte.
    const logPath = path.resolve(import.meta.dirname, "../../docs/logs/h3-paridad-restaurantes.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] ${motivoFallo}\n`);
    console.warn("[paridad-restaurantes-login] No se pudo capturar el login real:", motivoFallo);
    test.skip(true, motivoFallo);
  }

  expect(arrancoOk).toBeTruthy();
});
