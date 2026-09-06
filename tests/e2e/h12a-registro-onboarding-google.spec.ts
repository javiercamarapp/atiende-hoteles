import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import pg from "pg";
import { startFakeGoogleOAuthServer, type FakeGoogleOAuthServer } from "../support/fakeGoogleOAuth.ts";

// H12a · REQ-LAUNCH: recorrido E2E real del alta autoservicio completa (registro →
// verificación de correo LEÍDA DE LA BASE, el mismo mecanismo que "el correo capturado
// por el proveedor fake" que pide el encargo → onboarding → invitar equipo) y del login
// con Google (servidor OAuth FALSO real, tests/support/fakeGoogleOAuth.ts) contra
// apps/api + apps/web arrancados de verdad (mismo patrón que
// tests/e2e/login-real-y-resumen.spec.ts) -- nunca contra Google real, nunca datos
// simulados en el cliente.
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

test.describe.serial("H12a · registro → verificación → onboarding → Google", () => {
  test.setTimeout(180_000);

  let apiProc: ChildProcess | null = null;
  let webProc: ChildProcess | null = null;
  let dataDir = "";
  let apiPort = 0;
  let webPort = 0;
  let dbPort = 0;
  let dbClient: pg.Client | null = null;
  let fakeGoogle: FakeGoogleOAuthServer | null = null;

  test.beforeAll(async () => {
    // El timeout default de un hook (30s) no alcanza para levantar apps/api
    // (embedded-postgres + migraciones + seed) y apps/web (vite dev) de verdad --
    // `test.setTimeout()` dentro del propio hook extiende ESTE hook, independiente del
    // `test.setTimeout(180_000)` de arriba (que solo cubre el cuerpo de cada `test`).
    test.setTimeout(120_000);
    fakeGoogle = await startFakeGoogleOAuthServer();

    apiPort = await puertoLibre();
    dbPort = await puertoLibre();
    webPort = await puertoLibre();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "atiende-hoteles-e2e-h12a-"));

    apiProc = spawn("node", ["--experimental-transform-types", "src/server.ts"], {
      cwd: API_DIR,
      detached: true,
      stdio: "pipe",
      env: {
        ...process.env,
        PORT: String(apiPort),
        DB_PORT: String(dbPort),
        DB_DATA_DIR: dataDir,
        JWT_SECRET: "e2e-h12a-jwt-secret-no-usar-en-produccion",
        CORS_ALLOWED_ORIGINS: `http://localhost:${webPort}`,
        FRONTEND_URL: `http://localhost:${webPort}`,
        NODE_ENV: "test",
        // Google OAuth apuntado al servidor FALSO -- nunca a accounts.google.com real.
        GOOGLE_CLIENT_ID: fakeGoogle.clientId,
        GOOGLE_CLIENT_SECRET: fakeGoogle.clientSecret,
        GOOGLE_REDIRECT_URI: `http://localhost:${apiPort}/auth/google/callback`,
        GOOGLE_OAUTH_BASE_URL: fakeGoogle.baseUrl,
        GOOGLE_TOKEN_URL: fakeGoogle.tokenUrl,
        GOOGLE_JWKS_URL: fakeGoogle.jwksUrl,
        GOOGLE_ISSUER: fakeGoogle.issuer,
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

    // Conexión directa al Postgres embebido REAL de este apps/api (superusuario,
    // mismas credenciales que packages/db/src/db.ts/engines.ts usan internamente para
    // el servidor de desarrollo) -- simula "leer el correo capturado por el proveedor
    // fake": el token de verificación vive en `account_token`, nunca se inventa.
    dbClient = new pg.Client({ host: "127.0.0.1", port: dbPort, user: "postgres", password: "postgres_dev_only_local", database: "postgres" });
    await dbClient.connect();
  });

  test.afterAll(async () => {
    await dbClient?.end().catch(() => undefined);
    matarProceso(apiProc);
    matarProceso(webProc);
    await fakeGoogle?.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const ownerEmail = `e2e-h12a-owner-${Date.now()}@example.com`;
  const password = "Contrasena2026E2E";

  test("1. registro: formulario → revisa tu correo", async ({ page }) => {
    await page.goto(`http://localhost:${webPort}/registro`);
    await expect(page.getByRole("heading", { name: /registra tu hotel/i })).toBeVisible();
    await page.screenshot({ path: "tests/e2e/screenshots/h12a-registro-formulario.png", fullPage: true });

    await page.getByPlaceholder("Nombre del hotel").fill("Hotel E2E Amanecer");
    await page.getByPlaceholder("Ciudad").fill("Playa del Carmen");
    await page.locator("#reg-estado").selectOption("Quintana Roo");
    await page.getByPlaceholder("Tu nombre completo").fill("Dueña E2E");
    await page.getByPlaceholder("tu@hotel.com").fill(ownerEmail);
    await page.getByPlaceholder(/mínimo 10 caracteres/).fill(password);
    await page.getByPlaceholder("Confirma tu contraseña").fill(password);
    await page.getByRole("button", { name: /crear mi cuenta/i }).click();

    await expect(page.getByText(/revisa tu correo/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(ownerEmail)).toBeVisible();
    await page.screenshot({ path: "tests/e2e/screenshots/h12a-registro-revisa-correo.png", fullPage: true });
  });

  test("2. verificación de correo (token leído de la base, simulando el correo capturado por el proveedor fake)", async ({ page }) => {
    const { rows } = await dbClient!.query<{ token: string }>(
      "select token from public.account_token where email = $1 and purpose = 'verificar_correo' order by created_at desc limit 1;",
      [ownerEmail],
    );
    expect(rows.length).toBe(1);
    const token = rows[0]!.token;

    await page.goto(`http://localhost:${webPort}/registro/verificar?token=${token}`);
    await expect(page.getByText(/correo confirmado/i)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "tests/e2e/screenshots/h12a-verificar-correo.png", fullPage: true });
  });

  test("3. onboarding: login → tipo de habitación → zona horaria → invitar equipo", async ({ page }) => {
    await page.goto(`http://localhost:${webPort}/login`);
    await page.getByLabel("Tu correo").fill(ownerEmail);
    await page.getByLabel("Contraseña").fill(password);
    await page.getByRole("button", { name: /^entrar$/i }).click();
    await page.waitForURL(/\/resumen$/, { timeout: 15_000 });

    await page.goto(`http://localhost:${webPort}/onboarding`);
    await expect(page.getByRole("heading", { name: /configura tu hotel/i })).toBeVisible();

    await page.getByLabel("Nombre del tipo de habitación").fill("Estándar");
    await page.getByLabel("Número de habitaciones").fill("6");
    await page.getByLabel("Precio base por noche (MXN)").fill("1500");
    await page.getByRole("button", { name: /agregar tipo de habitación/i }).click();
    await expect(page.getByRole("cell", { name: "Estándar" })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: "tests/e2e/screenshots/h12a-onboarding-habitaciones.png", fullPage: true });

    await page.getByRole("tab", { name: /zona horaria/i }).click();
    await page.getByRole("button", { name: /guardar zona horaria/i }).click();
    await expect(page.getByText(/zona horaria actualizada/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /siguiente: invitar equipo/i }).click();

    const equipoEmail = `e2e-invitado-${Date.now()}@example.com`;
    await page.getByLabel("Correo").fill(equipoEmail);
    await page.getByRole("button", { name: /^invitar$/i }).click();
    await expect(page.getByRole("cell", { name: equipoEmail })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: "tests/e2e/screenshots/h12a-onboarding-equipo.png", fullPage: true });
  });

  test("4. login con Google (servidor falso): recorre TODA la cadena de redirecciones hasta /resumen", async ({ page }) => {
    fakeGoogle!.setNextUser({ sub: "e2e-google-sub-1", email: ownerEmail, emailVerified: true, name: "Dueña E2E" });

    await page.goto(`http://localhost:${apiPort}/auth/google/iniciar?purpose=login`);
    await page.waitForURL(new RegExp(`localhost:${webPort}/resumen`), { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
    await page.screenshot({ path: "tests/e2e/screenshots/h12a-google-login-resumen.png", fullPage: true });
  });

  test("5. login con Google, correo no verificado: termina en /login con el error humano", async ({ page }) => {
    fakeGoogle!.setNextUser({ sub: "e2e-google-sub-2", email: "otra-persona@example.com", emailVerified: false });

    await page.goto(`http://localhost:${apiPort}/auth/google/iniciar?purpose=login`);
    await page.waitForURL(new RegExp(`localhost:${webPort}/login\\?google_error=`), { timeout: 15_000 });
    await expect(page.getByText(/no tiene el correo verificado/i)).toBeVisible();
    await page.screenshot({ path: "tests/e2e/screenshots/h12a-google-error.png", fullPage: true });
  });
});
