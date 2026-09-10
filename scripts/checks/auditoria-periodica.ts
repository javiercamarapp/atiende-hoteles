#!/usr/bin/env node
// REQ-OBS-003 (GOB-009, BP-142/BP-143) · operativa: "El sistema debe ejecutar una
// auditoría periódica automatizada cada N tareas cerradas del backlog (checklist del
// blueprint) y escribir el veredicto en un documento fechado; un veredicto rojo detiene
// el loop de construcción hasta resolución."
//
// GOB-009 fija N=8 ("cada 8 tareas cerradas") -- constante única en
// `packages/agent-core/src/backlog/backlogStateMachine.ts`
// (`PERIODIC_AUDIT_INTERVAL_TASKS`), que este script importa en vez de duplicar. Ese
// módulo también trae la parte de dominio PURO (¿toca ronda?, ¿el veredicto bloquea el
// loop?, `selectNextTask` que lanza `BuildLoopBlockedByAuditError` antes de seleccionar
// nada) -- este archivo es el orquestador con I/O real:
//   1. Cuenta tareas `done` bajo `tasks/**` (GOB-045, mismo formato de frontmatter
//      plano que `gate-por-tarea.ts`/`evidencia-obligatoria-cierre.ts`).
//   2. Si ya existe un veredicto `rojo` sin resolver (de CUALQUIER ronda anterior), el
//      loop sigue bloqueado -- se reporta y se sale con código 1, sin importar si toca
//      una ronda nueva (GOB-009: "hasta resolución", no "hasta la próxima ronda").
//   3. Si no toca ronda nueva (`isPeriodicAuditDue` es falso) y no hay bloqueo previo,
//      no hay nada que hacer -- verde trivial.
//   4. Si toca ronda nueva, corre el checklist real (ver `CHECKLIST` más abajo), escribe
//      el veredicto fechado en `docs/auditoria-N/ronda-<n>.md` y sale con código 1 si
//      salió rojo (bloqueando el loop) o 0 si salió verde.
//
// "Checklist del blueprint": BP-143/REQ-OBS-004 enumeran 11 puntos específicos (fixtures
// ≤30 días, backtest de revenue, límites de WhatsApp, consent ledger, etc.) que
// requieren infraestructura que este repo todavía no tiene (motor de precios en
// producción, canal de WhatsApp real, ledger de consentimiento) -- automatizarlos sin
// esa infraestructura sería simular el requisito, no verificarlo (mismo criterio que
// `docs/cierre-p0/inventario.md` aplica en el resto del repo). Ese checklist de 11
// puntos es el alcance de REQ-OBS-004, NO de este requisito (REQ-OBS-003 solo exige que
// "una auditoría periódica" corra y escriba un veredicto). Lo que SÍ existe hoy, real y
// automatizable, es el catálogo de checks de gobierno/seguridad de `scripts/checks/`
// (gates ya wireados a CI: PAN/CVV, biometría, `skip` de pruebas, comandos
// destructivos, aislamiento pms_mirror/cerraduras, esquema `location`, conectores
// únicos, etc.) -- ese es el checklist real que esta ronda ejecuta (`discoverChecklist`,
// autodescubierto del directorio para no derivar en un catálogo desactualizado a mano).
//
// Por qué esto NO rompe CI hoy: `tasks/` no existe todavía en este repo (backlog de
// archivos de GOB-045 aún no materializado, ver `docs/PROGRESO.md`/`docs/BLOQUEOS.md`),
// así que el conteo de tareas cerradas es 0 y `isPeriodicAuditDue(0)` es `false` -- el
// checklist real (incluida cualquier violación pre-existente que alguno de sus ítems ya
// reporte hoy) NUNCA se ejecuta contra este repo hasta que el backlog de archivos exista
// de verdad y se cierren tareas. Las pruebas unitarias (`tests/unit/gob/auditoria-
// periodica.spec.ts`) SÍ ejercitan la ejecución real del checklist, con `tasksDir`/
// `auditDir`/`checklist`/`runItem` inyectables (mismo patrón de inyección que el resto
// de `scripts/checks/*.ts`) contra fixtures sintéticas, nunca contra el repo real.
//
// Uso:
//   node scripts/checks/auditoria-periodica.ts             -- corre el ciclo descrito
//                                                              arriba.
//   node scripts/checks/auditoria-periodica.ts --resolver <ronda>
//                                                           -- marca la ronda dada como
//                                                              resuelta (`resolved:
//                                                              true`) tras corregir la
//                                                              causa del rojo; el loop
//                                                              queda libre de nuevo.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  type AuditVerdict,
  isBuildLoopBlockedByAudit,
  isPeriodicAuditDue,
  PERIODIC_AUDIT_INTERVAL_TASKS,
  type PeriodicAuditRecord,
} from "../../packages/agent-core/src/backlog/backlogStateMachine.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DEFAULT_TASKS_DIR = join(ROOT, "tasks");
const DEFAULT_AUDIT_DIR = join(ROOT, "docs", "auditoria-N");
const CHECKS_DIR = join(ROOT, "scripts", "checks");
const SELF_FILENAME = basename(import.meta.url.replace(/^file:\/\//, ""));

// ---------------------------------------------------------------------------
// 1. Conteo de tareas cerradas bajo tasks/** (GOB-045: mismo parseo mínimo de
//    frontmatter plano `clave: valor` que el resto de scripts/checks/*.ts -- duplicado
//    a propósito, no importado, para no acoplar la cobertura de este check a la de los
//    demás, mismo razonamiento que ellos documentan).
// ---------------------------------------------------------------------------

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
    if (stat.isDirectory()) walkTaskFiles(full, files);
    else if (entry.endsWith(".md") && entry !== "_template.md") files.push(full);
  }
  return files;
}

