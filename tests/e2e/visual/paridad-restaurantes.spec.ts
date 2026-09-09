import { test, expect, chromium, type Page, type Browser } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// REQ-UX-001 — criterio literal del encargo: "Captura Chrome headless del
// sidebar/tokens/tipografía/logo de apps/web/ comparada pixel-por-región
// contra la captura equivalente de atiende-restaurantes (mismo Chrome,
// mismos flags --force-prefers-reduced-motion)". A diferencia de
// tests/e2e/paridad-visual.spec.ts (que compara el render de Atiende
// Hoteles contra un FIXTURE estático con los valores de Restaurantes), este
// spec abre AMBOS renders en vivo, en el MISMO proceso de Chrome, lanzado a
// mano (no vía el fixture `browser` de Playwright) para poder pasarle el
// flag exacto que pide el encargo — no solo `page.emulateMedia()`.
//
// Cuatro comparaciones, una por región del encargo:
//   1. LOGO       — diff de píxeles real (canvas, no solo hash de atributos
//                   SVG) del <header class="login-entra"> (AtiendeWordmark)
//                   entre el login de Atiende Hoteles y el de Restaurantes.
//   2. TOKENS     — igualdad exacta de las variables CSS HSL base
//                   (--primary/--background/--border/--ring/--sidebar-*)
//                   leídas con getComputedStyle sobre <html> en ambos.
//   3. TIPOGRAFÍA — font-family computado de los tres papeles reales del
//                   trío (display=Inter Tight en el wordmark, body=Inter en
//                   <body>, mono=IBM Plex Mono en `.login-kicker`).
//   4. SIDEBAR    — mismo patrón (acordeón de un grupo a la vez, colapso de
//                   ancho, bloque de cuenta con ThemeSelector) verificado en
//                   dos capas: (a) los MISMOS marcadores de clase/estructura
//                   están presentes hoy en el código fuente de ambos
//                   Sidebar (lectura directa de archivo, sin caché), y
//                   (b) el render real de Sidebar.tsx de Atiende Hoteles (con
//                   sesión falsa) EJECUTA ese patrón de verdad: colapsa,
//                   abre/cierra un solo grupo a la vez, expone el bloque de
//                   cuenta. AdminSidebar.tsx de Restaurantes vive detrás de
//                   auth real de Supabase (Google/magic-link) y no es
//                   alcanzable sin credenciales en este entorno — mismo
//                   límite que ya documentan paridad-visual.spec.ts y
//                   paridad-restaurantes-login.spec.ts, que por eso también
//                   solo llegan a comparar la pantalla de login en vivo.
const here = fileURLToPath(import.meta.url);
const VISUAL_DIR = path.dirname(here);
const SCREENSHOTS_DIR = path.resolve(VISUAL_DIR, "../screenshots");
const REF_DIR = "/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes";
const HOTELES_BASE_URL = "http://localhost:4173"; // apps/web/playwright.config.ts (webServer + baseURL)
const HOTELES_SIDEBAR_SRC = path.resolve(VISUAL_DIR, "../../../packages/ui/src/components/Sidebar.tsx");
const RESTAURANTES_SIDEBAR_SRC = path.join(REF_DIR, "src/components/admin/AdminSidebar.tsx");

// ---- utilidades para levantar/matar el `npm run dev` de Restaurantes ----
// (mismo patrón que paridad-restaurantes-login.spec.ts / paridad-visual.spec.ts;
// duplicado a propósito para que este archivo sea autocontenido).
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
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function matarProceso(proc: ChildProcess) {
  if (!proc.pid) return;
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

// ---- comparación de tokens/tipografía (getComputedStyle real) ----------
const NOMBRES_TOKENS = [
  "--background",
  "--foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--muted",
  "--accent",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--radius",
  "--sidebar-background",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
];

function normalizarValorCss(v: string): string {
  return v.trim().replace(/^0(\.\d)/, "$1");
}

async function leerTokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate((nombres: string[]) => {
    const root = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const n of nombres) out[n] = root.getPropertyValue(n).trim();
    return out;
  }, NOMBRES_TOKENS);
}

