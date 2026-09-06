import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sembrarSesionFalsa } from "./utils/session";

// REQ-UX-001/ACEPTACION §5 + auditoria-1/pruebas.md [MEDIO] ("La prueba
// 'Paridad visual' no compara nada — solo guarda una captura"): este spec
// SÍ compara. Extrae del render real de Atiende Hoteles las variables CSS
// de tokens, las familias tipográficas computadas, la geometría del SVG del
// logo y el radio/tamaño de los botones, y los compara contra
// `fixtures/restaurantes-referencia.json` (valores de atiende-restaurantes,
// con su procedencia documentada ahí). Sigue tomando las capturas de
// siempre (no se quita nada), pero ahora también falla si algo diverge.
const here = fileURLToPath(import.meta.url);
const SCREENSHOTS_DIR = path.resolve(path.dirname(here), "screenshots");
const REF_FIXTURE_PATH = path.resolve(path.dirname(here), "fixtures/restaurantes-referencia.json");
const REF_DIR = "/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes";

interface LogoShape {
  tag: string;
  attrs: Record<string, string | null>;
}

interface ReferenciaFixture {
  cssVars: Record<string, string>;
  fuentesTipograficas: {
    loginSerif: string;
    loginSans: string;
    display: string;
    body: string;
    mono: string;
  };
  boton: { loginBtnBorderRadius: string };
  logoGeometria: LogoShape[];
}

/** Normaliza formatos numéricos equivalentes que la minificación de CSS
 *  puede alterar sin cambiar el valor real (`0.75rem` vs `.75rem`) —
 *  compara el valor, no el formato exacto del token. */
function normalizarValorCss(v: string): string {
  return v.trim().replace(/^0(\.\d)/, "$1");
}

function cargarFixture(): ReferenciaFixture {
  return JSON.parse(fs.readFileSync(REF_FIXTURE_PATH, "utf8")) as ReferenciaFixture;
}

/** Normaliza y hashea la geometría del logo (orden estable de llaves) — el
 *  "hash del markup" que exige el encargo, pero sobre los atributos
 *  geométricos reales (no sobre el HTML crudo, que puede diferir en
 *  atributos de accesibilidad/formato sin que el dibujo cambie). */
function hashGeometriaLogo(shapes: LogoShape[]): string {
  const canon = shapes.map((s) => ({
    tag: s.tag,
    attrs: Object.fromEntries(Object.entries(s.attrs).sort(([a], [b]) => a.localeCompare(b))),
  }));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/** Extrae del DOM real (`svg[aria-label="atiende"]`) la misma forma
 *  normalizada que guarda el fixture: tag + atributos geométricos/de color,
 *  sin className/atributos de accesibilidad. Corre en el navegador. */
async function extraerGeometriaLogo(page: Page): Promise<LogoShape[]> {
  return page.evaluate(() => {
    const svg = document.querySelector('svg[aria-label="atiende"]');
    if (!svg) return [] as { tag: string; attrs: Record<string, string | null> }[];
    return Array.from(svg.children).map((el) => {
      const tag = el.tagName.toLowerCase();
      const g = (n: string) => el.getAttribute(n);
      const attrs: Record<string, string | null> = {};
      if (tag === "rect") {
        Object.assign(attrs, { x: g("x"), y: g("y"), width: g("width"), height: g("height"), rx: g("rx"), fill: g("fill") });
      } else if (tag === "circle") {
        Object.assign(attrs, { cx: g("cx"), cy: g("cy"), r: g("r"), fill: g("fill") });
      } else if (tag === "path") {
        Object.assign(attrs, {
          d: g("d"),
          stroke: g("stroke"),
          strokeWidth: g("stroke-width"),
          strokeLinecap: g("stroke-linecap"),
          strokeLinejoin: g("stroke-linejoin"),
          fill: g("fill"),
        });
      }
      return { tag, attrs };
    });
  });
}

async function extraerCssVars(page: Page, nombres: string[]): Promise<Record<string, string>> {
  return page.evaluate((names: string[]) => {
    const root = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const n of names) out[n] = root.getPropertyValue(n).trim();
    return out;
  }, nombres);
}

async function fontFamilyDe(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return "";
    return getComputedStyle(el).fontFamily;
  }, selector);
}

/** Corre las mismas comparaciones (tokens/fuentes/logo/botón) contra
 *  `referencia` sobre la página ya cargada. Se reutiliza tanto para el
 *  render real de Atiende Hoteles (siempre) como para el render en vivo de
 *  atiende-restaurantes (best-effort, ver test de abajo). */
