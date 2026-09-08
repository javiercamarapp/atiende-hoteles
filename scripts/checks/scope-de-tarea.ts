#!/usr/bin/env node
// REQ-GOB-004 (GOB-005) · revisión estática: "El agente implementa SOLO la tarea
// asignada; no toca archivos fuera del `scope` declarado de la tarea. Test de diff: el
// diff de la tarea contiene únicamente archivos dentro de los `paths`/`scope`
// declarados en la tarea; cualquier archivo fuera de scope hace fallar la revisión."
//
// Una tarea es un archivo Markdown con frontmatter bajo `tasks/**` (mismo formato que
// `scripts/checks/gate-por-tarea.ts` -- este check NO depende de ese módulo ni de
// `backlogStateMachine.ts`, se mantiene autocontenido a propósito, mismo patrón que
// `gate-por-tarea.ts`). Cada tarea declara `id`, `status` y, si ya tiene código escrito,
// `paths` (GOB-005) -- lista separada por comas de rutas relativas al repo que la tarea
// tiene permitido tocar.
//
// "El diff de una tarea cerrada" (ACEPTACION.md): se revisan las tareas en `doing` o
// `review` -- `doing` es la tarea activa (trabajo en curso, aún sin commit); `review` es
// una tarea que el agente acaba de cerrar (REQ-GOB-005: verificación en verde +
// evidencia + commit + `status: review`, en ese orden) pero cuyo cambio de estado
// todavía puede estar sin commitear en el momento exacto en que este check corre como
// último gate antes de cerrar -- por eso se revisan ambos estados contra el MISMO diff
// real de git (working tree vs. `HEAD`, tracked + archivos nuevos sin trackear). Una
// tarea en `done` ya tiene su commit hecho: su diff es historia pasada, fuera del
// alcance de este check en tiempo real (auditar retroactivamente commits ya fusionados
// es trabajo de `scripts/checks/cierre-tarea-conventional-commits.ts`, REQ-GOB-005,
// pendiente). `draft`/`ready`/`blocked`/`needs-human` no tienen código en curso que
// revisar.
//
// Sin excepciones implícitas: el propio archivo de la tarea (`tasks/<id>.md`) NO se
// exime de la verificación de scope solo por ser la tarea -- si una tarea necesita
// actualizar su propio frontmatter como parte del cierre, debe declararlo en sus
// `paths` igual que cualquier otro archivo (evita que "scope declarado" tenga una
// excepción tácita no verificada).
//
// Si `tasks/` no existe, o no contiene ninguna tarea en `doing`/`review`, no hay nada
// que verificar y el check pasa en verde -- igual que `gate-por-tarea.ts` (0
// violaciones porque no hay tarea abierta, no porque se buscó mal; ver
// `tests/unit/gob/scope-de-tarea.spec.ts`, que ejercita la lógica real tanto con tareas
// sintéticas + diff inyectado como con un repositorio git real de prueba).
//
// Uso: `node scripts/checks/scope-de-tarea.ts` -- sale con código 1 si encuentra un
// archivo fuera de scope (o una tarea activa sin `paths` declarado), imprimiendo tarea,
// archivo y los `paths` declarados.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DEFAULT_TASKS_DIR = join(ROOT, "tasks");

/** Estados de tarea cuyo diff todavía puede estar sin commitear y por lo tanto es
 *  revisable en tiempo real contra el working tree (ver razonamiento arriba). */
const ESTADOS_CON_DIFF_REVISABLE = new Set(["doing", "review"]);

export interface ScopeTaskFile {
  file: string;
  id: string | null;
  status: string | null;
  paths: string[];
}

export interface ScopeViolation {
  taskFile: string;
  taskId: string;
  /** `null` cuando la violación es "tarea activa sin `paths` declarado" -- no hay un
   *  archivo puntual que señalar, la tarea entera carece de scope verificable. */
  file: string | null;
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
 *  `gate-por-tarea.ts`/`backlogStateMachine.ts`) -- solo lee `id`, `status` y `paths`,
 *  que es todo lo que este check necesita. */
export function parseTaskFrontmatterConScope(content: string): { id: string | null; status: string | null; paths: string[] } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { id: null, status: null, paths: [] };

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

  return { id: raw.id ?? null, status: raw.status ?? null, paths };
}

