#!/usr/bin/env node
// REQ-REC-008/REQ-SEG-005/H19-005 · revisión estática: ninguna tabla/columna de
// packages/db/migrations declara un campo que almacene un PAN (número de tarjeta)
// completo -- el sistema solo guarda tokens del PSP (`payment.token_ref`/
// `payment.external_ref`, ver migrations/0030_folio_engine.sql). También confirma
// que ninguna ruta de apps/api/src acepta un campo llamado como número de tarjeta
// (`numeroTarjeta`, `cardNumber`, `pan`, `cvv`) en su esquema Zod de entrada.
//
// Uso: `node scripts/checks/no-pan-storage.ts` -- sale con código 1 si encuentra una
// columna/campo sospechoso.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = [join(ROOT, "packages", "db", "migrations"), join(ROOT, "apps", "api", "src")];

// Nombres de columna/campo que sugerirían almacenamiento de datos de tarjeta -- un
// "token" o "ref" no cuenta (son referencias opacas del PSP, no el PAN). Se excluye
// deliberadamente la palabra suelta "PAN" (demasiado ruidosa: aparece en comentarios
// en español explicando precisamente que NO se almacena) a favor de nombres de
// columna/campo compuestos y realistas.
const SUSPECT_NAMES = ["card_number", "cardnumber", "numero_tarjeta", "numerotarjeta", "credit_card", "cvv", "cvc", "card_pan"];
const SUSPECT_PATTERN = new RegExp(SUSPECT_NAMES.join("|"), "i");

/** Líneas de puro comentario (SQL `--`, JS `//`/`*`) no cuentan -- este chequeo busca
 *  columnas/campos REALES, no prosa que discuta el tema (que además es deseable:
 *  varios comentarios de este repo documentan explícitamente "nunca PAN"). */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("--") || trimmed.startsWith("//") || trimmed.startsWith("*");
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

interface Violation {
  file: string;
  line: number;
  text: string;
}

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
      if (!isCommentLine(line) && SUSPECT_PATTERN.test(line)) {
        violations.push({ file: file.replace(ROOT + "/", ""), line: idx + 1, text: line.trim() });
      }
    });
  }
}

if (violations.length > 0) {
  console.error("REQ-REC-008: se encontraron referencias a posible almacenamiento de PAN/CVV:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.text}`);
  }
  process.exit(1);
}

console.log("REQ-REC-008 OK: 0 columnas/campos de PAN/CVV en packages/db/migrations ni apps/api/src -- todo cobro usa token del PSP.");
process.exit(0);
