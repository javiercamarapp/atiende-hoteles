#!/usr/bin/env node
// REQ-QA-010 (BP-141) · "Cada capability declarada de un conector (PMS, pago, CFDI)
// debe tener su contract test correspondiente, verificado por un subagente/proceso de
// auditoría de solo lectura antes de cada release." (compartido con REQ-REV-015, que
// exige además la ausencia de `if pms === X` fuera del registro -- eso ya lo cubre
// `scripts/checks/registro-unico-conectores.ts`; este archivo cubre SOLO la parte de
// cobertura de contract test por capability, para los 3 tipos de conector que el
// requisito nombra explícitamente: PMS, pago, CFDI).
//
// Reconciliación de fusión (closure/todos-los-req-hoteles-lote1, 2026-09-11): este
// archivo se llama `registro-conectores-contract-tests.ts` (NO `registro-conectores-
// pms.ts`, su nombre original en la rama `closure/req-qa-010`) porque
// `scripts/checks/registro-conectores-pms.ts` YA EXISTÍA con una implementación propia
// e independiente de REQ-REV-015 (mecanismo de marcador `contrato-capacidad-pms:` en
// vez del escaneo por `contractTestFiles` de abajo) -- las dos ramas crearon un archivo
// en la MISMA ruta sin saberlo (conflicto add/add real, sin solape textual). Ambas
// implementaciones se conservan completas, cada una con su propio archivo y su propia
// prueba (`tests/unit/qa/registro-conectores-pms.spec.ts` para ESTE archivo,
// `tests/unit/mcp-servers/pms/registro-conectores-pms.spec.ts` para el otro).
//
// El patrón de contract test por conector (REQ-INT-001/002/005, REQ-QA-003) ya existe
// ampliamente en este repo -- lo que faltaba era el PASO de verificación automática en
// sí: un proceso que lea (nunca escriba) el contrato (`PmsPort`/`PaymentProviderPort`/
// `CfdiPort`) y los archivos de prueba declarados como su evidencia, y BLOQUEE
// (exit 1) si alguna capability del contrato no aparece ejercitada en ninguno de
// ellos. Antes de este script, "tiene contract test" era una observación humana al
// revisar caso por caso; ahora es un gate real que CI corre en cada push/PR (ver
// `.github/workflows/ci.yml`) -- lo más cercano a "antes de cada release" que este
// repo tiene hoy (no existe todavía un pipeline de release separado de CI, ver
// docs/runbooks/despliegue.md: el usuario decide cuándo publicar).
//
// Cómo se define "capability declarada": cada método de la interfaz del puerto
// (`PmsPort`/`PaymentProviderPort`/`CfdiPort`, en `packages/mcp-servers/*/src/port.ts`)
// -- es decir, la firma pública que CUALQUIER adaptador de ese conector debe cumplir.
// `status()` cuenta también: es parte del contrato (declaración honesta de
// disponibilidad, ver ADR-007), no un detalle interno.
//
// Cómo se define "tiene contract test correspondiente": al menos uno de los archivos
// de prueba declarados como evidencia de ese conector (`contractTestFiles`, abajo)
// contiene una referencia `.nombreDeLaCapability` -- verificación estática por texto
// (mismo nivel de rigor que `scripts/checks/registro-unico-conectores.ts`), no
// ejecución real de la suite (eso ya lo hace `npm test`; este script es la capa de
// "¿la suite existente en verde REALMENTE toca cada capability, o hay una que nadie
// prueba y nadie lo notó?").
//
// La lista de `contractTestFiles` por conector es explícita (mismo patrón que
// `requiredTests` en `scripts/checks/gate-por-tarea.ts`) en vez de un glob automático:
// un glob demasiado amplio escondería el hallazgo real (un archivo cualquiera bajo
// `tests/` que mencione la palabra "charge" por casualidad no es evidencia de contract
// test). Si se agrega un archivo de contract test nuevo para un conector ya existente,
// hay que sumarlo aquí -- el propio script no puede saber cuál archivo nuevo pretende
// ser evidencia y cuál no.
//
// Uso: `node scripts/checks/registro-conectores-pms.ts` -- sale con código 1 e imprime
// cada hallazgo bloqueante (capability sin contract test, o archivo de evidencia
// declarado que ya no existe) si encuentra alguno.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

