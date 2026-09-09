#!/usr/bin/env node
// REQ-GOB-013 (GOB-016, ADR-005, BP-011, BP-140) · revisión estática con dos reglas
// independientes, ambas exigidas por el mismo requisito (docs/ACEPTACION.md):
//
//   (a) "ningún módulo de lógica de negocio fuera del conector PMS escribe en
//       `pms_mirror` (solo lectura)". El conector PMS de ADR-007 es EXCLUSIVAMENTE
//       `packages/mcp-servers/pms` (ver el propio comentario de
//       `scripts/checks/no-ota-directa.ts` y el README de ese paquete) -- código ahí
//       queda exento; cualquier otro archivo que contenga un INSERT/UPDATE/DELETE/
//       UPSERT/TRUNCATE (SQL crudo o estilo query-builder) contra una tabla
//       `pms_mirror` es una violación.
//
//       Estado real verificado 2026-09-08 (ver docs/TRAZABILIDAD.md REQ-GOB-013):
//       `pms_mirror` NO existe todavía como tabla en ninguna migración de
//       `packages/db/migrations` ni se referencia en `apps/api/src` (0 coincidencias
//       de `grep -r "pms_mirror"` fuera de `docs/`). Esta regla se verifica hoy en
//       VACÍO HONESTO -- 0 violaciones porque la tabla no existe, no porque el check
//       esté simulado -- exactamente como cerró `scripts/checks/ocr-aislado-sin-
//       internet.ts` para REQ-AGT-013. El check congela la invariante desde HOY para
//       que, cuando el primer conector PMS real cree `pms_mirror` (H4/H9,
//       docs/ACEPTACION.md hito H1), cualquier escritura fuera de
//       `packages/mcp-servers/pms` falle CI de inmediato en vez de descubrirse después.
//
//   (b) "ninguna regla automática invoca directamente el control de cerraduras"
//       (compartida con REQ-BO-029/REQ-SEG-015, GOB-044, ADR-011). El paquete que
//       define el contrato de cerraduras es EXCLUSIVAMENTE
//       `packages/mcp-servers/locks` (`LockPort`, ver su `port.ts`) -- código ahí
//       queda exento; cualquier otro archivo de `apps/**`/`packages/**` que
//       referencie su vocabulario (`@atiende-hoteles/mcp-locks`, `LockPort`,
//       `issueKey`, `revokeKey`, `DigitalKey`) fuera de un comentario es una
//       violación. A diferencia de (a), esta regla NO es vacía: ya hoy
//       `packages/mcp-servers/energy` (el motor de reglas automáticas de energía) y
//       el resto de `packages/mcp-servers/*` existen como código real y ya respetan
//       la separación -- es la misma invariante estructural que
//       `tests/unit/mcp-servers/architecture/lock-isolation.spec.ts` prueba con
//       `vitest`, expuesta aquí además como script standalone (el comando exacto que
//       exige `docs/ACEPTACION.md` para REQ-GOB-013), con alcance más amplio
//       (`apps/**` además de `packages/mcp-servers/*`).
//
// Uso: `node scripts/checks/pms-mirror-solo-lectura.ts` -- sale con código 1 si
// encuentra una coincidencia de cualquiera de las dos reglas, imprimiendo
// archivo:línea y la categoría de violación.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

// Se escanea código fuente ejecutable de apps/ y packages/ -- nunca `docs/` (que
// discute la regla extensamente en prosa) ni este mismo directorio de checks.
const DEFAULT_SCAN_DIRS = [join(ROOT, "apps"), join(ROOT, "packages")];
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "checks", ".git"]);

// (a) Único directorio autorizado a escribir en `pms_mirror`: el conector PMS real de
// ADR-007 (ver también scripts/checks/no-ota-directa.ts). `apps/api/src/pms/` NO
// cuenta -- es una carpeta con el mismo nombre pero de otro dominio (precio/impuesto
// propio, ver su propio comentario en `dbRoomRatePort.ts`), así que SÍ se revisa.
const PMS_CONNECTOR_PATH_SEGMENT = `${join("packages", "mcp-servers", "pms")}${"/"}`;

// (b) Único directorio autorizado a definir/usar el vocabulario de `LockPort`: el
// paquete de cerraduras de ADR-011.
const LOCKS_PACKAGE_PATH_SEGMENT = `${join("packages", "mcp-servers", "locks")}${"/"}`;

