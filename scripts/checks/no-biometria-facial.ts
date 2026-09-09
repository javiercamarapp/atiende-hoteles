#!/usr/bin/env node
// REQ-HUE-022/REQ-SEG-003 · revisión estática: confirma 0 uso de reconocimiento
// FACIAL -- ningún SDK/API/librería/función de reconocimiento facial conocido -- en
// todo el código de aplicación real (apps/, packages/), no solo en
// apps/api/src/routes/checkinOnline.ts (REQ-SEG-003 no acota "en check-in" a "online",
// así que el barrido cubre cualquier ruta/paquete donde pudiera colarse). Este check
// NO prohíbe "biometría" en general (huella, firma dinámica) -- esa es una decisión
// reservada al fundador (GOB-051 "activación de biometría", REQ-SEG-017) que este
// script no arbitra; lo que sí debe ser estructuralmente cero, siempre, es
// reconocimiento facial (BP-091: "prohibido en check-in").
//
// Reproduce en código el barrido manual que ya hizo auditoria-2/legal.md ("búsqueda
// exhaustiva de facial/biometric/biometr en apps/ y packages/ no encontró ningún
// código relacionado") pero con patrones específicos de SDK/API/vendor de
// reconocimiento facial en vez de las subcadenas sueltas "facial"/"biometr" (esas dos
// solas producen falsos positivos reales de este propio repo -- p.ej. "interFACE",
// o la etiqueta de categoría de gobierno "retencion_o_biometria" en
// packages/db/migrations/0081_decisiones_reservadas_fundador.sql, que documenta una
// política, no invoca reconocimiento facial).
//
// Uso: `node scripts/checks/no-biometria-facial.ts` -- sale con código 1 si encuentra
// una referencia real (fuera de comentario) a reconocimiento facial.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = [join(ROOT, "apps"), join(ROOT, "packages")];
const SCAN_EXTENSIONS = /\.(ts|tsx|sql)$/;
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "coverage", ".turbo"]);

// Patrones específicos de reconocimiento FACIAL: frases completas, nombres de
// SDK/API/función/vendor reales, con límite de palabra (`\b`) donde el patrón es un
// solo token -- para no disparar con subcadenas incidentales dentro de otra palabra
// (p.ej. `\bface\b` jamás debe escribirse suelto: dispararía con "interface",
// "surface", "preface"; por eso cada patrón exige un compuesto realista de
// reconocimiento facial, nunca la palabra "face"/"facial" a secas).
const SUSPECT_PATTERNS: RegExp[] = [
  /reconocimiento\s+facial/i,
  /reconocimiento\s+de\s+rostro/i,
  /facial\s+recognition/i,
  /face\s+recognition/i,
  /\bfacial_?recognition\b/i,
  /\bface-?api\b/i,
  /\brekognition\b/i,
  /\bdetect_?faces?\b/i,
  /\bcompare_?faces?\b/i,
  /\bface_?match\b/i,
  /\bface_?embedding\b/i,
  /\bface_?print\b/i,
  /\bface_?landmarks?\b/i,
  /\bface_?liveness\b/i,
  /\bliveness_?(check|detection|verification)\b/i,
  /\bhaarcascade\b/i,
  /\bdlib\b/i,
  /\bkairos\b/i,
  /\bface(\+\+|pp)\b/i,
  /\bluxand\b/i,
  /\bclearview\b/i,
  /\bverify_?face\b/i,
  /\bface_?verification\b/i,
  /\bbiometric_?face\b/i,
];

/** Líneas de puro comentario (SQL `--`, JS/TS `//`/`*`/`/*`) no cuentan -- este check
 *  busca CÓDIGO real que invoque reconocimiento facial, no prosa que documente su
 *  ausencia (varios comentarios de este repo dicen explícitamente "sin biometría"/
 *  "prohibido reconocimiento facial", que es exactamente lo deseable). */
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
    } else if (SCAN_EXTENSIONS.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

interface Violation {
  file: string;
  line: number;
  text: string;
  pattern: string;
}

const violations: Violation[] = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (isCommentLine(line)) return;
      for (const pattern of SUSPECT_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ file: relative(ROOT, file), line: idx + 1, text: line.trim(), pattern: pattern.source });
          break;
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error("REQ-HUE-022/REQ-SEG-003: se encontraron referencias a reconocimiento facial en código de aplicación:");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.text}  [patrón: ${v.pattern}]`);
  }
  process.exit(1);
}

console.log(
  `REQ-HUE-022/REQ-SEG-003 OK: 0 referencias a reconocimiento facial en apps/ y packages/ (${SUSPECT_PATTERNS.length} patrones de SDK/API/función/vendor de reconocimiento facial verificados, comentarios excluidos).`,
);
process.exit(0);
