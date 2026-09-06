#!/usr/bin/env node
// REQ-GOB-009 (GOB-058) · revisión estática: "Nunca se ejecutan comandos
// destructivos/productivos por el agente (`supabase db push`, `git push --force`);
// esas acciones son exclusivas de CI o del fundador."
//
// Escanea el código y la configuración que el AGENTE podría ejecutar (scripts de
// npm de cada `package.json` del monorepo, `scripts/*.sh`/`scripts/*.ts`, y el código
// fuente de `apps/*/src`) buscando invocaciones literales de esos comandos. Se excluye
// deliberadamente:
//   - `.github/workflows/**`: es exactamente el dominio EXCLUSIVO de CI que este
//     requisito reserva para esos comandos -- encontrarlos ahí no es una violación.
//   - `scripts/checks/**`: este propio archivo (y sus pruebas) necesitan mencionar los
//     comandos prohibidos en texto para poder buscarlos.
//   - `docs/**`: prosa que documenta la regla, no código ejecutable.
//   - Líneas de comentario puro.
//
// Uso: `node scripts/checks/no-comandos-destructivos-agente.ts` -- sale con código 1
// si encuentra una coincidencia, imprimiendo archivo:línea.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const DEFAULT_SCAN_DIRS = [
  join(ROOT, "apps"),
  join(ROOT, "packages"),
  join(ROOT, "scripts"),
];
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "checks", ".git", "migrations"]);
const EXCLUDE_PATH_SEGMENTS = ["/.github/"];

// Comandos productivos/destructivos reservados a CI/fundador (GOB-058), tal como los
// nombra el propio requisito, más las variantes de "force push" más comunes.
const DESTRUCTIVE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "supabase db push", re: /\bsupabase\s+db\s+push\b/i },
  { name: "supabase db reset --linked", re: /\bsupabase\s+db\s+reset\s+--linked\b/i },
  { name: "git push --force", re: /\bgit\s+push\b[^\n]*(--force\b(?!-with-lease)|(?<!-)\s-f\b)/i },
  { name: "git push --force-with-lease", re: /\bgit\s+push\b[^\n]*--force-with-lease\b/i },
];

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("--") || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#");
}

function isExcludedPath(path: string): boolean {
  return EXCLUDE_PATH_SEGMENTS.some((seg) => path.includes(seg));
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
    if (isExcludedPath(full)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry)) continue;
      walk(full, files);
    } else if (/\.(ts|tsx|sh|json|yml|yaml)$/.test(entry)) {
      // package.json de cada workspace SÍ se escanea (scripts de npm); package-lock.json
      // no aporta nada relevante y es enorme -- se excluye por nombre exacto.
      if (entry === "package-lock.json") continue;
      files.push(full);
    }
  }
  return files;
}

export interface Violation {
  file: string;
  line: number;
  text: string;
  pattern: string;
}

/** `scanDirs`/`relativeTo` son inyectables SOLO para pruebas (directorios temporales
 *  sintéticos, mismo patrón que `scripts/check-migraciones.ts`/
 *  `tests/unit/check-migraciones.spec.ts`) -- el uso real (CLI) siempre escanea el
 *  repo real vía los defaults. */
export function checkNoComandosDestructivos(scanDirs: string[] = DEFAULT_SCAN_DIRS, relativeTo: string = ROOT): Violation[] {
  const violations: Violation[] = [];
  for (const dir of scanDirs) {
    for (const file of walk(dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (isCommentLine(line)) return;
        for (const { name, re } of DESTRUCTIVE_PATTERNS) {
          if (re.test(line)) {
            violations.push({ file: file.replace(relativeTo + "/", ""), line: idx + 1, text: line.trim(), pattern: name });
          }
        }
      });
    }
  }
  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const violations = checkNoComandosDestructivos();
  if (violations.length > 0) {
    console.error("REQ-GOB-009: se encontraron comandos destructivos/productivos fuera de CI/fundador:");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} [${v.pattern}]: ${v.text}`);
    }
    process.exit(1);
  }

  console.log(
    "REQ-GOB-009 OK: 0 invocaciones de comandos destructivos/productivos (supabase db push, git push --force) fuera de .github/workflows.",
  );
  process.exit(0);
}
