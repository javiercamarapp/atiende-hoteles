#!/usr/bin/env node
// REQ-AGT-019 (BP-132, BP-133, BP-134, BP-135, GOB-048) · revisión estática: "Cada
// tarea del backlog que module archivos de agentes/precios/dinero/control físico lleva
// un `gate` (`connector`,`money`,`physical`,`none`) verificado automáticamente antes de
// mergear (contract tests, prueba de determinismo de precio, laboratorio físico según
// el gate)."
//
// Una tarea es un archivo Markdown con frontmatter bajo `tasks/**` (GOB-045: "una tarea
// = un archivo desde plantilla"; ver `packages/agent-core/src/backlog/backlogStateMachine.ts`
// para la máquina de estados completa -- este check NO depende de ese módulo, se
// mantiene autocontenido para no arriesgar su cobertura ya probada). Cada tarea declara
// `gate` (GOB-048) y, si toca archivos sensibles, `paths` (GOB-005: "los paths/scope
// declarados en la tarea") -- lista separada por comas de rutas relativas al repo que
// la tarea modifica.
//
// REQ-QA-003 (BP-133): para las categorías de gate `connector` que son conectores
// externos reales (PMS/WhatsApp), el catálogo de abajo exige ADEMÁS
// `tests/integration/contracts/gate-connector.spec.ts` -- la suite que verifica
// literalmente las 3 pruebas del criterio (contrato contra fixture/sandbox,
// idempotencia de 2 webhooks iguales, conflicto 409) antes de mergear.
//
// Este check cruza esos `paths` contra un catálogo de categorías sensibles
// (agentes/precios/dinero/control físico -> gate connector/money/physical) y exige:
//   1. Toda tarea declara un `gate` válido del catálogo cerrado.
//   2. Si los `paths` de la tarea caen en una categoría sensible, el `gate` declarado
//      debe coincidir con la categoría (nunca `none` para un archivo de dinero/control
//      físico, nunca un gate que no sea el que la categoría exige).
//   3. Para el gate declarado, TODOS los archivos de prueba correspondientes
//      (contract test / prueba de determinismo de precio / laboratorio físico
//      simulado) deben existir en el repo -- si falta uno, la tarea queda bloqueada:
//      "PR con gate `money` sin la prueba correspondiente -> CI bloquea el merge"
//      (escenario verificado literalmente en ACEPTACION.md).
//
// Si `tasks/` no existe o no contiene tareas (el backlog de archivos de GOB-045 aún no
// se materializó en este repo -- ver `docs/PROGRESO.md`/`docs/BLOQUEOS.md`, que siguen
// siendo el proceso real hoy), el check no tiene nada que verificar y pasa en verde:
// esto NO es lo mismo que "0 violaciones porque se buscó mal" (las pruebas unitarias de
// este script sí ejercitan la lógica real contra tareas sintéticas, ver
// `tests/unit/gob/gate-por-tarea.spec.ts`).
//
// Uso: `node scripts/checks/gate-por-tarea.ts` -- sale con código 1 si encuentra una
// violación, imprimiendo archivo y motivo.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DEFAULT_TASKS_DIR = join(ROOT, "tasks");

export const VALID_GATES = ["none", "connector", "money", "physical"] as const;
export type Gate = (typeof VALID_GATES)[number];

/** Una categoría de archivo sensible (GOB-048/REQ-AGT-019): qué patrón de ruta la
 *  identifica, qué gate exige, y qué prueba(s) automatizada(s) TODAS deben existir en
 *  el repo para que ese gate se considere "verificado" antes de mergear. */
export interface CategoryRule {
  id: string;
  label: string;
  gate: Gate;
  pattern: RegExp;
  requiredTests: string[];
}

