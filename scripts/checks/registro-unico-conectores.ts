#!/usr/bin/env node
// REQ-AGT-018 (GOB-059/BP-141) · revisión estática: "Debe existir un registro de
// conectores único (patrón registry): prohibido `if provider === X`/`if pms === X`
// fuera del registro central; CI debe fallar ante cualquier coincidencia fuera del
// registro." Ver también REQ-REV-015/REQ-INT-015 (mismo patrón, redactados como
// consecuencia de este requisito).
//
// El registro central HOY es `packages/mcp-servers/pms/src/registry.ts`
// (`PMS_CONNECTOR_REGISTRY`, ver su propio docstring) -- el ÚNICO lugar donde este
// repo tiene permitido nombrar un proveedor de conector concreto ("cloudbeds",
// "mews", ...) para decidir comportamiento. Este chequeo escanea el resto del código
// fuente ejecutable (apps/*/src, packages/**) buscando un `if`/`else if`/`switch` cuya
// condición compare (con `===`) o conmute sobre un identificador `provider`/`pms`
// (en cualquier nivel de acceso a propiedad, p.ej. `config.provider`) -- exactamente
// la forma que el requisito prohíbe fuera del registro. `scripts/checks/
// orden-conectores-pms.ts` (REQ-REV-008) complementa esto verificando el CONTENIDO
// del registro (orden de prioridad); este chequeo verifica su UNICIDAD como único
// punto de bifurcación por proveedor.
//
// Se excluye deliberadamente:
//   - `node_modules`, `dist`: generado/vendorizado, no código propio.
//   - `checks/` (este mismo directorio): sus propios archivos y comentarios
//     necesitan mencionar el patrón prohibido en texto para poder buscarlo/probarlo.
//   - Líneas de comentario puro (`//`, `/*`, `*`, `--`): documentan la regla, no la
//     violan.
//   - `CENTRAL_REGISTRY_FILES`: el/los registro(s) central(es) declarados abajo --
//     es el único lugar donde nombrar un proveedor concreto está permitido. Hoy solo
//     existe el registro de PMS; si se añade un registro central análogo para otro
//     tipo de conector (pagos, CFDI, WhatsApp) su ruta se agrega a esa lista.
//
// Uso: `node scripts/checks/registro-unico-conectores.ts` -- sale con código 1 si
// encuentra una coincidencia fuera del registro, imprimiendo archivo:línea.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const DEFAULT_SCAN_DIRS = [join(ROOT, "apps", "api", "src"), join(ROOT, "apps", "web", "src"), join(ROOT, "packages")];
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "checks"]);

// El/los registro(s) central(es) de conectores -- ÚNICO lugar donde nombrar un
// proveedor concreto está permitido. Rutas relativas a `relativeTo` (por defecto
// ROOT).
const DEFAULT_CENTRAL_REGISTRY_FILES = new Set(["packages/mcp-servers/pms/src/registry.ts"]);

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("--") || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
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
  text: string;
  kind: "if" | "switch";
}

// Identificador `provider`/`pms` con límites de palabra reales -- NO coincide con
// "providerId"/"isPms" (serían el mismo token sin separador), SÍ coincide con
// "config.provider"/"x.pms" (el "." es un límite no-palabra válido).
const PROVIDER_WORD_RE = /\b(provider|pms)\b/;
const EQUALITY_RE = /===/;
// Extrae el contenido entre paréntesis de un `if (...)`/`switch (...)` de una sola
// línea (caso simple, sin paréntesis anidados en la condición -- consistente con el
// resto de checks de este repo, que son heurísticas de línea, no un parser real).
const IF_RE = /\b(?:else\s+)?if\s*\(([^)]*)\)/g;
const SWITCH_RE = /\bswitch\s*\(([^)]*)\)/g;

function findLineViolations(line: string): Violation["kind"][] {
  if (isCommentLine(line)) return [];
  const kinds: Violation["kind"][] = [];

  for (const match of line.matchAll(IF_RE)) {
    const condition = match[1] ?? "";
    if (PROVIDER_WORD_RE.test(condition) && EQUALITY_RE.test(condition)) {
      kinds.push("if");
    }
  }
  for (const match of line.matchAll(SWITCH_RE)) {
    const condition = match[1] ?? "";
    if (PROVIDER_WORD_RE.test(condition)) {
      kinds.push("switch");
    }
  }
  return kinds;
}

/** `scanDirs`/`relativeTo`/`centralRegistryFiles` son inyectables SOLO para pruebas
 *  (directorios temporales sintéticos, mismo patrón que
 *  `scripts/checks/no-comandos-destructivos-agente.ts`) -- el uso real (CLI) siempre
 *  escanea el repo real vía los defaults. */
export function checkRegistroUnicoConectores(
  scanDirs: string[] = DEFAULT_SCAN_DIRS,
  relativeTo: string = ROOT,
  centralRegistryFiles: Set<string> = DEFAULT_CENTRAL_REGISTRY_FILES,
): Violation[] {
  const violations: Violation[] = [];
  for (const dir of scanDirs) {
    for (const file of walk(dir)) {
      const relFile = file.startsWith(relativeTo + "/") ? file.slice(relativeTo.length + 1) : file;
      if (centralRegistryFiles.has(relFile)) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        for (const kind of findLineViolations(line)) {
          violations.push({ file: relFile, line: idx + 1, text: line.trim(), kind });
        }
      });
    }
  }
  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const violations = checkRegistroUnicoConectores();
  if (violations.length > 0) {
    console.error(
      "REQ-AGT-018: se encontró bifurcación por proveedor (`if`/`switch` sobre `provider`/`pms`) fuera del " +
        "registro central de conectores (packages/mcp-servers/pms/src/registry.ts):",
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.kind}]: ${v.text}`);
    }
    process.exit(1);
  }

  console.log(
    "REQ-AGT-018 OK: 0 ocurrencias de `if provider === X`/`if pms === X` (ni `switch(provider|pms)`) fuera del " +
      "registro central de conectores, en apps/api/src, apps/web/src y packages/**.",
  );
  process.exit(0);
}
