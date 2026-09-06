#!/usr/bin/env node
// REQ-RES-022/REQ-REV-008 (H15-006) · revisión estática: mientras la restricción de
// fase esté vigente (docs/REQUISITOS.md §3.2/§3.7 -- no construir conectividad OTA
// propia durante al menos los primeros 24 meses), ningún archivo de código de este
// repo (fuera de comentarios/documentación) contiene una llamada directa a un host de
// API de Booking.com/Expedia/Airbnb. Toda disponibilidad/tarifa hacia OTA debe pasar
// exclusivamente por el channel manager/PMS certificado
// (`packages/mcp-servers/pms/src/port.ts` -- `PmsPort`).
//
// Uso: `node scripts/checks/no-ota-directa.ts` -- sale con código 1 si encuentra una
// coincidencia, imprimiendo archivo:línea.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
// Se escanea SOLO código fuente ejecutable -- nunca `docs/` (que discute la
// restricción extensamente en prosa) ni este mismo directorio de checks.
const SCAN_DIRS = [
  join(ROOT, "apps", "api", "src"),
  join(ROOT, "apps", "web", "src"),
  join(ROOT, "packages"),
];
const EXCLUDE_DIRS = new Set(["node_modules", "dist", "checks"]);

// Hosts/paths reales de las APIs de conectividad directa de cada OTA -- el nombre
// suelto "booking"/"expedia"/"airbnb" es demasiado ruidoso (aparece en comentarios y en
// `hotel_cancellation_policy`/textos de UI que hablan de "reserva" en general); se
// exige el host/endpoint real de integración directa, que es lo que este requisito
// prohíbe.
const OTA_API_PATTERNS = [
  /distribution-xml\.booking\.com/i,
  /supply-xml\.booking\.com/i,
  /api\.booking\.com/i,
  /services\.expediapartnercentral\.com/i,
  /api\.expediapartnercentral\.com/i,
  /developers\.airbnb\.com/i,
  /api\.airbnb\.com/i,
];
const OTA_PATTERN = new RegExp(OTA_API_PATTERNS.map((r) => r.source).join("|"), "i");

/** Líneas de puro comentario (SQL `--`, JS `//`/`*`, JSDoc) no cuentan -- este chequeo
 *  busca CÓDIGO ejecutable real, no prosa que documente la restricción (que además es
 *  deseable: varios comentarios de este repo la explican). */
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
      if (EXCLUDE_DIRS.has(entry)) continue;
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
}

/** Exportado además como función reutilizable -- `orden-conectores-pms.ts`
 *  (REQ-REV-008) reusa exactamente esta misma verificación en vez de duplicarla. */
export function checkNoOtaDirecta(): Violation[] {
  const violations: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (!isCommentLine(line) && OTA_PATTERN.test(line)) {
          violations.push({ file: file.replace(ROOT + "/", ""), line: idx + 1, text: line.trim() });
        }
      });
    }
  }
  return violations;
}

// Solo corre + sale del proceso cuando se ejecuta directamente (`node
// scripts/checks/no-ota-directa.ts`), nunca cuando otro check lo importa como módulo.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const violations = checkNoOtaDirecta();
  if (violations.length > 0) {
    console.error("REQ-RES-022/REQ-REV-008: se encontró conectividad OTA propia fuera del channel manager/PMS:");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}: ${v.text}`);
    }
    process.exit(1);
  }

  console.log(
    "REQ-RES-022/REQ-REV-008 OK: 0 llamadas directas a API de Booking.com/Expedia/Airbnb en apps/api/src, apps/web/src ni packages/**.",
  );
  process.exit(0);
}
