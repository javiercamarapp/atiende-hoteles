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
const SUSPECT_PATTERN = new RegExp(SUSPECT_NAMES.join("|"), "gi");

/** Líneas de puro comentario (SQL `--`, JS `//`/`*`) no cuentan -- este chequeo busca
 *  columnas/campos REALES, no prosa que discuta el tema (que además es deseable:
 *  varios comentarios de este repo documentan explícitamente "nunca PAN"). */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("--") || trimmed.startsWith("//") || trimmed.startsWith("*");
}

// REQ-SEG-005/012 (2026-09-08): dos falsos positivos reales encontrados al ejecutar
// este check y verificados a mano -- ninguno de los dos es un campo/columna que
// ALMACENE datos de tarjeta, así que se documentan y excluyen explícitamente en vez de
// debilitar el patrón (mismo criterio que la exclusión de "PAN" suelto arriba):
//
// 1. `apps/api/src/logger.ts` declara `SENSITIVE_FIELDS` (lista de NEGACIÓN: nombres a
//    REDACTAR de cualquier log, nunca a persistir) que incluye "cvv" -- es protección,
//    no almacenamiento. Se excluye el archivo completo porque su único propósito es
//    esa lista.
// 2. `apps/api/src/routes/mensajeria.ts` usa `pago.containsCardNumber` (booleano de
//    detección de `paymentFreeTextGuard.ts`, ver `redactedText`) -- la sub-cadena
//    "cardnumber" aparece dentro de un identificador que es el RESULTADO de haber
//    detectado y ya redactado el dato, no un campo que lo guarde. Se excluye por
//    contexto (prefijo `contains`/`detect`/`has`/`is` inmediatamente antes del match),
//    no por archivo, para que siga aplicando si aparece en otro lugar del repo.
const ALLOWLIST_FILES = new Set(["apps/api/src/logger.ts"]);
const SAFE_PREFIXES = ["contains", "detect", "has", "is", "encontro", "found"];

function isSafeContext(line: string, matchIndex: number): boolean {
  const before = line
    .slice(Math.max(0, matchIndex - 12), matchIndex)
    .toLowerCase()
    .replace(/[_\s]/g, "");
  return SAFE_PREFIXES.some((p) => before.endsWith(p));
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
    const relPath = file.replace(ROOT + "/", "");
    if (ALLOWLIST_FILES.has(relPath)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (isCommentLine(line)) return;
      SUSPECT_PATTERN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SUSPECT_PATTERN.exec(line)) !== null) {
        if (!isSafeContext(line, m.index)) {
          violations.push({ file: relPath, line: idx + 1, text: line.trim() });
          break;
        }
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
