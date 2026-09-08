#!/usr/bin/env node
// REQ-GOB-005 · revisión estática: "Tarea cerrada tiene verificación en verde con
// evidencia guardada; commit siguiendo Conventional Commits (uno por tarea); estado
// pasa a `review`; toda decisión de diseño no trivial genera un ADR (verificado con
// una tarea de muestra cerrada end-to-end)."
//
// Este check cubre específicamente la porción de ese criterio que NINGÚN otro check ya
// construido verifica: que el cierre de la tarea quede respaldado por EXACTAMENTE un
// commit real de git, y que ese commit siga el formato Conventional Commits
// (`tipo(scope opcional)!: descripción`, catálogo cerrado de tipos). El resto del
// criterio ya tiene dueño (ver ADR-012 de docs/ARQUITECTURA.md, que documenta esta
// división en 3 herramientas en vez de una sola, como decisión de diseño no trivial):
//   - "verificación en verde + evidencia guardada" -> REQ-OBS-010
//     (`scripts/checks/evidencia-obligatoria-cierre.ts`).
//   - "no se implementa sin criterio de aceptación verificable" (puerta previa a
//     `doing`) -> REQ-GOB-003 (`beginImplementation` en `backlogStateMachine.ts`).
//   - "toda decisión de diseño no trivial genera un ADR" -> proceso editorial sobre
//     `docs/ARQUITECTURA.md`, no verificable por revisión estática de texto libre (un
//     grep no distingue una decisión "trivial" de una que no lo es); se deja como
//     disciplina documentada (este mismo ADR-012 es un ejemplo real de cumplimiento).
//
// Una tarea es un archivo Markdown con frontmatter bajo `tasks/**` (mismo formato que
// `gate-por-tarea.ts`/`scope-de-tarea.ts`/`evidencia-obligatoria-cierre.ts` -- este
// check es autocontenido a propósito, mismo patrón: NO depende de esos módulos ni de
// `backlogStateMachine.ts`).
//
// "Cerrada" = tarea en `review` o `done` (mismo par de estados que REQ-OBS-010 exige
// evidencia -- razonamiento idéntico: `review` porque el cierre ya se presenta como
// hecho ANTES del commit que produce ese estado, `done` porque es el estado final que
// el criterio nombra).
//
// "Commit que la cierra" = un commit real de `git log` (alcanzable desde HEAD) cuyo
// asunto o cuerpo referencia el `id` de la tarea como palabra completa (nunca por
// subcadena cruda: "REQ-GOB-5" no debe emparejar "REQ-GOB-50"). "Uno por tarea": si 0
// commits la referencian, el cierre no tiene commit real detrás; si más de 1, no hay un
// commit único identificable como "el" commit de cierre (ambigüedad que el criterio no
// permite). Con exactamente 1, ese commit debe cumplir Conventional Commits.
//
// Si `tasks/` no existe o no contiene ninguna tarea en `review`/`done`, no hay nada que
// verificar y el check pasa en verde -- igual que sus hermanos (0 violaciones porque no
// hay tarea que cerrar, no porque se buscó mal; ver
// `tests/unit/gob/cierre-tarea-conventional-commits.spec.ts`, que ejercita la lógica
// real tanto con commits sintéticos inyectados como con un repositorio git real).
//
// Uso: `node scripts/checks/cierre-tarea-conventional-commits.ts` -- sale con código 1
// si encuentra una tarea cerrada sin exactamente un commit real de cierre en formato
// Conventional Commits, imprimiendo tarea y motivo.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DEFAULT_TASKS_DIR = join(ROOT, "tasks");

/** Estados que exigen un commit de cierre verificado (mismo par que REQ-OBS-010 exige
 *  evidencia -- ver razonamiento en el comentario de cabecera). */
const ESTADOS_QUE_EXIGEN_COMMIT = new Set(["review", "done"]);

/** Catálogo cerrado de tipos de Conventional Commits (conventionalcommits.org) --
 *  coincide con los tipos ya usados en el historial real de este repo (`feat`, `fix`,
 *  `test`, `docs`, `chore`, `ci`; el resto del catálogo estándar se admite igual). */
const CONVENTIONAL_COMMIT_TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"] as const;

/** `tipo(scope opcional)!: descripción no vacía` -- el `!` opcional marca un cambio
 *  incompatible (breaking change), parte del estándar. El `scope`, si aparece, es un
 *  identificador simple (letras/dígitos/`. _ / -`), nunca vacío entre paréntesis. */
const CONVENTIONAL_COMMIT_RE = new RegExp(`^(${CONVENTIONAL_COMMIT_TYPES.join("|")})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: .+`);

export interface CierreTaskFile {
  file: string;
  id: string | null;
  status: string | null;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
}

export interface CierreViolation {
  taskFile: string;
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
 *  el resto de los checks de `tasks/**`) -- solo lee `id` y `status`. */
export function parseTaskFrontmatterConCierre(content: string): { id: string | null; status: string | null } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { id: null, status: null };

  const raw: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  return { id: raw.id ?? null, status: raw.status ?? null };
}

/** ¿`subject` cumple Conventional Commits? Se valida SOLO el asunto (primera línea) --
 *  el estándar no exige nada del cuerpo, y el historial real de este repo (`git log
 *  --oneline`) confirma que el asunto es donde vive el `tipo(scope): descripción`. */
