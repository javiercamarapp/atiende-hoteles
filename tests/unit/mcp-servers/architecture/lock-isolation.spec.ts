// Prueba de arquitectura (análisis estático), ADR-011: "ningún módulo de reglas
// automáticas de energía ni la ruta de voz importa LockPort" (REQ-BO-029, REQ-SEG-015,
// GOB-044). Recorre el código fuente de TODOS los demás paquetes de
// packages/mcp-servers/* y falla si alguno referencia @atiende-hoteles/mcp-locks o su
// vocabulario (LockPort/issueKey/revokeKey/DigitalKey).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP_SERVERS_ROOT = fileURLToPath(new URL("../../../../packages/mcp-servers", import.meta.url));

/** No debe existir ninguna referencia a locks en estos paquetes -- solo `locks/` puede hablar de sí mismo. */
const PACKAGES_THAT_MUST_NOT_TOUCH_LOCKS = ["energy", "pms", "whatsapp", "payments", "cfdi", "shared"];

const FORBIDDEN_PATTERNS = [
  /@atiende-hoteles\/mcp-locks/,
  /\bLockPort\b/,
  /\bissueKey\b/,
  /\brevokeKey\b/,
  /\bDigitalKey\b/,
];

/**
 * Quita comentarios de bloque y de línea antes de buscar los patrones prohibidos: este
 * mismo archivo fuente (y el de `energy/src/port.ts`) documentan EN PROSA por qué nunca
 * importan `mcp-locks` -- mencionarlo en un comentario no es una violación, solo el
 * código real (import/uso) lo es.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function listTsFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (entry === "node_modules") continue;
      files.push(...listTsFilesRecursive(fullPath));
    } else if (entry.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("aislamiento estructural de LockPort (ADR-011, GOB-044)", () => {
  it.each(PACKAGES_THAT_MUST_NOT_TOUCH_LOCKS)(
    "packages/mcp-servers/%s no contiene ninguna referencia a LockPort/mcp-locks",
    (packageName) => {
      const packageDir = join(MCP_SERVERS_ROOT, packageName, "src");
      const files = listTsFilesRecursive(packageDir);
      expect(files.length).toBeGreaterThan(0); // el paquete existe y tiene código fuente

      const offendingFiles: Array<{ file: string; pattern: string }> = [];
      for (const file of files) {
        const content = stripComments(readFileSync(file, "utf8"));
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(content)) {
            offendingFiles.push({ file, pattern: pattern.source });
          }
        }
      }
      expect(offendingFiles).toEqual([]);
    },
  );

  it("el propio paquete locks/ SÍ puede (y debe) definir LockPort -- el análisis estático es sobre los OTROS paquetes", () => {
    const lockPortFile = join(MCP_SERVERS_ROOT, "locks", "src", "port.ts");
    const content = readFileSync(lockPortFile, "utf8");
    expect(content).toContain("interface LockPort");
  });
});
