#!/usr/bin/env node
// auditoria-2/arquitectura [ALTO]: "la documentación-en-código que declara 'el runtime
// real de apps/api es node --experimental-strip-types' ya no es cierta (el flag real
// es --experimental-transform-types desde H5) pero sigue repetida sin corregir en 9+
// archivos". El fix de H5 cambió el FLAG de `apps/api/package.json` en vez de arreglar
// el código (packages/mcp-servers/{payments,cfdi} usaban "parameter properties",
// incompatibles con el modo de solo strip); H6b sí arregló el código en otros 7
// archivos (agent-core + mcp-servers/{shared,whatsapp}), pero ninguno de los dos pasos
// actualizó los comentarios/README que declaraban la regla vieja como universal.
// Consecuencia real: un ingeniero (o un futuro agente) que "corrija"
// `apps/api/package.json` de vuelta a `--experimental-strip-types` para que coincida
// con la documentación tumba el arranque completo del backend en cuanto
// `app.ts` carga `@atiende-hoteles/mcp-payments`/`mcp-cfdi` (que sí usan ese azúcar) --
// el mismo defecto que ya ocurrió dos veces (H5, H6b).
//
// Este script analiza ESTÁTICAMENTE (sin ejecutar nada) el flag real declarado en
// `apps/api/package.json` ("dev"/"start") y lo compara contra el flag que documentan
// un conjunto conocido de archivos que hacen esa misma afirmación explícita sobre "el
// runtime real de apps/api" -- falla si alguno quedó desactualizado.
//
// Alcance ACTUAL de este check (auditoria-2, lote C -- frontend/operabilidad/
// arquitectura): cubre los archivos que este mismo lote corrigió. `packages/agent-core`
// (README + src/{postgresApproval,runner,provider}.ts) es territorio de otro lote de
// esta misma ronda de corrección y sigue pendiente de que ESE lote actualice sus
// propios comentarios -- añadirlos aquí haría fallar este check por un archivo que este
// lote no tiene permitido editar. Ver docs/auditoria-2/correccion-C-frontend-ops-arq.md.
//
// Uso:
//   node --experimental-strip-types scripts/check-runtime-flags.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

export interface RuntimeFlagCheckResult {
  ok: boolean;
  actualFlag: "strip" | "transform";
  errors: string[];
}

const FLAG_STRIP = "--experimental-strip-types";
const FLAG_TRANSFORM = "--experimental-transform-types";

/** Archivos que declaran explícitamente "el runtime real de apps/api" -- deben
 *  mencionar el flag ACTUAL de `apps/api/package.json`, nunca el otro. */
export const DOCUMENTED_FILES = [
  "apps/api/README.md",
  "packages/mcp-servers/shared/src/errors.ts",
  "packages/mcp-servers/shared/src/hmac.ts",
  "packages/mcp-servers/whatsapp/src/port.ts",
  "packages/mcp-servers/whatsapp/src/adapters/fake-whatsapp-adapter.ts",
  "docs/runbooks/operacion.md",
];

function readApiPackageJsonFlag(rootDir: string): "strip" | "transform" {
  const raw = readFileSync(join(rootDir, "apps/api/package.json"), "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  const devScript = pkg.scripts?.dev ?? "";
  if (devScript.includes(FLAG_TRANSFORM)) return "transform";
  if (devScript.includes(FLAG_STRIP)) return "strip";
  throw new Error(
    `apps/api/package.json "scripts.dev" no declara ningún flag de type-stripping conocido (${FLAG_STRIP} / ${FLAG_TRANSFORM}): "${devScript}"`,
  );
}

export function checkRuntimeFlags(rootDir: string = ROOT, files: string[] = DOCUMENTED_FILES): RuntimeFlagCheckResult {
  const actualFlag = readApiPackageJsonFlag(rootDir);
  const wrongFlag = actualFlag === "strip" ? FLAG_TRANSFORM : FLAG_STRIP;
  const rightFlag = actualFlag === "strip" ? FLAG_STRIP : FLAG_TRANSFORM;
  const errors: string[] = [];

  for (const relPath of files) {
    let content: string;
    try {
      content = readFileSync(join(rootDir, relPath), "utf8");
    } catch {
      errors.push(`${relPath}: no se pudo leer (¿se movió o se borró? actualiza DOCUMENTED_FILES).`);
      continue;
    }
    const mentionsRight = content.includes(rightFlag);
    const mentionsWrongAsIfCurrent =
      content.includes(wrongFlag) &&
      // El flag "equivocado" puede aparecer legítimamente en un comentario que EXPLICA
      // la diferencia (ej. "ya no usa --experimental-strip-types") -- solo es un error
      // real si el archivo NO menciona en ningún lado el flag correcto actual, es
      // decir, si sigue declarando el viejo como si fuera el único/vigente.
      !mentionsRight;
    if (mentionsWrongAsIfCurrent) {
      errors.push(
        `${relPath}: menciona "${wrongFlag}" sin mencionar en ningún lado el flag real actual de apps/api ("${rightFlag}", ver apps/api/package.json "dev"/"start") -- documentación desactualizada.`,
      );
    }
    if (!mentionsRight && !content.includes(wrongFlag)) {
      errors.push(`${relPath}: no menciona ningún flag de type-stripping -- ¿se removió el comentario relevante sin querer?`);
    }
  }

  return { ok: errors.length === 0, actualFlag, errors };
}

function main() {
  const result = checkRuntimeFlags();
  if (result.ok) {
    console.log(
      `check-runtime-flags: OK (${DOCUMENTED_FILES.length} archivo(s) verificados contra el flag real de apps/api: --experimental-${result.actualFlag}-types).`,
    );
    return;
  }
  console.error(`check-runtime-flags: FALLA -- ${result.errors.length} problema(s):`);
  for (const err of result.errors) console.error(`  - ${err}`);
  process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("check-runtime-flags.ts")) {
  main();
}