function parseTaskStatus(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() === "status") return line.slice(idx + 1).trim();
  }
  return null;
}

/** Tareas `done` bajo `tasksDir` -- lo que GOB-009 cuenta como "tarea cerrada". */
export function contarTareasCerradas(tasksDir: string = DEFAULT_TASKS_DIR): number {
  return walkTaskFiles(tasksDir).filter((f) => parseTaskStatus(readFileSync(f, "utf8")) === "done").length;
}

// ---------------------------------------------------------------------------
// 2. El checklist real: un ítem por cada script de `scripts/checks/*.ts` (excepto este
//    mismo) -- autodescubierto para que agregar un check nuevo al repo lo sume
//    automáticamente al checklist periódico sin tener que mantener una lista aparte a
//    mano (que inevitablemente se desactualiza).
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  id: string;
  path: string;
}

export function discoverChecklist(checksDir: string = CHECKS_DIR): ChecklistItem[] {
  let entries: string[];
  try {
    entries = readdirSync(checksDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".ts") && f !== SELF_FILENAME)
    .sort()
    .map((f) => ({ id: f.replace(/\.ts$/, ""), path: join(checksDir, f) }));
}

export interface ChecklistItemResult {
  id: string;
  ok: boolean;
  exitCode: number;
  detail: string;
}

export type ChecklistRunner = (item: ChecklistItem) => ChecklistItemResult;

/** Corre un ítem del checklist como proceso `node` real (mismo binario/invocación que
 *  CI usa para estos mismos scripts, ver `.github/workflows/ci.yml`). Inyectable
 *  (`runItem`) para que las pruebas puedan sustituir esto por ítems sintéticos sin
 *  gastar ~15 procesos `node` reales por corrida de prueba. */
