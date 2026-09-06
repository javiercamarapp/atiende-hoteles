#!/usr/bin/env node
// REQ-REC-004 · revisión estática: ningún archivo de apps/api/src ejecuta un
// `DELETE FROM` (ni `.query`/`.exec` con SQL de borrado) sobre las tablas de
// event-sourcing del folio (`charge`, `payment`) ni sobre `audit_log`/
// `reservation_status_event` (bitácoras append-only). El reverso de un cargo se
// modela como una fila NUEVA (`charge.reversed_by`, ver
// packages/db/migrations/0030_folio_engine.sql y apps/api/src/routes/folios.ts) --
// nunca como un DELETE ni un UPDATE que reescriba amount/tax_amount de una fila ya
// insertada.
//
// Uso: `node scripts/checks/no-delete-events.ts` -- sale con código 1 si encuentra
// una coincidencia, imprimiendo archivo:línea.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = [join(ROOT, "apps", "api", "src"), join(ROOT, "packages", "db", "migrations")];

// Tablas append-only: un DELETE (o TRUNCATE) contra cualquiera de ellas es la
// violación exacta que este chequeo busca. Las migraciones YA aplicadas nunca
// deberían tener un DELETE contra estas tablas tampoco (expand-only, GOB-011).
const APPEND_ONLY_TABLES = ["charge", "payment", "audit_log", "reservation_status_event"];

const DELETE_PATTERN = new RegExp(
  `\\b(delete\\s+from|truncate\\s+(table\\s+)?)\\s+(public\\.)?(${APPEND_ONLY_TABLES.join("|")})\\b`,
  "i",
);

interface Violation {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, files);
    } else if (/\.(ts|sql)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    let files: string[];
    try {
      files = walk(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (DELETE_PATTERN.test(line)) {
          violations.push({ file: file.replace(ROOT + "/", ""), line: idx + 1, text: line.trim() });
        }
      });
    }
  }
  return violations;
}

const violations = scan();
if (violations.length > 0) {
  console.error("REQ-REC-004: se encontraron DELETE/TRUNCATE contra tablas append-only:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.text}`);
  }
  process.exit(1);
}

console.log(`REQ-REC-004 OK: 0 DELETE/TRUNCATE contra ${APPEND_ONLY_TABLES.join(", ")} en apps/api/src ni en migraciones.`);
process.exit(0);