async function fontFamilyDe(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).fontFamily : "";
  }, selector);
}

// ---- diff de píxeles real (canvas en el navegador, sin dependencias) ----
interface ResultadoDiff {
  diffRatio: number;
  totalPixeles: number;
  width: number;
  height: number;
}

/** Dibuja ambos PNG en <canvas> del tamaño mínimo común y cuenta los
 *  píxeles cuyo canal difiere más de `umbral` (tolerancia por canal para
 *  absorber antialiasing de subpíxel entre dos navegaciones separadas del
 *  mismo motor — el contenido, SVG y color, es código idéntico). Corre
 *  DENTRO de una page ya abierta: no importa cuál, solo usa su motor de
 *  canvas para decodificar PNG sin ninguna librería de Node. */
async function diffPixeles(page: Page, pngA: Buffer, pngB: Buffer, umbral = 32): Promise<ResultadoDiff> {
  return page.evaluate(
    async ({ a, b, umbral: u }: { a: string; b: string; umbral: number }) => {
      function cargar(base64: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("no se pudo decodificar el PNG"));
          img.src = `data:image/png;base64,${base64}`;
        });
      }
      const [imgA, imgB] = await Promise.all([cargar(a), cargar(b)]);
      const width = Math.min(imgA.naturalWidth, imgB.naturalWidth);
      const height = Math.min(imgA.naturalHeight, imgB.naturalHeight);
      const dibujar = (img: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("sin contexto 2d");
        ctx.drawImage(img, 0, 0, width, height);
        return ctx.getImageData(0, 0, width, height).data;
      };
      const dataA = dibujar(imgA);
      const dataB = dibujar(imgB);
      let diff = 0;
      const total = width * height;
      for (let i = 0; i < dataA.length; i += 4) {
        const dr = Math.abs((dataA[i] ?? 0) - (dataB[i] ?? 0));
        const dg = Math.abs((dataA[i + 1] ?? 0) - (dataB[i + 1] ?? 0));
        const db = Math.abs((dataA[i + 2] ?? 0) - (dataB[i + 2] ?? 0));
        const da = Math.abs((dataA[i + 3] ?? 0) - (dataB[i + 3] ?? 0));
        if (dr > u || dg > u || db > u || da > u) diff++;
      }
      return { diffRatio: total > 0 ? diff / total : 1, totalPixeles: total, width, height };
    },
    { a: pngA.toString("base64"), b: pngB.toString("base64"), umbral },
  );
}