export function esConventionalCommit(subject: string): boolean {
  return CONVENTIONAL_COMMIT_RE.test(subject);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** ¿`commit` referencia `taskId` como palabra completa (en el asunto o en el cuerpo)?
 *  Límite de palabra real (nunca subcadena cruda): "REQ-GOB-5" NO empareja
 *  "REQ-GOB-50" ni "REQ-GOB-5A"; sí empareja "cierra REQ-GOB-5 -- ..." o
 *  "(REQ-GOB-5)". Insensible a mayúsculas (el historial real mezcla
 *  `REQ-AGT-013`/`req-agt-013`, ver `git log --oneline`). */
export function commitReferenciaTarea(commit: CommitInfo, taskId: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(taskId)}([^A-Za-z0-9_]|$)`, "i");
  return re.test(commit.subject) || re.test(commit.body);
}

/** Lee el historial real de git en `repoRoot` (alcanzable desde HEAD): hash, asunto y
 *  cuerpo de cada commit, vía `execFileSync` -- nunca un mock del historial. Usa
 *  separadores de control (`\x1e` entre commits, `\x1f` entre campos) porque un asunto o
 *  cuerpo de commit real nunca los contiene, a diferencia de un delimitador visible
 *  como `|`. */
export function obtenerCommitsGitReal(repoRoot: string = ROOT): CommitInfo[] {
  const RS = "\x1e";
  const FS = "\x1f";
  const opts: { cwd: string; encoding: BufferEncoding; stdio: ["ignore", "pipe", "pipe"] } = {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  let raw: string;
  try {
    raw = execFileSync("git", ["log", `--pretty=format:%H${FS}%s${FS}%b${RS}`], opts);
  } catch {
    // Sin commits todavía (repo recién creado) -- git log falla en vez de devolver
    // vacío; se trata igual que "sin historial".
    return [];
  }
  return raw
    .split(RS)
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.trim().length > 0)
    .map((rec) => {
      const [hash = "", subject = "", body = ""] = rec.split(FS);
      return { hash, subject, body };
    });
}

/** Todos los commits de `commits` que referencian `taskId`. */
export function commitsDeCierre(taskId: string, commits: readonly CommitInfo[]): CommitInfo[] {
  return commits.filter((c) => commitReferenciaTarea(c, taskId));
}

/** `tasksDir`/`relativeTo`/`getCommits` son inyectables SOLO para pruebas (mismo patrón
 *  que `checkScopeDeTarea`/`checkEvidenciaObligatoriaCierre`) -- el uso real (CLI)
 *  siempre escanea `tasks/` y el historial real de git de la raíz del repo real. */
export function checkCierreTareaConventionalCommits(
  tasksDir: string = DEFAULT_TASKS_DIR,
  relativeTo: string = ROOT,
  getCommits: () => CommitInfo[] = () => obtenerCommitsGitReal(relativeTo),
): CierreViolation[] {
  const closedTasks: (CierreTaskFile & { file: string })[] = [];
  for (const filePath of walkTaskFiles(tasksDir)) {
    const relFile = relative(relativeTo, filePath);
    const content = readFileSync(filePath, "utf8");
    const { id, status } = parseTaskFrontmatterConCierre(content);
    if (status !== null && ESTADOS_QUE_EXIGEN_COMMIT.has(status)) {
      closedTasks.push({ file: relFile, id, status });
    }
  }

  if (closedTasks.length === 0) return [];

  const violations: CierreViolation[] = [];
  const commits = getCommits();

  for (const task of closedTasks) {
    if (task.id === null) {
      violations.push({
        taskFile: task.file,
        taskId: task.file,
        message: `la tarea está en \`${task.status}\` (cierre exige commit verificado) pero no declara \`id\` en su frontmatter -- no hay identificador contra el cual buscar el commit de cierre.`,
      });
      continue;
    }

    const matching = commitsDeCierre(task.id, commits);

    if (matching.length === 0) {
      violations.push({
        taskFile: task.file,
        taskId: task.id,
        message: `la tarea está en \`${task.status}\` pero 0 commits de \`git log\` referencian \`${task.id}\` -- cierre sin commit real detrás.`,
      });
      continue;
    }

    if (matching.length > 1) {
      const hashes = matching.map((c) => c.hash.slice(0, 7)).join(", ");
      violations.push({
        taskFile: task.file,
        taskId: task.id,
        message: `${matching.length} commits referencian \`${task.id}\` (${hashes}) -- se exige exactamente uno por tarea, no hay un commit de cierre identificable sin ambigüedad.`,
      });
      continue;
    }

    const [commit] = matching;
    if (!esConventionalCommit(commit!.subject)) {
      violations.push({
        taskFile: task.file,
        taskId: task.id,
        message: `el commit de cierre ${commit!.hash.slice(0, 7)} ("${commit!.subject}") no sigue Conventional Commits (se exige \`${CONVENTIONAL_COMMIT_TYPES.join("|")}\`(scope opcional)\`!\`?: descripción\`).`,
      });
    }
  }

  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const taskFilesFound = walkTaskFiles(DEFAULT_TASKS_DIR).length;
  const violations = checkCierreTareaConventionalCommits();

  if (violations.length > 0) {
    console.error(`REQ-GOB-005: ${violations.length} tarea(s) cerrada(s) sin commit de cierre válido:`);
    for (const v of violations) {
      console.error(`  ${v.taskFile} [${v.taskId}]: ${v.message}`);
    }
    process.exit(1);
  }

  if (taskFilesFound === 0) {
    console.log(
      "REQ-GOB-005 OK: 0 archivos de tarea bajo tasks/ (el backlog de archivos de GOB-045 aún no se materializó en " +
        "este repo -- docs/PROGRESO.md/docs/BLOQUEOS.md siguen siendo el proceso real hoy) -- nada que verificar.",
    );
  } else {
    console.log(
      `REQ-GOB-005 OK: ${taskFilesFound} tarea(s) revisada(s) bajo tasks/ -- ninguna tarea \`review\`/\`done\` sin ` +
        "exactamente un commit real de `git log` en formato Conventional Commits referenciando su `id`.",
    );
  }
  process.exit(0);
}