export interface ConnectorAuditSpec {
  id: string;
  label: string;
  /** Ruta al archivo que declara la interfaz del puerto, relativa a `relativeTo`. */
  portFile: string;
  /** Nombre de la interfaz TypeScript del puerto dentro de `portFile`. */
  interfaceName: string;
  /** Archivos de prueba reconocidos como evidencia de contract test de este conector. */
  contractTestFiles: string[];
}

export interface CapabilityFinding {
  connectorId: string;
  connectorLabel: string;
  /** Nombre de la capability, o "(archivo de contract test declarado)" para el
   *  hallazgo de "el archivo de evidencia ya no existe". */
  capability: string;
  /** Siempre `true` hoy -- todo hallazgo de este script es bloqueante (criterio de
   *  aceptación literal de REQ-QA-010: "capability sin contract test → hallazgo
   *  bloqueante"). Se deja explícito por si en el futuro se agrega un hallazgo
   *  informativo no bloqueante. */
  blocking: boolean;
  message: string;
}

// Registro real de conectores auditados hoy (PMS/pago/CFDI, los 3 que REQ-QA-010
// nombra explícitamente). `status: "real"` refleja el estado REAL de este repo, nunca
// aspiracional -- mismo espíritu que `PMS_CONNECTOR_REGISTRY` de
// `packages/mcp-servers/pms/src/registry.ts`.
export const DEFAULT_CONNECTOR_SPECS: readonly ConnectorAuditSpec[] = [
  {
    id: "pms",
    label: "conector PMS (PmsPort)",
    portFile: "packages/mcp-servers/pms/src/port.ts",
    interfaceName: "PmsPort",
    contractTestFiles: [
      "tests/unit/mcp-servers/pms/contract.spec.ts",
      // listRatePlans/getGuestProfile se prueban aquí, no en contract.spec.ts --
      // sigue siendo contract test real (contra FakeCloudbedsAdapter, fixtures de la
      // forma pública documentada de Cloudbeds), solo que vive junto al simulador.
      "tests/unit/mcp-servers/pms/cloudbeds-adapter-simulator.spec.ts",
      // Suite compartida de REQ-QA-003 (gate `connector`): contrato + idempotencia +
      // conflicto 409 contra PmsPort real (vía FakeCloudbedsAdapter).
      "tests/integration/contracts/gate-connector.spec.ts",
    ],
  },
  {
    id: "pago",
    label: "conector de pago (PaymentProviderPort)",
    portFile: "packages/mcp-servers/payments/src/port.ts",
    interfaceName: "PaymentProviderPort",
    contractTestFiles: [
      // REQ-INT-002: misma suite de contrato contra 2 adaptadores (Stripe/Conekta).
      "tests/unit/mcp-servers/payments/adapter-swap.spec.ts",
      "tests/integration/contracts/payments/stripe-adapter.spec.ts",
      "tests/integration/contracts/payments/conekta-adapter.spec.ts",
    ],
  },
  {
    id: "cfdi",
    label: "conector de CFDI (CfdiPort)",
    portFile: "packages/mcp-servers/cfdi/src/port.ts",
    interfaceName: "CfdiPort",
    contractTestFiles: [
      // REQ-INT-005: 2 PAC intercambiables (Finkok/SW) contra el mismo contrato.
      "tests/unit/mcp-servers/cfdi/pac-doble.spec.ts",
      "tests/integration/contracts/cfdi/hospedaje.spec.ts",
    ],
  },
] as const;

/**
 * Extrae el cuerpo textual de `interface <interfaceName> { ... }` de `source`, por
 * conteo de llaves (no un parser TS completo -- suficiente para los `port.ts` reales,
 * que no anidan tipos objeto `{}` dentro de la firma de sus métodos). Lanza si no
 * encuentra la interfaz -- un contrato ausente/renombrado es en sí mismo un hallazgo
 * que este script debe hacer ruidoso, nunca pasar en silencio con 0 capabilities.
 */