// Catálogo real del repo -- cada entrada mapea una carpeta/archivo sensible ya
// existente (agentes/precios/dinero/control físico) a su prueba de verificación real
// (nunca un mock: contract test contra el adaptador simulado real, o la prueba de
// determinismo de precio real de REQ-RES-002/REQ-AGT-004).
export const DEFAULT_CATEGORY_RULES: CategoryRule[] = [
  // --- agentes -> gate connector ---------------------------------------------------
  {
    id: "connector-pms",
    label: "agentes: conector PMS",
    gate: "connector",
    pattern: /^packages\/mcp-servers\/pms\//,
    // REQ-QA-003: además del contract test propio del paquete, TODA tarea de gate
    // `connector` sobre un conector externo (PMS/WhatsApp) exige la suite compartida
    // que verifica las 3 pruebas del criterio -- contrato contra fixture/sandbox,
    // idempotencia (2 webhooks iguales -> 1 efecto) y conflicto 409 -- antes de mergear.
    requiredTests: [
      "tests/unit/mcp-servers/pms/contract.spec.ts",
      "tests/integration/contracts/gate-connector.spec.ts",
    ],
  },
  {
    id: "connector-whatsapp",
    label: "agentes: conector WhatsApp",
    gate: "connector",
    pattern: /^packages\/mcp-servers\/whatsapp\//,
    // REQ-QA-003: ver nota en "connector-pms" -- misma suite compartida.
    requiredTests: [
      "tests/unit/mcp-servers/whatsapp/contract.spec.ts",
      "tests/integration/contracts/gate-connector.spec.ts",
    ],
  },
  {
    id: "connector-agent-core-tools",
    label: "agentes: herramientas de agent-core",
    gate: "connector",
    pattern: /^packages\/agent-core\/src\/(tool\.ts|tools\/)/,
    requiredTests: ["tests/unit/agent-core/tool.spec.ts"],
  },
  {
    id: "connector-api-agentes",
    label: "agentes: catálogo/rutas de agentes de la API",
    gate: "connector",
    pattern: /^apps\/api\/src\/(lib\/agentTools\.ts|routes\/agentes\.ts)/,
    requiredTests: ["tests/integration/api/agentes.spec.ts"],
  },
  // --- control físico -> gate physical ---------------------------------------------
  {
    id: "physical-locks",
    label: "control físico: cerraduras (LockPort)",
    gate: "physical",
    pattern: /^packages\/mcp-servers\/locks\//,
    requiredTests: ["tests/unit/mcp-servers/locks/contract.spec.ts"],
  },
  {
    id: "physical-energy",
    label: "control físico: energía/HVAC (EnergyPort)",
    gate: "physical",
    pattern: /^packages\/mcp-servers\/energy\//,
    requiredTests: ["tests/unit/mcp-servers/energy/contract.spec.ts"],
  },
  // --- precios/dinero -> gate money -------------------------------------------------
  {
    id: "money-payments",
    label: "dinero: pasarela de pagos (PaymentsPort)",
    gate: "money",
    pattern: /^packages\/mcp-servers\/payments\//,
    requiredTests: ["tests/unit/mcp-servers/payments/adapter-swap.spec.ts"],
  },
  {
    id: "money-cfdi",
    label: "dinero: facturación CFDI",
    gate: "money",
    pattern: /^packages\/mcp-servers\/cfdi\//,
    requiredTests: ["tests/integration/contracts/cfdi/hospedaje.spec.ts"],
  },
  {
    id: "money-pricing-quote",
    label: "precios: cotización/tarifa del huésped (determinismo REQ-RES-002)",
    gate: "money",
    pattern: /^packages\/domain-hotel\/src\/quote\.ts/,
    requiredTests: ["tests/unit/domain-hotel/pricing-source.spec.ts"],
  },
  {
    id: "money-agent-pricing",
    label: "dinero: tabla de costo por acción de agente",
    gate: "money",
    pattern: /^packages\/agent-core\/src\/pricing\.ts/,
    requiredTests: ["tests/unit/agent-core/pricing.spec.ts"],
  },
];

export interface BacklogTaskFile {
  file: string;
  id: string | null;
  gate: string | null;
  paths: string[];
}

export interface GateViolation {
  file: string;
  taskId: string;
  message: string;
}

function walkTaskFiles(dir: string, files: string[] = []): string[] {
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
      walkTaskFiles(full, files);
    } else if (entry.endsWith(".md") && entry !== "_template.md") {
      files.push(full);
    }
  }
  return files;
}

/** Parseo mínimo del frontmatter de una tarea (mismo formato plano `clave: valor` que
 *  `backlogStateMachine.ts` usa, ver GOB-045) -- solo lee los 3 campos que este check
 *  necesita (`id`, `gate`, `paths`); ignora el resto de la plantilla a propósito. */
export function parseTaskFrontmatter(content: string): { id: string | null; gate: string | null; paths: string[] } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { id: null, gate: null, paths: [] };

  const raw: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const paths = (raw.paths ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return { id: raw.id ?? null, gate: raw.gate ?? null, paths };
}

