#!/usr/bin/env node
// REQ-QA-002 (GOB-012) · revisión estática: "Nunca se debe comentar, borrar ni marcar
// `skip` una prueba existente; ante un caso que no pasa, se crea una prueba adicional
// para cubrirlo en verde." Comando exacto exigido por `docs/ACEPTACION.md`:
// `node scripts/checks/no-tests-skip.ts` (verificación equivalente al `grep -rn
// "\.skip(\|xit(\|xdescribe(" tests/` que el propio criterio cita como método).
//
// Precaución real encontrada ANTES de escribir este check (no ignorada): un grep
// ciego que prohíba cualquier `.skip(` rompe contra el propio repo real. Ya existen
// usos LEGÍTIMOS de `test.skip(...)` en `tests/e2e/` (Playwright):
//   - `test.skip(testInfo.project.name !== "desktop", "razón")` -- condicional por
//     proyecto, para no repetir la misma captura de pantalla en cada viewport.
//   - `test.skip(true, motivoFallo)` -- skip incondicional pero con una razón NOMBRADA
//     explícita (variable con el motivo real, escrito además a `docs/logs/`).
// Ambos casos declaran un SEGUNDO argumento no vacío que documenta el motivo -- es la
// forma en que Playwright expone "por qué" sin comentar/borrar la prueba. El requisito
// prohíbe ESCONDER un caso que falla; un skip condicional documentado no esconde nada,
// queda visible en el reporte de Playwright con su razón.
//
// Regla resultante (dos partes, cero excepciones fuera de ellas):
//
//   1. `it.skip(`, `describe.skip(`, `xit(`, `xdescribe(` -- PROHIBIDOS en cualquier
//      archivo bajo `tests/`, sin excepción. Este repo no los usa hoy (Vitest, el
//      framework de `tests/unit`/`tests/integration`/`tests/adversarial`, no tiene un
//      mecanismo de "razón" para estas formas) y no hay caso legítimo que los necesite.
//
//   2. `test.skip(` -- PROHIBIDO fuera de `tests/e2e/**` (ahí no hay ningún uso legítimo
//      conocido: los archivos de `tests/unit`/`tests/integration`/`tests/adversarial`
//      corren con Vitest, cuyo `test.skip(nombre, fn)` deshabilita la prueba sin dejar
//      ningún motivo visible -- exactamente lo que el requisito prohíbe). Dentro de
//      `tests/e2e/**` (Playwright) se PERMITE solo si la llamada declara al menos 2
//      argumentos y el último, ya recortado, no queda vacío (ni `""`/`''`/``` `` ```) --
//      el motivo documentado. `test.skip()` sin argumentos o `test.skip(condición)` con
//      un solo argumento (sin motivo) siguen prohibidos incluso en `tests/e2e/**`.
//
// Fuera de alcance deliberado (documentado, no un olvido): detectar una prueba
// COMENTADA o BORRADA requiere diferenciar prosa/documentación de código real
// (comentar) o comparar contra el historial de git commit a commit (borrar) -- el
// propio `docs/ACEPTACION.md` especifica como único método de verificación el grep
// estático de `.skip(|xit(|xdescribe(` sobre el árbol actual, no un diff de historial;
// automatizar "prueba borrada sin reemplazo" de forma confiable (sin falsos positivos
// contra refactors legítimos: renombrar, fusionar dos pruebas redundantes, mover un
// archivo) es un proyecto propio fuera de este criterio. Esa mitad sigue siendo, como
// ya documentaba `docs/cierre-p0/inventario.md` para este mismo REQ, una regla de
// proceso seguida por revisión humana/de PR, no por esta herramienta.
//
// Solo se opera LÍNEA POR LÍNEA (igual que el `grep -n` citado): una llamada a
// `test.skip(` cuyos paréntesis no cierran en la misma línea no puede verificarse su
// motivo de forma segura y se trata como violación (falla cerrado, nunca abierto).
//
// Nota de alcance verificada contra el repo real: `describe.skipIf(!condición)(...)`
// (Vitest, ya usado hoy en `tests/unit/mcp-servers/pms/contract.spec.ts` para saltar un
// contrato que requiere credenciales reales) NO coincide con `.skip(` (el texto
// contiguo es `.skipIf(`, no `.skip(`) -- tampoco coincide con el `grep -rn "\.skip(\|
// xit(\|xdescribe("` que `docs/ACEPTACION.md` cita como método de verificación, así
// que queda fuera de esta regla por diseño, no por descuido. Es un caso ya documentado
// en su propio archivo ("se salta explícitamente, nunca finge verde") y de una familia
// distinta a la que este requisito ataca (ocultar un caso que FALLA, no declarar que
// una integración real no tiene credenciales). Mismo razonamiento para `.only(`: no
// aparece en el texto del criterio ni en su comando de verificación, y hoy 0 archivos
// de `tests/` lo usan -- no se añade una regla que el criterio no pidió.
//
// Uso: `node scripts/checks/no-tests-skip.ts` -- sale con código 1 si encuentra
// cualquier violación, imprimiendo archivo:línea, categoría y el texto de la línea.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DEFAULT_SCAN_DIR = join(ROOT, "tests");
const EXCLUDE_DIR_NAMES = new Set(["node_modules", ".git"]);

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
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (EXCLUDE_DIR_NAMES.has(entry)) continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