export function extractInterfaceBody(source: string, interfaceName: string): string {
  const headerPattern = new RegExp(`interface\\s+${interfaceName}\\b[^{]*\\{`);
  const headerMatch = headerPattern.exec(source);
  if (!headerMatch) {
    throw new Error(`no se encontró \`interface ${interfaceName}\` en el archivo de puerto.`);
  }
  let depth = 1;
  let i = headerMatch.index + headerMatch[0].length;
  const start = i;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  if (depth !== 0) {
    throw new Error(`\`interface ${interfaceName}\` no cierra correctamente (llaves desbalanceadas).`);
  }
  return source.slice(start, i - 1);
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

/** Nombre de método al inicio de una línea de declaración (`nombre(args): Tipo;`),
 *  ignorando líneas de comentario/JSDoc y propiedades sin paréntesis (p.ej.
 *  `readonly foo: string;` no es una capability invocable). */
const METHOD_DECLARATION = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

export function extractCapabilities(source: string, interfaceName: string): string[] {
  const body = extractInterfaceBody(source, interfaceName);
  const capabilities: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of body.split("\n")) {
    if (isCommentLine(rawLine)) continue;
    const match = METHOD_DECLARATION.exec(rawLine.trim());
    if (!match) continue;
    const name = match[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    capabilities.push(name);
  }
  return capabilities;
}

/** Audita un solo conector: lee su puerto (capabilities declaradas) y sus archivos de
 *  contract test declarados, y retorna un hallazgo bloqueante por cada capability sin
 *  ninguna referencia `.capability` en esos archivos, más un hallazgo por cada archivo
 *  de evidencia declarado que ya no existe en disco. Solo lectura -- nunca escribe. */
export function auditConnector(spec: ConnectorAuditSpec, relativeTo: string = ROOT): CapabilityFinding[] {
  const portPath = join(relativeTo, spec.portFile);
  if (!existsSync(portPath)) {
    return [
      {
        connectorId: spec.id,
        connectorLabel: spec.label,
        capability: "(archivo de puerto)",
        blocking: true,
        message: `${spec.label}: no existe ${spec.portFile} -- ¿se movió o renombró el puerto? Actualiza DEFAULT_CONNECTOR_SPECS.`,
      },
    ];
  }
  const portSource = readFileSync(portPath, "utf8");
  const capabilities = extractCapabilities(portSource, spec.interfaceName);

  const testFiles = spec.contractTestFiles.map((relPath) => {
    const full = join(relativeTo, relPath);
    const exists = existsSync(full);
    return { relPath, exists, source: exists ? readFileSync(full, "utf8") : "" };
  });

  const findings: CapabilityFinding[] = [];

  for (const testFile of testFiles) {
    if (!testFile.exists) {
      findings.push({
        connectorId: spec.id,
        connectorLabel: spec.label,
        capability: "(archivo de contract test declarado)",
        blocking: true,
        message: `${spec.label}: el archivo de contract test declarado \`${testFile.relPath}\` no existe -- la evidencia quedó desactualizada (actualiza DEFAULT_CONNECTOR_SPECS o restaura el archivo).`,
      });
    }
  }

  for (const capability of capabilities) {
    const pattern = new RegExp(`\\.${capability}\\b`);
    const covered = testFiles.some((t) => t.exists && pattern.test(t.source));
    if (!covered) {
      findings.push({
        connectorId: spec.id,
        connectorLabel: spec.label,
        capability,
        blocking: true,
        message:
          `${spec.label}: la capability \`${capability}\` (declarada en \`${spec.interfaceName}\`, ` +
          `${spec.portFile}) no tiene contract test correspondiente -- ninguno de sus archivos de ` +
          `evidencia (${spec.contractTestFiles.join(", ")}) la ejercita.`,
      });
    }
  }

  return findings;
}

export function auditAllConnectors(
  specs: readonly ConnectorAuditSpec[] = DEFAULT_CONNECTOR_SPECS,
  relativeTo: string = ROOT,
): CapabilityFinding[] {
  return specs.flatMap((spec) => auditConnector(spec, relativeTo));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const findings = auditAllConnectors();

  if (findings.length > 0) {
    console.error(`REQ-QA-010: ${findings.length} hallazgo(s) bloqueante(s) en la auditoría de contract test por capability:`);
    for (const f of findings) {
      console.error(`  [${f.connectorId}] ${f.capability}: ${f.message}`);
    }
    process.exit(1);
  }

  const totalCapabilities = DEFAULT_CONNECTOR_SPECS.reduce((acc, spec) => {
    const portSource = readFileSync(join(ROOT, spec.portFile), "utf8");
    return acc + extractCapabilities(portSource, spec.interfaceName).length;
  }, 0);
  console.log(
    `REQ-QA-010 OK: ${DEFAULT_CONNECTOR_SPECS.length} conector(es) auditado(s) (${DEFAULT_CONNECTOR_SPECS.map((s) => s.id).join(", ")}), ` +
      `${totalCapabilities} capability(ies) declarada(s) en total, todas con contract test correspondiente.`,
  );
  process.exit(0);
}
