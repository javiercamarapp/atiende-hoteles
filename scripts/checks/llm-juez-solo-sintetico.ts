#!/usr/bin/env node
// REQ-AGT-015 (LLM-011/LLM-012) · revisión estática: "El LLM-juez de los evals debe
// procesar únicamente datos sintéticos generados por el simulador, nunca
// transcripciones de huéspedes reales." La fuente (LLM-011) además fija que el juez
// (Fable 5.1, con Opus 5 como segundo juez) NUNCA debe tocar datos de huésped real
// (LLM-012: la retención de 30 días de Fable 5.1 "solo debe afectar al juez de evals
// con datos sintéticos, nunca a datos de huéspedes reales").
//
// Estado real del repo en el momento de escribir este check: el simulador de
// huéspedes (REQ-AGT-008) y el LLM-juez de evals NO existen todavía como código --
// son P0 "pendiente" excluidos del pase de cierre P0 (ver docs/TRAZABILIDAD.md). Este
// check por lo tanto NO puede evaluar un pipeline de evals que no existe; lo que SÍ
// puede -- y debe -- hacer es actuar como guardia estática hacia adelante (mismo
// patrón que scripts/checks/no-ota-directa.ts / no-comandos-destructivos-agente.ts):
// define la frontera de datos que el requisito exige y falla si algún código futuro
// la cruza, verificado con pruebas reales sobre fixtures sintéticos (ver
// tests/unit/llm-juez-solo-sintetico.spec.ts).
//
// La única fuente real de "transcripción de huésped real" que existe hoy en el repo
// es el par de tablas `public.conversation`/`public.message`
// (packages/db/migrations/0044_conversation_message.sql) servido por
// `apps/api/src/routes/mensajeria.ts` -- el propio comentario de esa migración es
// explícito: "`message.body` NO se redacta al guardarse (el staff necesita leer el
// mensaje real del huesped)". Mientras no haya credenciales de Meta/voz, esas filas
// las produce `FakeWhatsappAdapter` (marcadas `message.simulated=true`), pero la
// RUTA/TABLA es la de producción real -- el día que haya credenciales, ahí es donde
// vivirá la transcripción real. Este check por lo tanto vigila DOS direcciones,
// buscando en cada archivo `.ts`/`.tsx` de `apps/**/src`, `packages/**/src` y
// `scripts/**` (excluyendo `scripts/checks`):
//
//   (A) "el juez toca un dato real": un archivo que se identifica como el LLM-juez
//       (por nombre de archivo o por exportar una función/const cuyo nombre contiene
//       "juez"/"judge") referencia en su propio código una fuente de dato real de
//       huésped: `public.message`/`public.conversation` en SQL crudo, un import de
//       `routes/mensajeria`, o un import de un adaptador de canal que NO sea el
//       explícitamente marcado `fake-`/`simulated-` (`packages/mcp-servers/*/src/
//       adapters/*-adapter.ts`).
//   (B) "el dato real importa al juez": un archivo que toca esa misma fuente de dato
//       real (mismos patrones que (A)) importa un símbolo cuyo nombre contiene
//       "juez"/"judge" -- la ruta simétrica: el LLM-juez podría no tener nada
//       sospechoso en su propio archivo si es la ruta de mensajería la que lo importa
//       a él y le pasa datos reales.
//
// Uso: `node scripts/checks/llm-juez-solo-sintetico.ts` -- sale con código 1 si
// encuentra una coincidencia, imprimiendo archivo:línea y la dirección de la
// violación.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

const DEFAULT_SCAN_DIRS = [join(ROOT, "apps"), join(ROOT, "packages"), join(ROOT, "scripts")];
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "checks", ".git", "migrations"]);

// Nombre de archivo que por sí solo delata "esto es el LLM-juez" (p.ej.
// `llmJuez.ts`, `judge.ts`, `evalJudge.ts`).
const JUEZ_FILENAME_PATTERN = /juez|judge/i;

