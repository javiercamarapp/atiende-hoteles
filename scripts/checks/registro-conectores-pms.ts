#!/usr/bin/env node
// REQ-REV-015 (BP-141, GOB-059) · revisión estática, dos partes -- el auditor de
// contract-tests de conectores de revenue:
//   "Un subagente/proceso de auditoría de solo lectura debe verificar que cada
//   capability declarada de un conector PMS tenga contract test y que no exista
//   `if pms === X` fuera del registro central de conectores."
//
// Parte 1 (capabilities -> contract test): para cada conector `"implementado"` del
// registro único (`packages/mcp-servers/pms/src/registry.ts`), cada `capability`
// declarada debe tener al menos un contract test que la cubra explícitamente. La
// asociación capability -> test NO se infiere por heurística de texto del título del
// test (frágil: un título puede mencionar "getReservation" sin ser realmente su
// contract test, o viceversa) -- se declara con un marcador inequívoco,
// `contrato-capacidad-pms: <provider>:<capability>`, en un comentario junto al
// `it(...)` que la cubre. Ver los `it(...)` etiquetados en
// `tests/unit/mcp-servers/pms/contract.spec.ts` y
// `tests/unit/mcp-servers/pms/cloudbeds-adapter-simulator.spec.ts`.
//
// Parte 2 (unicidad del registro): reutiliza EXACTAMENTE `checkRegistroUnicoConectores`
// de `scripts/checks/registro-unico-conectores.ts` (REQ-AGT-018) -- es la misma regla
// ("prohibido `if pms === X` fuera del registro"), redactada aquí como consecuencia de
// aquel requisito; no se duplica la lógica de escaneo.
//
// REQ-QA-010 reutiliza este mismo script para su parte de PMS (ver nota en
// docs/ACEPTACION.md) -- ese requisito es más amplio (PMS + pago + CFDI) y permanece
// `pendiente` hasta que existan registros/capabilities análogos para pago y CFDI; este
// script solo cierra la parte de conectores PMS que es REQ-REV-015.
//
// Uso: `node scripts/checks/registro-conectores-pms.ts` -- sale con código 1 si
// cualquiera de las dos partes encuentra un hallazgo.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkRegistroUnicoConectores } from "./registro-unico-conectores.ts";
// Import DIRECTO al archivo del registro (no al barrel `@atiende-hoteles/mcp-pms`): el
// barrel re-exporta también los adaptadores, que usan "parameter properties" de
// TypeScript -- sintaxis que el modo strip-only de Node (`node --experimental-strip-types`,
// sin transformación real) no soporta. Mismo patrón que `orden-conectores-pms.ts`.
import { PMS_CONNECTOR_REGISTRY, type PmsConnectorRegistryEntry } from "../../packages/mcp-servers/pms/src/registry.ts";

const ROOT = join(import.meta.dirname, "..", "..");

const DEFAULT_CAPABILITY_TEST_DIRS = [
  join(ROOT, "tests", "unit", "mcp-servers", "pms"),
  join(ROOT, "tests", "integration", "contracts"),
];

// La propia suite de este check (`registro-conectores-pms.spec.ts`) vive dentro de
// `tests/unit/mcp-servers/pms/` -- el mismo directorio que escanea -- y a propósito
// contiene el texto literal del marcador dentro de fixtures de prueba (para probar
// `collectDeclaredCapabilityTests` de forma aislada). Si no se excluyera, esos
// fixtures se leerían como si fueran contract tests reales y esconderían una capability
// realmente sin cubrir (falso negativo) -- mismo problema, y misma solución, que la
// auto-exclusión de `checks/` en `registro-unico-conectores.ts`.
const DEFAULT_EXCLUDE_BASENAMES = new Set(["registro-conectores-pms.spec.ts"]);

export interface CapabilityViolation {
  provider: string;
  capability: string;
  reason: string;
}

// `contrato-capacidad-pms: cloudbeds:getReservation` -- dos grupos de captura
// (provider, capability), tolerante a espacios alrededor de los `:`.
const CAPABILITY_MARKER_RE = /contrato-capacidad-pms:\s*([a-z0-9-]+)\s*:\s*([a-zA-Z0-9]+)/;

