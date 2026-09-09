#!/usr/bin/env node
// REQ-OBS-010 (GOB-006, GOB-047) · revisión estática: "Cada tarea del backlog se cierra
// solo con evidencia de verificación en verde guardada en `docs/logs/<tarea>/`; intento
// de marcar una tarea `done` sin ese directorio de evidencia es rechazado por el propio
// flujo de cierre (verificado con un caso sin evidencia → cierre bloqueado)."
//
// Una tarea es un archivo Markdown con frontmatter bajo `tasks/**` (GOB-045 -- mismo
// formato plano `clave: valor` que `gate-por-tarea.ts`/`scope-de-tarea.ts`). Este check
// es autocontenido a propósito (mismo patrón que esos dos: NO depende de
// `backlogStateMachine.ts` ni de ningún otro check, para no arriesgar su cobertura ya
// probada) -- reutiliza el mismo parseo mínimo de frontmatter, duplicado deliberadamente
// en vez de importado.
//
// "Cierra" (ACEPTACION.md/REQ-GOB-005): una tarea pasa primero a `review` al cerrarse
// (verificación en verde + evidencia + commit, en ese orden) y más tarde a `done` tras
// aprobación. Este check exige el directorio de evidencia en AMBOS estados -- `review`
// porque ya se presenta como cerrada (GOB-005 exige la evidencia ANTES del commit que
// produce ese estado, no después), y `done` porque es el estado final que el criterio
// nombra explícitamente ("marcar una tarea `done` sin evidencia"). Una tarea
// `draft`/`ready`/`doing`/`blocked`/`needs-human` todavía no se está cerrando: nada que
// exigir.
//
// Evidencia = `docs/logs/<id-de-tarea>/` existe y contiene al menos un archivo (en
// cualquier profundidad) -- un directorio vacío (p.ej. creado por error o por un `mkdir`
// sin contenido real) NO cuenta como evidencia, mismo criterio que "evidencia = comando
// real + salida guardada" de `docs/ACEPTACION.md` §1.
//
// Si `tasks/` no existe, o no contiene ninguna tarea en `done`/`review`, no hay nada que
// verificar y el check pasa en verde -- igual que `gate-por-tarea.ts`/`scope-de-tarea.ts`
// (0 violaciones porque no hay tarea que cerrar, no porque se buscó mal; ver
// `tests/unit/gob/evidencia-obligatoria-cierre.spec.ts`, que ejercita la lógica real
// contra tareas y directorios de evidencia sintéticos).
//
// Uso: `node scripts/checks/evidencia-obligatoria-cierre.ts` -- sale con código 1 si
// encuentra una tarea `done`/`review` sin directorio de evidencia no vacío bajo
// `docs/logs/`, imprimiendo tarea y motivo.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DEFAULT_TASKS_DIR = join(ROOT, "tasks");
const DEFAULT_LOGS_DIR = join(ROOT, "docs", "logs");

/** Estados que exigen evidencia guardada antes de considerarse cerrados (ver
 *  razonamiento en el comentario de cabecera). */
const ESTADOS_QUE_EXIGEN_EVIDENCIA = new Set(["done", "review"]);

export interface EvidenceTaskFile {
  file: string;
  id: string | null;
  status: string | null;
}

export interface EvidenceViolation {
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
 *  `gate-por-tarea.ts`/`scope-de-tarea.ts`/`backlogStateMachine.ts`) -- solo lee `id` y
 *  `status`, que es todo lo que este check necesita. */