// Exportar una función/const cuyo nombre contiene "juez"/"judge" -- forma en la que
// se expondría la entrada pública del LLM-juez (p.ej.
// `export function evaluarConLLMJuez(...)`, `export const llmJuez = ...`).
const JUEZ_EXPORT_PATTERN = /export\s+(async\s+)?function\s+\w*(juez|judge)\w*\s*\(|export\s+const\s+\w*(juez|judge)\w*\s*[=:]/i;

// Importar un símbolo cuyo nombre contiene "juez"/"judge" -- forma en la que un
// archivo (p.ej. la ruta de mensajería real) traería consigo al LLM-juez.
const JUEZ_IMPORT_PATTERN = /import\s+(type\s+)?\{[^}]*(juez|judge)[^}]*\}\s*from|import\s+\w*(juez|judge)\w*\s+from/i;

// Las tres formas reales, hoy existentes en el repo, en las que un archivo puede
// tocar la transcripción de huésped real: la tabla SQL, la ruta de mensajería real, o
// un adaptador de canal que NO esté explícitamente marcado fake/simulado.
const REAL_TABLE_PATTERN = /\bpublic\.(message|conversation)\b/;
const REAL_ROUTE_IMPORT_PATTERN = /from\s+["'][^"']*routes\/mensajeria(\.ts)?["']/;
const REAL_ADAPTER_IMPORT_PATTERN = /from\s+["'][^"']*\/adapters\/(?!fake-|simulated-)[a-z0-9_-]*adapter(\.ts)?["']/i;
const REAL_DATA_SOURCE_PATTERN = new RegExp(
  [REAL_TABLE_PATTERN.source, REAL_ROUTE_IMPORT_PATTERN.source, REAL_ADAPTER_IMPORT_PATTERN.source].join("|"),
  "i",
);

/** Líneas de puro comentario no cuentan -- este chequeo busca CÓDIGO ejecutable real
 *  (imports, llamadas, SQL embebido), no prosa que documente la frontera (este mismo
 *  archivo la documenta extensamente arriba). */
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
  direccion: "juez-toca-dato-real" | "dato-real-importa-juez";
}

/** `scanDirs`/`relativeTo` son inyectables SOLO para pruebas (directorios temporales
 *  sintéticos, mismo patrón que `no-comandos-destructivos-agente.ts`) -- el uso real
 *  (CLI) siempre escanea el repo real vía los defaults. */
export function checkLlmJuezSoloSintetico(scanDirs: string[] = DEFAULT_SCAN_DIRS, relativeTo: string = ROOT): Violation[] {
  const violations: Violation[] = [];
  for (const dir of scanDirs) {
    for (const file of walk(dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      const relPath = file.replace(relativeTo + "/", "");

      const esJuez = JUEZ_FILENAME_PATTERN.test(basename(file)) || lines.some((l) => JUEZ_EXPORT_PATTERN.test(l));
      const tocaDatoReal = lines.some((l) => !isCommentLine(l) && REAL_DATA_SOURCE_PATTERN.test(l));

      if (esJuez) {
        lines.forEach((line, idx) => {
          if (!isCommentLine(line) && REAL_DATA_SOURCE_PATTERN.test(line)) {
            violations.push({ file: relPath, line: idx + 1, text: line.trim(), direccion: "juez-toca-dato-real" });
          }
        });
      }

      if (tocaDatoReal) {
        lines.forEach((line, idx) => {
          if (!isCommentLine(line) && JUEZ_IMPORT_PATTERN.test(line)) {
            violations.push({ file: relPath, line: idx + 1, text: line.trim(), direccion: "dato-real-importa-juez" });
          }
        });
      }
    }
  }
  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const violations = checkLlmJuezSoloSintetico();
  if (violations.length > 0) {
    console.error("REQ-AGT-015: se encontraron rutas donde una transcripción de huésped real podría llegar al LLM-juez:");
    for (const v of violations) {
      console.error(`  [${v.direccion}] ${v.file}:${v.line}: ${v.text}`);
    }
    process.exit(1);
  }

  console.log(
    "REQ-AGT-015 OK: 0 rutas donde una transcripción de huésped real (public.message/public.conversation, " +
      "routes/mensajeria, adaptador de canal no-fake/simulado) llegue a un archivo/función identificado como " +
      "LLM-juez, en ninguna dirección, sobre apps/**/src, packages/**/src y scripts/** (excluyendo scripts/checks).",
  );
  process.exit(0);
}