function normalizePath(p: string): string {
  // Rutas declaradas o devueltas por git pueden traer separadores de plataforma o un
  // "./" al frente; se normalizan a POSIX relativo-al-repo para comparar sin importar
  // el SO (git en sí ya siempre devuelve POSIX, pero lo declarado a mano en el
  // frontmatter puede no estarlo).
  return p.replace(/^\.\//, "").split(sep).join("/").replace(/\/+$/, "");
}

/** ¿`file` cae dentro de alguno de los `paths` declarados? Un `path` declarado cubre:
 *  (a) ese archivo exacto, o (b) cualquier archivo bajo esa carpeta (`path` tratado
 *  como prefijo de directorio, con o sin `/` final -- así declarar `scripts/checks`
 *  cubre `scripts/checks/scope-de-tarea.ts` sin exigir la barra). Comparación por
 *  límite de segmento real (`path + "/"`), nunca por subcadena cruda -- así
 *  `docs/ACEPTACION.md` NO cubre por accidente `docs/ACEPTACION.md.bak` ni
 *  `docs/ACEPTACION.md-viejo`. */
export function archivoEnScope(file: string, declaredPaths: readonly string[]): boolean {
  const f = normalizePath(file);
  return declaredPaths.some((raw) => {
    const p = normalizePath(raw);
    return f === p || f.startsWith(`${p}/`);
  });
}

/** Lee el diff real de git en `repoRoot`: archivos trackeados modificados/añadidos/
 *  borrados respecto a `HEAD` (`git diff --name-only HEAD`, cubre staged + unstaged a
 *  la vez) más archivos nuevos sin trackear y no ignorados (`git ls-files --others
 *  --exclude-standard`) -- exactamente "todo lo que cambió en el working tree desde el
 *  último commit", que es el diff de la tarea activa antes de cerrarla. */
export function obtenerArchivosCambiadosGit(repoRoot: string = ROOT): string[] {
  const opts: { cwd: string; encoding: BufferEncoding; stdio: ["ignore", "pipe", "pipe"] } = {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  const tracked = execFileSync("git", ["diff", "--name-only", "HEAD"], opts);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], opts);
  const files = new Set<string>();
  for (const line of `${tracked}\n${untracked}`.split("\n")) {
    const f = line.trim();
    if (f.length > 0) files.add(normalizePath(f));
  }
  return [...files].sort();
}

/** `tasksDir`/`relativeTo`/`getChangedFiles` son inyectables SOLO para pruebas (mismo
 *  patrón que `checkGatePorTarea` en `gate-por-tarea.ts`) -- el uso real (CLI) siempre
 *  escanea `tasks/` en la raíz del repo real contra el diff real de git. */
export function checkScopeDeTarea(
  tasksDir: string = DEFAULT_TASKS_DIR,
  relativeTo: string = ROOT,
  getChangedFiles: () => string[] = () => obtenerArchivosCambiadosGit(relativeTo),
): ScopeViolation[] {
  const taskFiles = walkTaskFiles(tasksDir);

  const activeTasks: (ScopeTaskFile & { file: string })[] = [];
  for (const filePath of taskFiles) {
    const relFile = relative(relativeTo, filePath);
    const content = readFileSync(filePath, "utf8");
    const { id, status, paths } = parseTaskFrontmatterConScope(content);
    if (status !== null && ESTADOS_CON_DIFF_REVISABLE.has(status)) {
      activeTasks.push({ file: relFile, id, status, paths });
    }
  }

  if (activeTasks.length === 0) return [];

  const violations: ScopeViolation[] = [];
  const changedFiles = getChangedFiles().map(normalizePath);

  for (const task of activeTasks) {
    const taskId = task.id ?? task.file;

    if (task.paths.length === 0) {
      violations.push({
        taskFile: task.file,
        taskId,
        file: null,
        message: `la tarea está en \`${task.status}\` (código en curso) pero no declara \`paths\` -- no hay scope contra el cual verificar su diff.`,
      });
      continue;
    }

    for (const file of changedFiles) {
      // La propia tarea NUNCA se exime de estar dentro de sus `paths` declarados (ver
      // comentario de cabecera) -- se compara igual que cualquier otro archivo.
      if (!archivoEnScope(file, task.paths)) {
        violations.push({
          taskFile: task.file,
          taskId,
          file,
          message: `archivo "${file}" fuera del scope declarado por la tarea (\`paths\`: ${task.paths.join(", ")}).`,
        });
      }
    }
  }

  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const taskFilesFound = walkTaskFiles(DEFAULT_TASKS_DIR).length;
  const violations = checkScopeDeTarea();

  if (violations.length > 0) {
    console.error(`REQ-GOB-004: ${violations.length} archivo(s) fuera del scope declarado:`);
    for (const v of violations) {
      console.error(`  ${v.taskFile} [${v.taskId}]${v.file ? ` -> ${v.file}` : ""}: ${v.message}`);
    }
    process.exit(1);
  }

  if (taskFilesFound === 0) {
    console.log(
      "REQ-GOB-004 OK: 0 archivos de tarea bajo tasks/ (el backlog de archivos de GOB-045 aún no se materializó en " +
        "este repo -- docs/PROGRESO.md/docs/BLOQUEOS.md siguen siendo el proceso real hoy) -- nada que verificar.",
    );
  } else {
    console.log(
      "REQ-GOB-004 OK: ninguna tarea en `doing`/`review` con diff fuera de su scope declarado " +
        `(${taskFilesFound} archivo(s) de tarea revisado(s) bajo tasks/).`,
    );
  }
  process.exit(0);
}
