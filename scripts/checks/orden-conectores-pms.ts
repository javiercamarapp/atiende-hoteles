#!/usr/bin/env node
// REQ-REV-008 (H15-006) · revisión estática, dos partes:
//   1. Reutiliza exactamente la misma verificación que
//      `scripts/checks/no-ota-directa.ts` (REQ-RES-022): 0 conectividad OTA propia
//      fuera del channel manager/PMS certificado.
//   2. Confirma que el orden de prioridad de construcción de conectores PMS
//      (Cloudbeds→Mews→SiteMinder→OHIP, docs/REQUISITOS.md §4 punto 8) está
//      reflejado en el registro único (`@atiende-hoteles/mcp-pms`,
//      `PMS_CONNECTOR_REGISTRY`) -- el mismo registro que
//      `tests/unit/mcp-servers/pms/registro-conectores.spec.ts` prueba, y que
//      REQ-AGT-018 exige como el ÚNICO lugar donde se bifurca por nombre de proveedor.
//
// Uso: `node scripts/checks/orden-conectores-pms.ts` -- sale con código 1 si
// cualquiera de las dos partes falla.
import { checkNoOtaDirecta } from "./no-ota-directa.ts";
// Import DIRECTO al archivo del registro (no al barrel `@atiende-hoteles/mcp-pms`):
// el barrel re-exporta también los adaptadores, que usan "parameter properties" de
// TypeScript -- sintaxis que el modo strip-only de Node (sin transformación real, ver
// `node --experimental-strip-types`) no soporta. El registro en sí es TS sencillo
// (sin esa sintaxis), así que se importa aparte para que este check corra con
// `node scripts/checks/orden-conectores-pms.ts` sin flags adicionales.
import { PMS_CONNECTOR_REGISTRY, type PmsConnectorRegistryEntry } from "../../packages/mcp-servers/pms/src/registry.ts";

const EXPECTED_ORDER: PmsConnectorRegistryEntry["provider"][] = ["cloudbeds", "mews", "siteminder", "ohip"];

function checkOrdenRegistro(): string[] {
  const errors: string[] = [];
  const byPriority = [...PMS_CONNECTOR_REGISTRY].sort((a, b) => a.priority - b.priority);
  const actualOrder = byPriority.map((e) => e.provider);

  if (JSON.stringify(actualOrder) !== JSON.stringify(EXPECTED_ORDER)) {
    errors.push(
      `orden de prioridad incorrecto en PMS_CONNECTOR_REGISTRY: esperado ${EXPECTED_ORDER.join("→")}, ` +
        `encontrado ${actualOrder.join("→")}`,
    );
  }

  const priorities = PMS_CONNECTOR_REGISTRY.map((e) => e.priority);
  if (new Set(priorities).size !== priorities.length) {
    errors.push("PMS_CONNECTOR_REGISTRY tiene prioridades duplicadas.");
  }

  return errors;
}

const otaViolations = checkNoOtaDirecta();
const ordenErrors = checkOrdenRegistro();

if (otaViolations.length > 0 || ordenErrors.length > 0) {
  if (otaViolations.length > 0) {
    console.error("REQ-REV-008 (parte 1, OTA directa): se encontró conectividad OTA propia:");
    for (const v of otaViolations) {
      console.error(`  ${v.file}:${v.line}: ${v.text}`);
    }
  }
  if (ordenErrors.length > 0) {
    console.error("REQ-REV-008 (parte 2, orden de conectores):");
    for (const e of ordenErrors) console.error(`  ${e}`);
  }
  process.exit(1);
}

console.log(
  "REQ-REV-008 OK: 0 conectividad OTA propia + orden de prioridad Cloudbeds→Mews→SiteMinder→OHIP reflejado en el registro.",
);
process.exit(0);
