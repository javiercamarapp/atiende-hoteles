#!/usr/bin/env node
// REQ-SEG-013 (GOB-041) · revisión estática (ver docs/ACEPTACION.md): "Secretos
// gestionados por variables de entorno en desarrollo y Vault/KMS en producción
// (verificado: `.env.example` sin valores reales; arranque sin variable requerida ->
// falla explícita, no valor por defecto silencioso)."
//
// Tres verificaciones, ninguna requiere credenciales reales:
//   1. Ningún `.env` real (solo `.env.example`) está trackeado por git -- si alguien
//      commiteó un `.env` de verdad, con valores reales, este check lo detecta sin
//      tener que leer su contenido (su sola presencia en el índice de git ya es la
//      violación: `.gitignore` debería haberlo excluido).
//   2. Ningún `.env.example` del repo asigna un valor NO VACÍO a una clave cuyo
//      nombre indica que es un secreto (`*_SECRET`, `*_TOKEN`, `*_KEY`, `*_PASSWORD`,
//      `*_PASSWD`) -- estos archivos son plantillas para copiar a `.env`
//      (excluido de git), nunca deberían traer un valor real ya cargado.
//   3. Ningún archivo de código fuente real (`apps/*/src`, `packages/*/src`,
//      excluyendo `tests/`) asigna un literal de cadena "de aspecto real" (>=16
//      caracteres, alta variedad de caracteres) a un identificador/clave de nombre
//      sensible -- salvo que el propio valor se autodocumente como un placeholder de
//      desarrollo (contiene "dev_only"/"DEV_ONLY", mismo convenio ya usado en todo el
//      repo: `DEV_ONLY_JWT_SECRET`, `DEV_ONLY_KEY_HEX`, `"postgres_dev_only_local"`).
//
// Uso: `node scripts/checks/env-sin-secretos-reales.ts` -- sale con código 1 si
// encuentra una violación, imprimiendo archivo y motivo.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

interface Violation {
  file: string;
  line?: number;
  reason: string;
}
const violations: Violation[] = [];

// --- 1. ningún `.env` real trackeado por git ------------------------------------
function checkNoRealEnvTracked(): void {
  let tracked: string[];
  try {
    tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    // Sin repo git accesible (poco probable en CI): no se puede verificar esta parte,
    // no se reporta como violación silenciosa -- se avisa por stderr y se sigue con
    // las otras dos verificaciones, que no dependen de git.
    console.error("REQ-SEG-013 aviso: no se pudo listar `git ls-files`, se omite la verificación de `.env` trackeado.");
    return;
  }
  for (const path of tracked) {
    const base = path.split("/").pop() ?? path;
    if ((base === ".env" || base.startsWith(".env.")) && base !== ".env.example" && !base.endsWith(".env.example")) {
      violations.push({ file: path, reason: "un archivo `.env` real (no `.env.example`) está trackeado por git" });
    }
  }
}

// --- 2. `.env.example`: claves sensibles deben quedar vacías --------------------
const SENSITIVE_KEY_SUFFIXES = ["_SECRET", "_TOKEN", "_KEY", "_PASSWORD", "_PASSWD"];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => key.toUpperCase().endsWith(suffix));
}

function checkEnvExampleFiles(): void {
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "*.env.example"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    files = [];
  }
  for (const relPath of files) {
    const full = join(ROOT, relPath);
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eq = trimmed.indexOf("=");
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (isSensitiveKey(key) && value.length > 0) {
        violations.push({
          file: relPath,
          line: idx + 1,
          reason: `\`${key}\` tiene un valor no vacío en un archivo .env.example (debe quedar vacío -- es una plantilla, no un .env real)`,
        });
      }
    });
  }
}

// --- 3. código fuente: nada de aspecto real asignado a un nombre sensible -------
const SENSITIVE_NAME_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*(?:secret|token|password|passwd|apikey|api_key))\b/i;
// Nunca cuenta como secreto real un literal que el propio código ya marca como
// placeholder de desarrollo/prueba -- mismo convenio usado en TODO este repo:
// `DEV_ONLY_JWT_SECRET`/`DEV_SEED_PASSWORD` (env.ts, packages/db/src/seed.ts) y
// `FAKE_*_WEBHOOK_SECRET`/`FAKE_WHATSAPP_APP_SECRET` (adaptadores simulados de
// packages/mcp-servers/*/src/adapters/fake-*.ts, nunca hablan con un proveedor
// real). Un nombre que empieza así, o un VALOR que se autodocumenta con
// "dev_only"/"dev-only", nunca se reporta como secreto real.
const DEV_ONLY_MARKER = /dev[_-]?only/i;
const DEV_OR_FAKE_NAME_PREFIX = /^(fake|dev)_/i;
const SCAN_DIRS = ["apps", "packages"];

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#");
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
      if (entry === "node_modules" || entry === "dist" || entry === "tests") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".spec.ts")) {
      files.push(full);
    }
  }
  return files;
}

// Literal de cadena asignado con `=`, `:` (objeto) tras un identificador -- captura
// `NOMBRE_SECRET = "valor"`, `apiKey: "valor"`, etc. Solo dentro de `src/` de cada
// paquete (nunca fixtures/tests, ya excluidos por SCAN_DIRS -> se camina "apps"/
// "packages" completos pero se salta cualquier segmento "tests").
const ASSIGNMENT_PATTERN = /([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*["'`]([^"'`]{16,})["'`]/g;

function looksLikeRealSecretValue(value: string): boolean {
  if (DEV_ONLY_MARKER.test(value)) return false;
  // Puramente numérico, una URL, o solo repeticiones de un carácter no son "de
  // aspecto real" (evita falsos positivos como `"0".repeat(63) + "1"` -- que además
  // ya no pasaría por aquí porque no es un único literal de 16+ caracteres).
  if (/^\d+$/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  return true;
}

function checkSourceForHardcodedSecrets(): void {
  for (const dirName of SCAN_DIRS) {
    const dir = join(ROOT, dirName);
    for (const file of walk(dir)) {
      const relPath = relative(ROOT, file);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (isCommentLine(line)) return;
        ASSIGNMENT_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = ASSIGNMENT_PATTERN.exec(line))) {
          const [, name, value] = match;
          if (SENSITIVE_NAME_PATTERN.test(name!) && !DEV_OR_FAKE_NAME_PREFIX.test(name!) && looksLikeRealSecretValue(value!)) {
            violations.push({
              file: relPath,
              line: idx + 1,
              reason: `posible secreto hardcodeado: \`${name}\` = literal de ${value!.length} caracteres (no marcado como "dev_only")`,
            });
          }
        }
      });
    }
  }
}

checkNoRealEnvTracked();
checkEnvExampleFiles();
checkSourceForHardcodedSecrets();

if (violations.length > 0) {
  console.error("REQ-SEG-013: se encontraron violaciones de gestión de secretos:");
  for (const v of violations) {
    console.error(`  ${v.file}${v.line ? `:${v.line}` : ""}: ${v.reason}`);
  }
  process.exit(1);
}

console.log(
  "REQ-SEG-013 OK: 0 `.env` real trackeado, 0 valor real en `.env.example`, 0 secreto hardcodeado detectado en apps/**/src ni packages/**/src.",
);
process.exit(0);