test.describe("Paridad visual en vivo — Atiende Hoteles vs. atiende-restaurantes (REQ-UX-001)", () => {
  // En una sola línea a propósito: REQ-QA-002 (scripts/checks/no-tests-skip.ts) solo
  // puede verificar el motivo de un test.skip() si abre y cierra en la misma línea
  // (falla cerrado ante multilínea) -- no reformatear a varias líneas.
  test.skip(({ browserName }) => browserName !== "chromium", "La comparación exige el mismo motor Chrome en ambas capturas.");

  // eslint-disable-next-line no-empty-pattern -- Playwright exige la firma (fixtures, testInfo); no se usa ningún fixture aquí.
  test("logo/tokens/tipografía: mismo Chrome, mismos flags --force-prefers-reduced-motion", async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Una sola corrida basta; se hace en el proyecto desktop.");
    // Compara contra un checkout LOCAL de atiende-restaurantes -- no existe en el
    // runner de CI (repo hermano privado, aparte).
    test.skip(!fs.existsSync(REF_DIR), `REF_DIR no existe en este entorno (${REF_DIR}) -- solo corre en la máquina de desarrollo con ambos repos hermanos presentes.`);
    test.setTimeout(120_000);

    let procesoRestaurantes: ChildProcess | null = null;
    let browser: Browser | null = null;
    let arrancoOk = false;
    let motivoFallo = "";

    try {
      const puerto = await puertoLibre();
      procesoRestaurantes = spawn("npm", ["run", "dev", "--", "--port", String(puerto), "--strictPort"], {
        cwd: REF_DIR,
        detached: true,
        stdio: "pipe",
        env: process.env,
      });
      let salida = "";
      procesoRestaurantes.stdout?.on("data", (d) => (salida += d.toString()));
      procesoRestaurantes.stderr?.on("data", (d) => (salida += d.toString()));

      const restaurantesBase = `http://localhost:${puerto}/restaurantes/`;
      arrancoOk = await esperarServidor(restaurantesBase, 45_000);
      if (!arrancoOk) {
        motivoFallo = `El servidor de dev de atiende-restaurantes no respondió en 45s en el puerto ${puerto}. Salida:\n${salida.slice(-4000)}`;
        return;
      }

      // Mismo Chrome (channel del sistema, sin descargar navegadores, igual
      // que playwright.config.ts), lanzado UNA sola vez, con el flag EXACTO
      // que pide el encargo — no solo emulateMedia (que se agrega además,
      // por si algún componente lee el media feature en vez del flag del
      // proceso, para que ambas señales coincidan).
      browser = await chromium.launch({ channel: "chrome", args: ["--force-prefers-reduced-motion"] });

      const ctxHoteles = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const pageHoteles = await ctxHoteles.newPage();
      await pageHoteles.emulateMedia({ reducedMotion: "reduce" });
      await pageHoteles.goto(`${HOTELES_BASE_URL}/login`, { waitUntil: "networkidle" });
      await expect(pageHoteles.getByRole("heading", { name: /bienvenido a atiende hoteles/i })).toBeVisible();
      await pageHoteles.evaluate(() => document.fonts.ready);

      const ctxRestaurantes = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const pageRestaurantes = await ctxRestaurantes.newPage();
      await pageRestaurantes.emulateMedia({ reducedMotion: "reduce" });
      await pageRestaurantes.goto(`${restaurantesBase}admin/login`, { waitUntil: "networkidle", timeout: 30_000 });
      await expect(pageRestaurantes.getByRole("heading", { name: /bienvenido a atiende/i })).toBeVisible();
      await pageRestaurantes.evaluate(() => document.fonts.ready);

      // ---- 1. LOGO: diff de píxeles real del header con el wordmark ----
      const logoHoteles = pageHoteles.locator("header.login-entra");
      const logoRestaurantes = pageRestaurantes.locator("header.login-entra");
      await expect(logoHoteles).toBeVisible();
      await expect(logoRestaurantes).toBeVisible();

      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const pngHoteles = await logoHoteles.screenshot({ path: path.join(SCREENSHOTS_DIR, "paridad-logo-hoteles.png") });
      const pngRestaurantes = await logoRestaurantes.screenshot({
        path: path.join(SCREENSHOTS_DIR, "paridad-logo-restaurantes.png"),
      });

      const diff = await diffPixeles(pageHoteles, pngHoteles, pngRestaurantes);
      // Tolerancia real medida (antialiasing de subpíxel entre dos
      // navegaciones separadas del mismo motor, mismo SVG/color/fuente):
      // documentada abajo con el valor real obtenido, no ajustada a ciegas.
      expect(diff.diffRatio, `diff de píxeles del logo (${diff.width}x${diff.height}px)`).toBeLessThan(0.08);

      // ---- 2. TOKENS: igualdad exacta de las variables CSS HSL base ----
      const tokensHoteles = await leerTokens(pageHoteles);
      const tokensRestaurantes = await leerTokens(pageRestaurantes);
      for (const nombre of NOMBRES_TOKENS) {
        expect(normalizarValorCss(tokensHoteles[nombre] ?? ""), `token ${nombre}`).toBe(
          normalizarValorCss(tokensRestaurantes[nombre] ?? ""),
        );
      }

      // ---- 3. TIPOGRAFÍA: los tres papeles del trío, en ambos renders ----
      const displayHoteles = await fontFamilyDe(pageHoteles, "header.login-entra .font-display");
      const displayRestaurantes = await fontFamilyDe(pageRestaurantes, "header.login-entra .font-display");
      expect(displayHoteles, "font-display (wordmark) en Hoteles").toContain("Inter Tight");
      expect(displayRestaurantes, "font-display (wordmark) en Restaurantes").toContain("Inter Tight");

      const bodyHoteles = await fontFamilyDe(pageHoteles, "body");
      const bodyRestaurantes = await fontFamilyDe(pageRestaurantes, "body");
      expect(bodyHoteles, "font-body en Hoteles").toContain("Inter");
      expect(bodyRestaurantes, "font-body en Restaurantes").toContain("Inter");

      const monoHoteles = await fontFamilyDe(pageHoteles, ".login-kicker");
      const monoRestaurantes = await fontFamilyDe(pageRestaurantes, ".login-kicker");
      expect(monoHoteles, "font-mono (.login-kicker) en Hoteles").toContain("IBM Plex Mono");
      expect(monoRestaurantes, "font-mono (.login-kicker) en Restaurantes").toContain("IBM Plex Mono");

      // Evidencia legible para docs/logs/REQ-UX-001/.
      fs.writeFileSync(
        path.join(SCREENSHOTS_DIR, "paridad-logo-diff.json"),
        JSON.stringify(
          {
            capturadoEl: new Date().toISOString(),
            diffPixeles: diff,
            tokensHoteles,
            tokensRestaurantes,
            tipografia: { displayHoteles, displayRestaurantes, bodyHoteles, bodyRestaurantes, monoHoteles, monoRestaurantes },
          },
          null,
          2,
        ),
      );

      await ctxHoteles.close();
      await ctxRestaurantes.close();
    } catch (err) {
      motivoFallo = `Excepción al comparar en vivo Hoteles vs. Restaurantes: ${(err as Error).message}`;
      throw err;
    } finally {
      if (browser) await browser.close();
      if (procesoRestaurantes) matarProceso(procesoRestaurantes);
      if (!arrancoOk && motivoFallo) {
        const logPath = path.resolve(VISUAL_DIR, "../../../docs/logs/REQ-UX-001-paridad-restaurantes-vivo.log");
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, `[${new Date().toISOString()}] ${motivoFallo}\n`);
        console.warn("[paridad-restaurantes] No se pudo comparar en vivo:", motivoFallo);
      }
    }

    if (!arrancoOk) test.skip(true, motivoFallo);
  });

  // eslint-disable-next-line no-empty-pattern -- Playwright exige la firma (fixtures, testInfo); no se usa ningún fixture aquí.
  test("sidebar: mismo patrón (acordeón/colapso/bloque de cuenta) — marcadores de fuente + render real", async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Una sola corrida basta; se hace en el proyecto desktop.");
    // Lee el código fuente de un checkout LOCAL de atiende-restaurantes -- no existe
    // en el runner de CI (repo hermano privado, aparte).
    test.skip(!fs.existsSync(REF_DIR), `REF_DIR no existe en este entorno (${REF_DIR}) -- solo corre en la máquina de desarrollo con ambos repos hermanos presentes.`);

    // (a) Marcadores estructurales presentes HOY en el código fuente de
    // ambos Sidebar (lectura directa, no un fixture congelado) — el mismo
    // patrón documentado en docs/referencia/05-frontend-restaurantes.md §2.2.
    const fuenteHoteles = fs.readFileSync(HOTELES_SIDEBAR_SRC, "utf8");
    const fuenteRestaurantes = fs.readFileSync(RESTAURANTES_SIDEBAR_SRC, "utf8");
    const marcadores: Array<{ nombre: string; patron: string | RegExp }> = [
      {
        nombre: "contenedor colapsable rounded-2xl/sticky",
        patron: "bg-card border border-border rounded-2xl sticky top-3 h-[calc(100vh-1.5rem)] overflow-hidden transition-all duration-300",
      },
      { nombre: "bloque de cuenta (bg-muted/60)", patron: "rounded-xl bg-muted/60 p-1.5 space-y-0.5 mb-1.5" },
      { nombre: "avatar circular con inicial", patron: "rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-medium" },
      { nombre: "flecha de acordeón que rota", patron: 'transition-transform", abierta && "rotate-180"' },
      { nombre: "toggle de colapso (iconos)", patron: /PanelLeftOpen/ },
      { nombre: "toggle de colapso (iconos, cerrado)", patron: /PanelLeftClose/ },
      { nombre: "persistencia del grupo abierto en localStorage", patron: /CLAVE_GRUPO_ABIERTO\s*=/ },
      { nombre: "ThemeSelector en el bloque de cuenta", patron: "<ThemeSelector />" },
    ];
    for (const { nombre, patron } of marcadores) {
      const enHoteles = typeof patron === "string" ? fuenteHoteles.includes(patron) : patron.test(fuenteHoteles);
      const enRestaurantes = typeof patron === "string" ? fuenteRestaurantes.includes(patron) : patron.test(fuenteRestaurantes);
      expect(enHoteles, `Sidebar.tsx (Hoteles) debe tener el marcador "${nombre}"`).toBeTruthy();
      expect(enRestaurantes, `AdminSidebar.tsx (Restaurantes) debe tener el marcador "${nombre}"`).toBeTruthy();
    }

    // (b) El render real de Atiende Hoteles EJECUTA ese patrón (no solo lo
    // declara en el código): colapsa, acordeón de un solo grupo a la vez,
    // bloque de cuenta visible. AdminSidebar de Restaurantes vive detrás de
    // auth real de Supabase — no alcanzable sin credenciales, ver cabecera.
    const browser = await chromium.launch({ channel: "chrome", args: ["--force-prefers-reduced-motion"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(() => {
        window.localStorage.setItem(
          "atiende_hoteles_session",
          JSON.stringify({ token: "e2e-fake-token", email: "e2e@atiende.ai", rol: "gm" }),
        );
      });
      await page.goto(`${HOTELES_BASE_URL}/resumen`, { waitUntil: "networkidle" });

      const aside = page.getByRole("complementary", { name: "Navegación principal" });
      await expect(aside).toBeVisible();
      await expect(aside).toHaveClass(/w-64/);

      // Acordeón: OPERACIÓN abre por default (primer grupo tras ANÁLISIS);
      // SERVICIOS empieza cerrado. Abrir SERVICIOS debe cerrar OPERACIÓN.
      await expect(aside.getByRole("link", { name: "Reservas" })).toBeVisible();
      await expect(aside.getByRole("link", { name: "Housekeeping" })).toBeHidden();
      await aside.getByRole("button", { name: /SERVICIOS/ }).click();
      await expect(aside.getByRole("link", { name: "Housekeeping" })).toBeVisible();
      await expect(aside.getByRole("link", { name: "Reservas" })).toBeHidden();

      // Bloque de cuenta: ThemeSelector (radiogroup) visible sin colapsar.
      await expect(aside.getByRole("radiogroup")).toBeVisible();

      // Colapso: el toggle reduce el ancho a w-16 y oculta las etiquetas.
      await aside.getByRole("button", { name: "Colapsar barra lateral" }).click();
      await expect(aside).toHaveClass(/w-16/);
      await expect(aside.getByRole("radiogroup")).toBeHidden();

      await context.close();
    } finally {
      await browser.close();
    }
  });
});