function walkSpecFiles(dir: string, excludeBasenames: Set<string>, files: string[] = []): string[] {
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
      if (entry === "node_modules" || entry === "dist") continue;
      walkSpecFiles(full, excludeBasenames, files);
    } else if (/\.spec\.tsx?$/.test(entry) && !excludeBasenames.has(entry)) {
      files.push(full);
    }
  }
  return files;
}

/** Escanea `scanDirs` en busca del marcador `contrato-capacidad-pms: <provider>:<capability>`
 *  y devuelve el conjunto `"<provider>:<capability>"` encontrado. Exportado para pruebas.
 *  `excludeBasenames` excluye archivos por nombre exacto (ver `DEFAULT_EXCLUDE_BASENAMES`
 *  arriba) -- inyectable solo para pruebas, igual que `scanDirs`. */
export function collectDeclaredCapabilityTests(
  scanDirs: string[] = DEFAULT_CAPABILITY_TEST_DIRS,
  excludeBasenames: Set<string> = DEFAULT_EXCLUDE_BASENAMES,
): Set<string> {
  const found = new Set<string>();
  for (const dir of scanDirs) {
    for (const file of walkSpecFiles(dir, excludeBasenames)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        const match = line.match(CAPABILITY_MARKER_RE);
        if (match) found.add(`${match[1]}:${match[2]}`);
      }
    }
  }
  return found;
}

/** `registry`/`scanDirs` inyectables SOLO para pruebas (mismo patrón que
 *  `checkRegistroUnicoConectores`) -- el uso real (CLI) siempre usa los defaults, que
 *  leen el registro y el árbol de tests reales del repo. */
export function checkCapabilityContractTests(
  registry: readonly PmsConnectorRegistryEntry[] = PMS_CONNECTOR_REGISTRY,
  scanDirs: string[] = DEFAULT_CAPABILITY_TEST_DIRS,
): CapabilityViolation[] {
  const declared = collectDeclaredCapabilityTests(scanDirs);
  const violations: CapabilityViolation[] = [];
  for (const entry of registry) {
    if (entry.status !== "implementado") continue; // nada que auditar en un conector sin adaptador
    for (const capability of entry.capabilities) {
      const key = `${entry.provider}:${capability}`;
      if (!declared.has(key)) {
        violations.push({
          provider: entry.provider,
          capability,
          reason:
            `capability declarada en PMS_CONNECTOR_REGISTRY sin contract test (falta el marcador ` +
            `'contrato-capacidad-pms: ${key}' en un it(...) bajo tests/unit/mcp-servers/pms/ o ` +
            `tests/integration/contracts/)`,
        });
      }
    }
  }
  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const capabilityViolations = checkCapabilityContractTests();
  const registryViolations = checkRegistroUnicoConectores();

  if (capabilityViolations.length > 0 || registryViolations.length > 0) {
    if (capabilityViolations.length > 0) {
      console.error(
        "REQ-REV-015 (parte 1, capability sin contract test): se encontraron capabilities declaradas en " +
          "PMS_CONNECTOR_REGISTRY sin contract test:",
      );
      for (const v of capabilityViolations) {
        console.error(`  ${v.provider}:${v.capability}: ${v.reason}`);
      }
    }
    if (registryViolations.length > 0) {
      console.error(
        "REQ-REV-015 (parte 2, registro único): se encontró bifurcación por proveedor " +
          "(`if`/`switch` sobre `provider`/`pms`) fuera del registro central:",
      );
      for (const v of registryViolations) {
        console.error(`  ${v.file}:${v.line} [${v.kind}]: ${v.text}`);
      }
    }
    process.exit(1);
  }

  console.log(
    "REQ-REV-015 OK: toda capability declarada de un conector PMS implementado tiene contract test, y 0 " +
      "bifurcaciones por proveedor fuera del registro central.",
  );
  process.exit(0);
}