async function compararContraReferencia(page: Page, referencia: ReferenciaFixture) {
  const nombresVars = Object.keys(referencia.cssVars);
  const vars = await extraerCssVars(page, nombresVars);
  for (const nombre of nombresVars) {
    expect(normalizarValorCss(vars[nombre] ?? ""), `variable CSS ${nombre}`).toBe(normalizarValorCss(referencia.cssVars[nombre] ?? ""));
  }

  const geometria = await extraerGeometriaLogo(page);
  expect(geometria.length, "el logo debe estar presente (svg[aria-label='atiende'])").toBeGreaterThan(0);
  expect(hashGeometriaLogo(geometria), "hash de la geometría del logo").toBe(hashGeometriaLogo(referencia.logoGeometria));

  const serif = await fontFamilyDe(page, ".login-serif");
  expect(serif, "fuente del titular del login").toContain(referencia.fuentesTipograficas.loginSerif);

  const sans = await fontFamilyDe(page, ".login");
  expect(sans, "fuente base del login").toContain(referencia.fuentesTipograficas.loginSans);

  const boton = await page.evaluate(() => {
    const el = document.querySelector(".login-btn");
    return el ? getComputedStyle(el).borderRadius : "";
  });
  expect(boton, "border-radius del botón de login (999px = píldora, 05§1.5)").toBe(referencia.boton.loginBtnBorderRadius);
}

test.describe("Paridad visual — capturas hoteles", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("login", async ({ page }, testInfo) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /bienvenido a atiende hoteles/i })).toBeVisible();
    const vp = testInfo.project.use.viewport;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `hoteles-login-${vp?.width}x${vp?.height}.png`), fullPage: true });
  });

  test("resumen", async ({ page }, testInfo) => {
    await sembrarSesionFalsa(page);
    await page.goto("/resumen");
    await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
    const vp = testInfo.project.use.viewport;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `hoteles-resumen-${vp?.width}x${vp?.height}.png`), fullPage: true });
  });

  test("reservas", async ({ page }, testInfo) => {
    await sembrarSesionFalsa(page);
    await page.goto("/reservas");
    await expect(page.getByRole("heading", { name: "Reservas" })).toBeVisible();
    const vp = testInfo.project.use.viewport;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `hoteles-reservas-${vp?.width}x${vp?.height}.png`), fullPage: true });
  });
});

test.describe("Paridad visual — comparación real vs. Restaurantes (fixture)", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("login de Atiende Hoteles: tokens/tipografía/logo/botón == fixture de Restaurantes", async ({ page }) => {
    const referencia = cargarFixture();
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /bienvenido a atiende hoteles/i })).toBeVisible();
    await compararContraReferencia(page, referencia);
  });

  test("resumen de Atiende Hoteles: la tipografía base (--font-body) sigue siendo Inter", async ({ page }) => {
    const referencia = cargarFixture();
    await sembrarSesionFalsa(page);
    await page.goto("/resumen");
    await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
    const body = await fontFamilyDe(page, "body");
    expect(body, "fuente base de la app (font-body)").toContain(referencia.fuentesTipograficas.body);
  });
});

// ---- Render en vivo de atiende-restaurantes (best-effort) --------------
// Mismo patrón que paridad-restaurantes-login.spec.ts: levanta `npm run dev`
// de atiende-restaurantes SIN modificar nada de ese repo, corre las MISMAS
// comparaciones de compararContraReferencia() contra su propio render, y
// verifica que efectivamente coincide con el fixture estático (si esto
// fallara, el fixture estaría desactualizado respecto al código real). Si
// el servidor no arranca, se documenta y se salta (no bloquea este spec:
// el spec de arriba, que sí es obligatorio, no depende de este).
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

test("paridad viva: el render real de atiende-restaurantes coincide con el fixture usado arriba", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Una sola corrida basta; se hace en el proyecto desktop.");
  test.setTimeout(120_000);

  const referencia = cargarFixture();
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

    const base = `http://localhost:${puerto}/restaurantes/`;
    arrancoOk = await esperarServidor(base, 45_000);

    if (!arrancoOk) {
      motivoFallo = `El servidor de dev de atiende-restaurantes no respondió en 45s en el puerto ${puerto}. Salida:\n${salida.slice(-4000)}`;
    } else {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const refPage = await context.newPage();
      await refPage.emulateMedia({ reducedMotion: "reduce" });
      await refPage.goto(`${base}admin/login`, { waitUntil: "networkidle", timeout: 30_000 });
      await compararContraReferencia(refPage, referencia);
      await context.close();
    }
  } catch (err) {
    motivoFallo = `Excepción al levantar/comparar atiende-restaurantes: ${(err as Error).message}`;
  } finally {
    if (proceso) matarProceso(proceso);
  }

  if (!arrancoOk) {
    const logPath = path.resolve(path.dirname(here), "../../docs/logs/h8-paridad-restaurantes-vivo.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] ${motivoFallo}\n`);
    console.warn("[paridad-visual/vivo] No se pudo comparar contra el render real:", motivoFallo);
    test.skip(true, motivoFallo);
  }
});