export interface SkipViolation {
  file: string;
  line: number;
  text: string;
  category:
    | "xit-prohibido"
    | "xdescribe-prohibido"
    | "it-o-describe-skip-prohibido"
    | "test-skip-fuera-de-e2e"
    | "test-skip-sin-motivo-documentado"
    | "test-skip-multilinea-no-verificable";
}

export interface SkipAllowed {
  file: string;
  line: number;
  text: string;
  motivo: string;
}

/** Divide el contenido entre paréntesis de una llamada en argumentos de nivel
 *  superior, respetando comillas simples/dobles/backtick y paréntesis/corchetes/llaves
 *  anidados -- para no partir por una coma que está DENTRO del motivo (p.ej. `"razón,
 *  con coma"`). Devuelve `null` si los paréntesis no cierran dentro de `text` (llamada
 *  multilínea, no verificable de forma segura). */
function extractCallArgs(text: string, openParenIndex: number): string[] | null {
  let depth = 1;
  let i = openParenIndex + 1;
  let quote: '"' | "'" | "`" | null = null;
  let current = "";
  const args: string[] = [];
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\") {
        // Carácter escapado dentro de la cadena: consume el siguiente literal sin
        // reinterpretarlo (evita cerrar la comilla por error en `\"`).
        i++;
        if (i < text.length) current += text[i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(current);
        return args;
      }
      current += ch;
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return null; // no cerró en esta línea
}

function isEmptyLiteral(arg: string): boolean {
  const t = arg.trim();
  return t === "" || t === '""' || t === "''" || t === "``";
}

/** `scanDir`/`relativeTo` son inyectables SOLO para pruebas (directorio temporal
 *  sintético, mismo patrón que `scripts/checks/pms-mirror-solo-lectura.ts`) -- el uso
 *  real (CLI) siempre escanea `tests/` del repo real vía los defaults. */
export function checkNoTestsSkip(
  scanDir: string = DEFAULT_SCAN_DIR,
  relativeTo: string = ROOT,
): { violations: SkipViolation[]; allowed: SkipAllowed[] } {
  const violations: SkipViolation[] = [];
  const allowed: SkipAllowed[] = [];

  for (const file of walk(scanDir)) {
    const relFile = relative(relativeTo, file).split(sep).join("/");
    const isE2e = relFile.startsWith("tests/e2e/");

    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (isCommentLine(line)) return;
      const lineNo = idx + 1;

      if (/\bxit\s*\(/.test(line)) {
        violations.push({ file: relFile, line: lineNo, text: line.trim(), category: "xit-prohibido" });
        return;
      }
      if (/\bxdescribe\s*\(/.test(line)) {
        violations.push({ file: relFile, line: lineNo, text: line.trim(), category: "xdescribe-prohibido" });
        return;
      }
      if (/\b(?:it|describe)\.skip\s*\(/.test(line)) {
        violations.push({ file: relFile, line: lineNo, text: line.trim(), category: "it-o-describe-skip-prohibido" });
        return;
      }

      const testSkipMatch = /\btest\.skip\s*\(/.exec(line);
      if (testSkipMatch) {
        if (!isE2e) {
          violations.push({ file: relFile, line: lineNo, text: line.trim(), category: "test-skip-fuera-de-e2e" });
          return;
        }
        const openParenIndex = testSkipMatch.index + testSkipMatch[0].length - 1;
        const args = extractCallArgs(line, openParenIndex);
        if (args === null) {
          violations.push({ file: relFile, line: lineNo, text: line.trim(), category: "test-skip-multilinea-no-verificable" });
          return;
        }
        const motivo = args[1];
        if (args.length < 2 || motivo === undefined || isEmptyLiteral(motivo)) {
          violations.push({ file: relFile, line: lineNo, text: line.trim(), category: "test-skip-sin-motivo-documentado" });
          return;
        }
        allowed.push({ file: relFile, line: lineNo, text: line.trim(), motivo: motivo.trim() });
      }
    });
  }

  return { violations, allowed };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { violations, allowed } = checkNoTestsSkip();
  if (violations.length > 0) {
    console.error("REQ-QA-002: se encontraron pruebas marcadas `skip` sin motivo documentado (o `xit`/`xdescribe`/`it.skip`/`describe.skip`, prohibidos sin excepción):");
    for (const v of violations) {
      console.error(`  [${v.category}] ${v.file}:${v.line}: ${v.text}`);
    }
    process.exit(1);
  }
  console.log(
    `REQ-QA-002 OK: 0 \`xit(\`/\`xdescribe(\`/\`it.skip(\`/\`describe.skip(\` en tests/, y 0 \`test.skip(\` sin motivo documentado fuera de tests/e2e/.\n` +
      (allowed.length > 0
        ? `  ${allowed.length} skip(s) condicional(es) documentados permitidos en tests/e2e/ (Playwright, con motivo explícito):\n` +
          allowed.map((a) => `    ${a.file}:${a.line}: motivo = ${a.motivo}`).join("\n")
        : "  0 skips condicionales encontrados en tests/e2e/."),
  );
  process.exit(0);
}