export function runChecklistItemReal(item: ChecklistItem): ChecklistItemResult {
  try {
    const output = execFileSync(process.execPath, [item.path], { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
    return { id: item.id, ok: true, exitCode: 0, detail: output.trim().split("\n").pop() ?? "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    const detail = (e.stderr || e.stdout || String(err)).trim().split("\n").pop() ?? "";
    return { id: item.id, ok: false, exitCode: e.status ?? 1, detail };
  }
}

export function computeVerdict(results: readonly ChecklistItemResult[]): AuditVerdict {
  return results.every((r) => r.ok) ? "verde" : "rojo";
}

// ---------------------------------------------------------------------------
// 3. El documento fechado del veredicto: `docs/auditoria-N/ronda-<n>.md`, frontmatter
//    plano (mismo formato que el resto del repo) + tabla del checklist ejecutado. Un
//    archivo por ronda (nombrado por número de ronda, no por fecha) para que
//    `--resolver <ronda>` pueda ubicarlo sin ambigüedad.
// ---------------------------------------------------------------------------

function rondaFilePath(round: number, auditDir: string): string {
  return join(auditDir, `ronda-${round}.md`);
}

function parseAuditRecord(content: string, documentPath: string): PeriodicAuditRecord | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const raw: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!raw.ronda || !raw.fecha || !raw.veredicto || !raw.resuelto || !raw.tareasCerradas) return null;
  if (raw.veredicto !== "verde" && raw.veredicto !== "rojo") return null;
  return {
    round: Number(raw.ronda),
    date: raw.fecha,
    closedTaskCount: Number(raw.tareasCerradas),
    verdict: raw.veredicto,
    resolved: raw.resuelto === "true",
    documentPath,
  };
}

function renderAuditDocument(
  record: Omit<PeriodicAuditRecord, "documentPath">,
  results: readonly ChecklistItemResult[],
): string {
  const fallidos = results.filter((r) => !r.ok);
  const veredictoSeccion =
    record.verdict === "rojo"
      ? `## Veredicto: ROJO\n\n${fallidos.length}/${results.length} ítem(s) del checklist fallaron. REQ-OBS-003/GOB-009 ` +
        `exige detener el loop de construcción hasta resolución -- no se toma ninguna tarea nueva del backlog ` +
        `mientras esta ronda siga sin marcarse resuelta (\`node scripts/checks/auditoria-periodica.ts --resolver ${record.round}\` ` +
        "una vez corregida la causa)."
      : `## Veredicto: VERDE\n\n${results.length}/${results.length} ítem(s) del checklist en verde. El loop de construcción continúa.`;

  return [
    "---",
    `ronda: ${record.round}`,
    `fecha: ${record.date}`,
    `tareasCerradas: ${record.closedTaskCount}`,
    `veredicto: ${record.verdict}`,
    `resuelto: ${record.resolved}`,
    "---",
    "",
    `# Auditoría periódica automatizada — ronda ${record.round} (${record.date})`,
    "",
    `REQ-OBS-003 (GOB-009): disparada al cerrarse la tarea número ${record.closedTaskCount} del backlog de ` +
      `archivos (\`tasks/**\`), intervalo de ${PERIODIC_AUDIT_INTERVAL_TASKS} tareas cerradas.`,
    "",
    `## Checklist ejecutado (${results.length} ítem(s), catálogo real de \`scripts/checks/\`)`,
    "",
    "| Ítem | Resultado | Detalle |",
    "|---|---|---|",
    ...results.map((r) => `| \`${r.id}\` | ${r.ok ? "verde" : "**ROJO**"} | ${(r.detail || `exit ${r.exitCode}`).replace(/\|/g, "\\|")} |`),
    "",
    veredictoSeccion,
    "",
  ].join("\n");
}

/** Último veredicto conocido (mayor `ronda`) bajo `auditDir`, o `null` si el directorio
 *  no existe o no contiene ningún documento de ronda válido -- primera ejecución real,
 *  nada que bloquee todavía. */
export function leerUltimoVeredicto(auditDir: string = DEFAULT_AUDIT_DIR): PeriodicAuditRecord | null {
  if (!existsSync(auditDir)) return null;
  const records: PeriodicAuditRecord[] = [];
  for (const entry of readdirSync(auditDir)) {
    if (!/^ronda-\d+\.md$/.test(entry)) continue;
    const full = join(auditDir, entry);
    const record = parseAuditRecord(readFileSync(full, "utf8"), relative(ROOT, full));
    if (record) records.push(record);
  }
  if (records.length === 0) return null;
  return records.sort((a, b) => b.round - a.round)[0]!;
}

/** Marca la ronda dada como resuelta (GOB-009: "hasta resolución") -- reescribe
 *  únicamente `resuelto: true` en su documento existente; el resto del veredicto
 *  (checklist ejecutado, ítems fallidos) queda intacto como registro histórico de qué
 *  pasó, nunca borrado. */
export function resolverRonda(round: number, auditDir: string = DEFAULT_AUDIT_DIR): PeriodicAuditRecord {
  const path = rondaFilePath(round, auditDir);
  if (!existsSync(path)) {
    throw new Error(`ronda_no_encontrada: no existe ningún veredicto para la ronda ${round} en ${relative(ROOT, auditDir)}/.`);
  }
  const record = parseAuditRecord(readFileSync(path, "utf8"), relative(ROOT, path));
  if (!record) throw new Error(`veredicto_invalido: ${relative(ROOT, path)} no tiene el frontmatter esperado.`);
  const updated = readFileSync(path, "utf8").replace(/\nresuelto: .*/, "\nresuelto: true");
  writeFileSync(path, updated, "utf8");
  return { ...record, resolved: true };
}

// ---------------------------------------------------------------------------
// 4. El ciclo completo -- inyectable de punta a punta para pruebas (mismo patrón que
//    `checkEvidenciaObligatoriaCierre`/`checkGatePorTarea`: `tasksDir`/`auditDir`
//    apuntan a directorios temporales en las pruebas, nunca al repo real).
// ---------------------------------------------------------------------------

export interface RunPeriodicAuditOptions {
  tasksDir?: string;
  auditDir?: string;
  checklist?: readonly ChecklistItem[];
  runItem?: ChecklistRunner;
  now?: () => Date;
}

export interface RunPeriodicAuditOutcome {
  /** `true` si esta llamada ejecutó el checklist y escribió un veredicto NUEVO. */
  ranNewRound: boolean;
  /** `true` si el loop de construcción debe considerarse bloqueado ahora mismo -- por
   *  un veredicto rojo recién producido, o por uno anterior que sigue sin resolverse. */
  blocked: boolean;
  message: string;
  audit: PeriodicAuditRecord | null;
}

export function runPeriodicAudit(opts: RunPeriodicAuditOptions = {}): RunPeriodicAuditOutcome {
  const tasksDir = opts.tasksDir ?? DEFAULT_TASKS_DIR;
  const auditDir = opts.auditDir ?? DEFAULT_AUDIT_DIR;
  const checklist = opts.checklist ?? discoverChecklist();
  const runItem = opts.runItem ?? runChecklistItemReal;
  const now = opts.now ?? (() => new Date());

  const closedTaskCount = contarTareasCerradas(tasksDir);
  const lastAudit = leerUltimoVeredicto(auditDir);

  // GOB-009: "hasta resolución" -- un rojo sin resolver bloquea sin importar si toca
  // ronda nueva.
  if (isBuildLoopBlockedByAudit(lastAudit) && lastAudit) {
    return {
      ranNewRound: false,
      blocked: true,
      audit: lastAudit,
      message:
        `REQ-OBS-003: loop de construcción BLOQUEADO -- la ronda ${lastAudit.round} (${lastAudit.date}) sigue en ` +
        `rojo sin resolver. Ver ${lastAudit.documentPath}. Resolver con: ` +
        `node scripts/checks/auditoria-periodica.ts --resolver ${lastAudit.round}`,
    };
  }

  if (!isPeriodicAuditDue(closedTaskCount)) {
    return {
      ranNewRound: false,
      blocked: false,
      audit: lastAudit,
      message:
        `REQ-OBS-003 OK: ${closedTaskCount} tarea(s) cerrada(s) bajo tasks/ -- la auditoría periódica corre cada ` +
        `${PERIODIC_AUDIT_INTERVAL_TASKS} (GOB-009); nada que ejecutar todavía.`,
    };
  }

  const round = closedTaskCount / PERIODIC_AUDIT_INTERVAL_TASKS;
  if (lastAudit && lastAudit.round >= round) {
    // Esta ronda ya se ejecutó (conteo repetido, p.ej. dos corridas del mismo estado del
    // backlog) -- no se re-corre el checklist, se reporta el veredicto ya existente.
    return {
      ranNewRound: false,
      blocked: false,
      audit: lastAudit,
      message: `REQ-OBS-003 OK: la ronda ${round} ya se ejecutó (${lastAudit.documentPath}), veredicto ${lastAudit.verdict}.`,
    };
  }

  const results = checklist.map(runItem);
  const verdict = computeVerdict(results);
  const date = now().toISOString().slice(0, 10);
  const record: Omit<PeriodicAuditRecord, "documentPath"> = {
    round,
    date,
    closedTaskCount,
    verdict,
    resolved: false,
  };

  mkdirSync(auditDir, { recursive: true });
  const path = rondaFilePath(round, auditDir);
  writeFileSync(path, renderAuditDocument(record, results), "utf8");
  const documentPath = relative(ROOT, path);

  return {
    ranNewRound: true,
    blocked: verdict === "rojo",
    audit: { ...record, documentPath },
    message:
      verdict === "rojo"
        ? `REQ-OBS-003: ronda ${round} -> veredicto ROJO (${results.filter((r) => !r.ok).length}/${results.length} ` +
          `ítem(s) fallidos). Documento: ${documentPath}. Loop de construcción bloqueado hasta resolución.`
        : `REQ-OBS-003 OK: ronda ${round} -> veredicto VERDE (${results.length}/${results.length} ítem(s) del ` +
          `checklist en verde). Documento: ${documentPath}.`,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const resolverIdx = args.indexOf("--resolver");

  if (resolverIdx !== -1) {
    const roundArg = args[resolverIdx + 1];
    const round = roundArg ? Number(roundArg) : NaN;
    if (!roundArg || Number.isNaN(round)) {
      console.error("Uso: node scripts/checks/auditoria-periodica.ts --resolver <ronda>");
      process.exit(1);
    }
    try {
      const resolved = resolverRonda(round);
      console.log(`REQ-OBS-003 OK: ronda ${resolved.round} marcada como resuelta (${resolved.documentPath}). Loop de construcción libre de nuevo.`);
      process.exit(0);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
  } else {
    const outcome = runPeriodicAudit();
    if (outcome.blocked) {
      console.error(outcome.message);
      process.exit(1);
    }
    console.log(outcome.message);
    process.exit(0);
  }
}