// Verbos de escritura SQL cruda contra `pms_mirror` (con o sin comillas/prefijo de
// esquema `public.`) -- cubre las cuatro formas de escritura relevantes; UPSERT en
// Postgres real es `INSERT ... ON CONFLICT`, ya cubierto por el patrón de INSERT.
const PMS_MIRROR_TABLE = `["'\`]?(?:public\\.)?["'\`]?pms_mirror["'\`]?`;
const PMS_MIRROR_WRITE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "INSERT INTO pms_mirror", re: new RegExp(`\\binsert\\s+into\\s+${PMS_MIRROR_TABLE}\\b`, "i") },
  { name: "UPDATE pms_mirror", re: new RegExp(`\\bupdate\\s+${PMS_MIRROR_TABLE}\\s+set\\b`, "i") },
  { name: "DELETE FROM pms_mirror", re: new RegExp(`\\bdelete\\s+from\\s+${PMS_MIRROR_TABLE}\\b`, "i") },
  { name: "TRUNCATE pms_mirror", re: new RegExp(`\\btruncate\\s+(?:table\\s+)?${PMS_MIRROR_TABLE}\\b`, "i") },
  // Estilo query-builder/ORM (por si el sync real de H4/H9 no usa SQL crudo):
  // `db.insert('pms_mirror', ...)`, `pmsMirror.update(...)`, etc.
  { name: "query-builder write a pms_mirror", re: /\b(?:pms_mirror|pmsMirror)\b[^\n]{0,40}\.\s*(?:insert|update|upsert|delete)\s*\(/i },
  { name: "query-builder write a pms_mirror (tabla como argumento)", re: /\.\s*(?:insert|update|upsert|delete)\s*\(\s*["'`](?:public\.)?pms_mirror["'`]/i },
];

// Vocabulario de LockPort (GOB-044) -- idéntico al de
// tests/unit/mcp-servers/architecture/lock-isolation.spec.ts.
const LOCK_FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "@atiende-hoteles/mcp-locks", re: /@atiende-hoteles\/mcp-locks/ },
  { name: "LockPort", re: /\bLockPort\b/ },
  { name: "issueKey", re: /\bissueKey\b/ },
  { name: "revokeKey", re: /\brevokeKey\b/ },
  { name: "DigitalKey", re: /\bDigitalKey\b/ },
];

/** Líneas de puro comentario (SQL `--`, JS `//`/`*`, JSDoc) no cuentan -- ambas reglas
 *  buscan CÓDIGO ejecutable real, no la prosa de este mismo archivo (ni de
 *  `port.ts`/`README.md` de cada paquete) que discute la restricción. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("--") || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("#");
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

export interface PmsMirrorViolation {
  file: string;
  line: number;
  text: string;
  category: "escritura-fuera-de-conector-pms" | "invocacion-directa-de-cerraduras";
}

/** `scanDirs`/`relativeTo` son inyectables SOLO para pruebas (directorios temporales
 *  sintéticos, mismo patrón que `scripts/checks/ocr-aislado-sin-internet.ts`) -- el uso
 *  real (CLI) siempre escanea el repo real vía los defaults. */
export function checkPmsMirrorSoloLectura(
  scanDirs: string[] = DEFAULT_SCAN_DIRS,
  relativeTo: string = ROOT,
): PmsMirrorViolation[] {
  const violations: PmsMirrorViolation[] = [];
  for (const dir of scanDirs) {
    for (const file of walk(dir)) {
      const relFile = file.replace(relativeTo + "/", "");
      const isPmsConnector = `${relFile}/`.includes(PMS_CONNECTOR_PATH_SEGMENT) || relFile.startsWith(PMS_CONNECTOR_PATH_SEGMENT);
      const isLocksPackage = `${relFile}/`.includes(LOCKS_PACKAGE_PATH_SEGMENT) || relFile.startsWith(LOCKS_PACKAGE_PATH_SEGMENT);

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (isCommentLine(line)) return;

        // (a) escritura a pms_mirror -- exento SOLO el conector PMS real.
        if (!isPmsConnector) {
          for (const pattern of PMS_MIRROR_WRITE_PATTERNS) {
            if (pattern.re.test(line)) {
              violations.push({ file: relFile, line: idx + 1, text: line.trim(), category: "escritura-fuera-de-conector-pms" });
              break;
            }
          }
        }

        // (b) invocación directa del control de cerraduras -- exento SOLO el paquete
        // que define LockPort.
        if (!isLocksPackage) {
          for (const pattern of LOCK_FORBIDDEN_PATTERNS) {
            if (pattern.re.test(line)) {
              violations.push({ file: relFile, line: idx + 1, text: line.trim(), category: "invocacion-directa-de-cerraduras" });
              break;
            }
          }
        }
      });
    }
  }
  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const violations = checkPmsMirrorSoloLectura();
  if (violations.length > 0) {
    console.error("REQ-GOB-013: se encontraron violaciones de solo-lectura de pms_mirror / aislamiento de cerraduras:");
    for (const v of violations) {
      console.error(`  [${v.category}] ${v.file}:${v.line}: ${v.text}`);
    }
    process.exit(1);
  }
  console.log(
    "REQ-GOB-013 OK:\n" +
      "  (a) 0 escrituras a `pms_mirror` fuera de packages/mcp-servers/pms en apps/**, packages/** --\n" +
      "      regla vacía honesta: `pms_mirror` todavía no existe como tabla (se crea en H4/H9 con el\n" +
      "      primer conector PMS certificado, ver docs/ACEPTACION.md hito H1); el check queda listo para\n" +
      "      congelar la invariante desde el primer commit que la cree.\n" +
      "  (b) 0 referencias a LockPort/mcp-locks/issueKey/revokeKey/DigitalKey fuera de\n" +
      "      packages/mcp-servers/locks en apps/**, packages/** -- regla real y ya cumplida hoy (GOB-044,\n" +
      "      compartida con REQ-BO-029/REQ-SEG-015).",
  );
  process.exit(0);
}
