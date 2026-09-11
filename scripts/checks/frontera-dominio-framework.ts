#!/usr/bin/env node
// Patrón Likida/atiende.ai #2 · "test de frontera de capas dominio vs. framework en CI":
// `packages/domain-hotel` (dominio puro -- su `package.json` solo depende de `zod`) debe
// permanecer sin ninguna dependencia de framework HTTP/servidor (`hono`, `express`,
// `node:http`) ni de ningún paquete de `apps/*` (`@atiende-hoteles/api`, `@atiende/web`).
// Hoy esa separación es solo convención de estructura de workspace -- ningún
// `no-restricted-imports` de ESLint ni check de `scripts/checks/` la verifica
// activamente (a diferencia de REQ-AGT-018, que SÍ tiene su propio guard de fronteras,
// `registro-unico-conectores.ts`, mismo patrón que este archivo reutiliza). Sin este
// check, nada impediría que alguien importe `Context`/`Hono` dentro de `domain-hotel`
// por conveniencia sin que CI lo note.
//
// Revisión ESTÁTICA (regex sobre texto, sin parser real) -- mismo criterio de
// "heurística de línea, no un parser" que el resto de `scripts/checks/`: detecta
// `import ... from "X"`, `import("X")` (dinámico) y `require("X")` cuyo especificador
// coincida con un paquete de framework prohibido o con cualquier paquete de `apps/*`
// (por nombre publicado o por ruta relativa que alcance `apps/`).
//
// Se excluye deliberadamente:
//   - `node_modules`, `dist`: generado/vendorizado, no código propio.
//   - Líneas de comentario puro (`//`, `/*`, `*`): documentan la regla, no la violan.
//
// Uso: `node scripts/checks/frontera-dominio-framework.ts` -- sale con código 1 si
// encuentra una importación prohibida, imprimiendo archivo:línea.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const DEFAULT_SCAN_DIR = join(ROOT, "packages", "domain-hotel", "src");
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist"]);

// Paquetes/módulos de framework/servidor -- prohibidos dentro de dominio puro. Un
// especificador coincide si es EXACTAMENTE uno de estos, o empieza con
// "<especificador>/" (submódulo del mismo paquete, p.ej. "hono/cors").
const FORBIDDEN_FRAMEWORK_SPECIFIERS = ["hono", "@hono/zod-validator", "express", "node:http", "node:https"];
// Prefijo de scope: cualquier paquete "@hono/*" (no solo el validador de arriba).
const FORBIDDEN_SCOPE_PREFIXES = ["@hono/"];
// Paquetes publicados de apps/* (ver sus package.json `name`) -- dominio nunca depende
// de la capa de aplicación, ni siquiera de sus tipos.
const FORBIDDEN_APP_PACKAGES = ["@atiende-hoteles/api", "@atiende/web"];

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function walk(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry)) continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  text: string;
}

/** `true` si `specifier` (el texto entre comillas de un import/require) es un paquete
 *  de framework prohibido, un paquete de `apps/*`, o una ruta relativa que alcanza
 *  `apps/` (defensa en profundidad contra un import relativo que rodee el nombre
 *  publicado del paquete). */
export function isForbiddenSpecifier(specifier: string): boolean {
  if (FORBIDDEN_FRAMEWORK_SPECIFIERS.some((forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`))) {
    return true;
  }
  if (FORBIDDEN_SCOPE_PREFIXES.some((prefix) => specifier.startsWith(prefix))) return true;
  if (FORBIDDEN_APP_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))) return true;
  // Ruta relativa/absoluta que alcanza un directorio literal "apps/" (p.ej.
  // "../../../apps/api/src/types.ts") -- se normaliza a "/" para no perderse por "\" en
  // rutas escritas a mano en Windows-style (defensivo, este repo no las usa, pero el
  // check es barato).
  if (/(^|\/)apps\//.test(specifier.replace(/\\/g, "/"))) return true;
  return false;
}

// Extrae el especificador (contenido entre comillas) de un `import ... from "X"`
// estático, un `import("X")` dinámico, o un `require("X")` -- comillas simples o dobles.
const IMPORT_FROM_RE = /\bfrom\s+["']([^"']+)["']/g;
const IMPORT_CALL_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

function findLineViolations(line: string): string[] {
  if (isCommentLine(line)) return [];
  const specifiers: string[] = [];
  for (const re of [IMPORT_FROM_RE, IMPORT_CALL_RE, REQUIRE_RE]) {
    for (const match of line.matchAll(re)) {
      const specifier = match[1];
      if (specifier && isForbiddenSpecifier(specifier)) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** `scanDir` es inyectable SOLO para pruebas (directorio temporal sintético, mismo
 *  patrón que `checkRegistroUnicoConectores`) -- el uso real (CLI) siempre escanea
 *  `packages/domain-hotel/src` vía el default. */
export function checkFronteraDominioFramework(scanDir: string = DEFAULT_SCAN_DIR, relativeTo: string = ROOT): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(scanDir)) {
    const relFile = file.startsWith(relativeTo + "/") ? file.slice(relativeTo.length + 1) : file;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      for (const specifier of findLineViolations(line)) {
        violations.push({ file: relFile, line: idx + 1, specifier, text: line.trim() });
      }
    });
  }
  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const violations = checkFronteraDominioFramework();
  if (violations.length > 0) {
    console.error(
      "Patrón Likida/atiende.ai #2: se encontró una importación de framework/apps dentro de " +
        "packages/domain-hotel/src (dominio puro, solo debe depender de zod):",
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.specifier}]: ${v.text}`);
    }
    process.exit(1);
  }

  console.log(
    "Patrón Likida/atiende.ai #2 OK: 0 importaciones de hono/express/node:http/apps-* en packages/domain-hotel/src.",
  );
  process.exit(0);
}