function normalizePath(p: string): string {
  // Las rutas declaradas pueden venir con separadores de plataforma o con "./" al
  // frente; se normalizan a POSIX relativo-al-repo para que el `pattern` (siempre
  // escrito en POSIX en DEFAULT_CATEGORY_RULES) las reconozca sin importar el SO.
  return p.replace(/^\.\//, "").split(sep).join("/");
}

/** `tasksDir`/`relativeTo`/`rules` son inyectables SOLO para pruebas (mismo patrón que
 *  `scripts/checks/no-comandos-destructivos-agente.ts`) -- el uso real (CLI) siempre
 *  escanea `tasks/` en la raíz del repo real contra el catálogo real de arriba. */
export function checkGatePorTarea(
  tasksDir: string = DEFAULT_TASKS_DIR,
  relativeTo: string = ROOT,
  rules: CategoryRule[] = DEFAULT_CATEGORY_RULES,
): GateViolation[] {
  const violations: GateViolation[] = [];

  for (const filePath of walkTaskFiles(tasksDir)) {
    const relFile = relative(relativeTo, filePath);
    const content = readFileSync(filePath, "utf8");
    const { id, gate, paths } = parseTaskFrontmatter(content);
    const taskId = id ?? relFile;

    if (id === null) {
      violations.push({ file: relFile, taskId, message: "la tarea no declara `id` en su frontmatter." });
    }

    if (gate === null) {
      violations.push({
        file: relFile,
        taskId,
        message: "la tarea no lleva `gate` declarado (debe ser uno de: " + VALID_GATES.join(", ") + ").",
      });
      continue; // sin gate válido no hay nada más que cruzar para esta tarea.
    }

    if (!(VALID_GATES as readonly string[]).includes(gate)) {
      violations.push({
        file: relFile,
        taskId,
        message: `gate_invalido: "${gate}" no es uno de ${VALID_GATES.join(", ")}.`,
      });
      continue;
    }

    const declaredGate = gate as Gate;
    const normalizedPaths = paths.map(normalizePath);
    const matched = rules.filter((rule) => normalizedPaths.some((p) => rule.pattern.test(p)));
    const impliedGates = new Set(matched.map((r) => r.gate));

    if (impliedGates.size > 1) {
      violations.push({
        file: relFile,
        taskId,
        message:
          `los \`paths\` de la tarea mezclan más de una categoría sensible (implica gates: ${[...impliedGates].sort().join(", ")}); ` +
          "una tarea debe limitarse a un solo gate -- divídela.",
      });
      continue;
    }

    if (impliedGates.size === 1) {
      const [impliedGate] = impliedGates;
      if (declaredGate !== impliedGate) {
        const categorias = matched.map((r) => r.label).join("; ");
        violations.push({
          file: relFile,
          taskId,
          message: `gate declarado "${declaredGate}" no coincide con lo que sus \`paths\` tocan (categoría: ${categorias} -> exige gate "${impliedGate}").`,
        });
        continue;
      }

      for (const rule of matched) {
        for (const requiredTest of rule.requiredTests) {
          if (!existsSync(join(relativeTo, requiredTest))) {
            violations.push({
              file: relFile,
              taskId,
              message: `gate "${declaredGate}" declarado (categoría: ${rule.label}) pero falta la prueba correspondiente: ${requiredTest}`,
            });
          }
        }
      }
    }
    // impliedGates.size === 0: los paths declarados no tocan ninguna categoría
    // sensible del catálogo -- cualquier gate (incluido "none") es válido, nada que
    // exigir.
  }

  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const taskFilesFound = walkTaskFiles(DEFAULT_TASKS_DIR).length;
  const violations = checkGatePorTarea();

  if (violations.length > 0) {
    console.error(`REQ-AGT-019: ${violations.length} tarea(s) con problema de gate:`);
    for (const v of violations) {
      console.error(`  ${v.file} [${v.taskId}]: ${v.message}`);
    }
    process.exit(1);
  }

  if (taskFilesFound === 0) {
    console.log(
      "REQ-AGT-019 OK: 0 archivos de tarea bajo tasks/ (el backlog de archivos de GOB-045 aún no se materializó en " +
        "este repo -- docs/PROGRESO.md/docs/BLOQUEOS.md siguen siendo el proceso real hoy) -- nada que verificar.",
    );
  } else {
    console.log(
      `REQ-AGT-019 OK: ${taskFilesFound} tarea(s) revisada(s) bajo tasks/ -- gate declarado y válido en todas, y ` +
        "la(s) prueba(s) correspondiente(s) (contract test / determinismo de precio / laboratorio físico) presente(s) " +
        "para toda tarea cuyos `paths` tocan agentes/precios/dinero/control físico.",
    );
  }
  process.exit(0);
}