export function parseTaskFrontmatterConEstado(content: string): { id: string | null; status: string | null } {
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

function normalizeTaskId(id: string): string {
  // Un `id` con separadores de plataforma o segmentos "../" no puede escapar de
  // `docs/logs/` -- se usa tal cual lo declara la tarea, pero nunca como ruta (solo como
  // nombre de un único segmento de directorio bajo DEFAULT_LOGS_DIR/logsDir).
  return id.split(sep).join("/").split("/").filter((p) => p.length > 0 && p !== "..").join("_");
}

/** ¿Existe `logsDir/<taskId>/` y contiene al menos un archivo, en cualquier
 *  profundidad? Un directorio ausente o vacío (incluidas subcarpetas vacías) NO cuenta
 *  como evidencia guardada. */
export function tieneEvidenciaNoVacia(taskId: string, logsDir: string = DEFAULT_LOGS_DIR): boolean {
  const dir = join(logsDir, normalizeTaskId(taskId));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;

  function contieneArchivo(d: string): boolean {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isFile()) return true;
      if (stat.isDirectory() && contieneArchivo(full)) return true;
    }
    return false;
  }

  return contieneArchivo(dir);
}

/** `tasksDir`/`relativeTo`/`logsDir` son inyectables SOLO para pruebas (mismo patrón que
 *  `checkGatePorTarea`/`checkScopeDeTarea`) -- el uso real (CLI) siempre escanea
 *  `tasks/`/`docs/logs/` en la raíz del repo real. */
export function checkEvidenciaObligatoriaCierre(
  tasksDir: string = DEFAULT_TASKS_DIR,
  relativeTo: string = ROOT,
  logsDir: string = DEFAULT_LOGS_DIR,
): EvidenceViolation[] {
  const violations: EvidenceViolation[] = [];

  for (const filePath of walkTaskFiles(tasksDir)) {
    const relFile = relative(relativeTo, filePath);
    const content = readFileSync(filePath, "utf8");
    const { id, status } = parseTaskFrontmatterConEstado(content);

    if (status === null || !ESTADOS_QUE_EXIGEN_EVIDENCIA.has(status)) continue;

    if (id === null) {
      violations.push({
        taskFile: relFile,
        taskId: relFile,
        message: `la tarea está en \`${status}\` (cierre exige evidencia) pero no declara \`id\` en su frontmatter -- no hay directorio de evidencia que resolver.`,
      });
      continue;
    }

    if (!tieneEvidenciaNoVacia(id, logsDir)) {
      const dirEsperado = join("docs", "logs", normalizeTaskId(id)).split(sep).join("/");
      const existeVacio = existsSync(join(logsDir, normalizeTaskId(id)));
      violations.push({
        taskFile: relFile,
        taskId: id,
        message: existeVacio
          ? `la tarea está en \`${status}\` pero su directorio de evidencia \`${dirEsperado}/\` existe y está VACÍO -- no cuenta como evidencia guardada.`
          : `la tarea está en \`${status}\` pero no existe \`${dirEsperado}/\` -- cierre bloqueado sin evidencia de verificación en verde.`,
      });
    }
  }

  return violations;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const taskFilesFound = walkTaskFiles(DEFAULT_TASKS_DIR).length;
  const violations = checkEvidenciaObligatoriaCierre();

  if (violations.length > 0) {
    console.error(`REQ-OBS-010: ${violations.length} tarea(s) cerrada(s) sin evidencia:`);
    for (const v of violations) {
      console.error(`  ${v.taskFile} [${v.taskId}]: ${v.message}`);
    }
    process.exit(1);
  }

  if (taskFilesFound === 0) {
    console.log(
      "REQ-OBS-010 OK: 0 archivos de tarea bajo tasks/ (el backlog de archivos de GOB-045 aún no se materializó en " +
        "este repo -- docs/PROGRESO.md/docs/BLOQUEOS.md siguen siendo el proceso real hoy) -- nada que verificar.",
    );
  } else {
    console.log(
      `REQ-OBS-010 OK: ${taskFilesFound} tarea(s) revisada(s) bajo tasks/ -- ninguna tarea \`done\`/\`review\` sin ` +
        "su directorio de evidencia no vacío bajo docs/logs/.",
    );
  }
  process.exit(0);
}
