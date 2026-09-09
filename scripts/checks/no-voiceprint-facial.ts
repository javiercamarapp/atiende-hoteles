#!/usr/bin/env node
// REQ-AGT-006 (GOB-035, BP-123, H08-020, BP-168) · revisión estática: "no debe existir
// reconocimiento de voz (voiceprint) ni facial" en todo el código de aplicación real
// (apps/, packages/). Confirma 0 referencias a un SDK/API/librería/vendor conocido de
// reconocimiento de LOCUTOR (voiceprint/speaker recognition) O de reconocimiento
// FACIAL -- ninguna de las dos formas de biometría de identificación remota que el
// criterio de aceptación de REQ-AGT-006 prohíbe explícitamente.
//
// Independiente de `scripts/checks/no-biometria-facial.ts` (REQ-SEG-003/REQ-HUE-022,
// "prohibido en check-in"): ese script cubre SOLO reconocimiento facial, para un
// requisito distinto con su propio criterio ("check-in"). Este script duplica
// deliberadamente la lista de patrones faciales (en vez de importarla) para que
// REQ-AGT-006 tenga su propia verificación completa e independiente -- si algún día
// alguno de los dos scripts cambia sus patrones, el otro requisito no queda huérfano de
// cobertura en silencio.
//
// Patrones de VOZ acotados a reconocimiento/verificación DE LOCUTOR (identidad de quién
// habla, "voiceprint") -- nunca a transcripción/voz-a-texto (speech-to-text), que es una
// capacidad distinta y NO está prohibida por este requisito. Por eso el patrón español
// "reconocimiento de voz" SÍ se incluye tal cual (es el término literal que usa el propio
// criterio de aceptación de REQ-AGT-006, entre paréntesis junto a "voiceprint") pero
// nombres genéricos de una sola palabra ("voice", "speaker", "voiceId" -- este último un
// nombre de parámetro legítimo y común en integraciones de texto-a-voz/TTS) se excluyen
// a propósito para no disparar falsos positivos con una futura integración de
// transcripción o de síntesis de voz: cualquier código de STT/TTS que se agregue debe
// nombrarse de forma que no calce con estos patrones compuestos, precisamente para que
// este check seguro siga distinguiendo "convertir audio a texto"/"leer texto con una voz"
// de "identificar QUIÉN es el hablante".
//
// Uso: `node scripts/checks/no-voiceprint-facial.ts` -- sale con código 1 si encuentra
// una referencia real (fuera de comentario) a reconocimiento de locutor/voiceprint o a
// reconocimiento facial.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = [join(ROOT, "apps"), join(ROOT, "packages")];
const SCAN_EXTENSIONS = /\.(ts|tsx|sql)$/;
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "coverage", ".turbo"]);

// -- Reconocimiento de LOCUTOR / voiceprint --------------------------------------------
// Frases completas y nombres de SDK/API/vendor reales de biometría de voz, cada uno
// exigiendo un compuesto específico (nunca "voice"/"speaker"/"voz" sueltos) para no
// disparar con vocabulario legítimo de audio/telefonía/TTS/STT que este repo sí puede
// necesitar (p.ej. "voiceId" de una integración de texto-a-voz, "speakerphone").
const VOICEPRINT_PATTERNS: RegExp[] = [
  /\bvoiceprint\b/i,
  /\bvoice[_ -]?print\b/i,
  /huella\s+de\s+voz/i,
  /\bspeaker[_ -]?recognition\b/i,
  /\bspeaker[_ -]?verification\b/i,
  /\bspeaker[_ -]?identification\b/i,
  /reconocimiento\s+de\s+voz/i,
  /reconocimiento\s+de\s+hablante/i,
  /reconocimiento\s+de\s+locutor/i,
  /verificaci[oó]n\s+de\s+voz/i,
  /verificaci[oó]n\s+de\s+hablante/i,
  /identificaci[oó]n\s+de\s+hablante/i,
  /identificaci[oó]n\s+de\s+locutor/i,
  /\bvoice[_ -]?biometric(s)?\b/i,
  /biometr[ií]a\s+de\s+voz/i,
  /\bvoice[_ -]?match(ing)?\b/i,
  /\bvoice[_ -]?embedding\b/i,
  // Vendors/productos reales de biometría de voz.
  /\bvocalpassword\b/i,
  /\bpindrop\b/i,
  /\bvoiceit\b/i,
  /\bvalidsoft\b/i,
  /\barmorvox\b/i,
  // Compuesto específico (no "voice_id" a secas -- ese es un nombre de parámetro común
  // de TTS) para la feature real de Amazon Connect.
  /connect[_ -]?voice[_ -]?id\b/i,
  // Arquitectura de embedding de locutor usada por librerías de voiceprint (requiere
  // "tdnn" junto a "ecapa" -- evita el falso positivo de "effe`ctiveCapa`city").
  /\becapa[-_]?tdnn\b/i,
];

// -- Reconocimiento FACIAL --------------------------------------------------------------
// Misma lista que scripts/checks/no-biometria-facial.ts (REQ-SEG-003/REQ-HUE-022) --
// duplicada a propósito, ver comentario de archivo.
const FACIAL_PATTERNS: RegExp[] = [
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

const SUSPECT_PATTERNS: ReadonlyArray<{ pattern: RegExp; categoria: "voiceprint" | "facial" }> = [
  ...VOICEPRINT_PATTERNS.map((pattern) => ({ pattern, categoria: "voiceprint" as const })),
  ...FACIAL_PATTERNS.map((pattern) => ({ pattern, categoria: "facial" as const })),
];

/** Líneas de puro comentario (SQL `--`, JS/TS `//`/`*`/`/*`) no cuentan -- este check
 *  busca CÓDIGO real que invoque reconocimiento de locutor/facial, no prosa que
 *  documente su ausencia (varios comentarios de este repo dicen explícitamente "sin
 *  voiceprint"/"prohibido reconocimiento facial", que es exactamente lo deseable). */
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
  categoria: "voiceprint" | "facial";
}

const violations: Violation[] = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (isCommentLine(line)) return;
      for (const { pattern, categoria } of SUSPECT_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ file: relative(ROOT, file), line: idx + 1, text: line.trim(), pattern: pattern.source, categoria });
          break;
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error("REQ-AGT-006: se encontraron referencias a reconocimiento de voz (voiceprint) o facial en código de aplicación:");
  for (const v of violations) {
    console.error(`  [${v.categoria}] ${v.file}:${v.line}: ${v.text}  [patrón: ${v.pattern}]`);
  }
  process.exit(1);
}

console.log(
  `REQ-AGT-006 OK: 0 referencias a reconocimiento de voz (voiceprint) o facial en apps/ y packages/ ` +
    `(${VOICEPRINT_PATTERNS.length} patrones de voiceprint + ${FACIAL_PATTERNS.length} patrones faciales verificados, comentarios excluidos).`,
);
process.exit(0);
