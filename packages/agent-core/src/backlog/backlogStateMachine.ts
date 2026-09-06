/**
 * REQ-GOB-007 (GOB-045/GOB-048): "El backlog de tareas debe modelarse como máquina de
 * estados `draft→ready→doing→review→done` con laterales `blocked`/`needs-human`, una
 * tarea = un archivo desde plantilla, con contador de intentos y un gate declarado
 * (valor `none`, `connector`, `money` o `physical`)."
 *
 * Esto NO reemplaza el proceso humano/documental existente (`docs/PROGRESO.md`,
 * `docs/BLOQUEOS.md`) -- es el módulo de dominio PURO (sin I/O) que hace la máquina de
 * estados verificable: una transición fuera de la tabla se RECHAZA (nunca se permite
 * "a mano"), y `renderTaskFile`/`parseTaskFile` son la plantilla real de "una tarea =
 * un archivo" (round-trip probado).
 */

export const BACKLOG_STATUSES = ["draft", "ready", "doing", "review", "done", "blocked", "needs-human"] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];

export const BACKLOG_GATES = ["none", "connector", "money", "physical"] as const;
export type BacklogGate = (typeof BACKLOG_GATES)[number];

export interface BacklogTask {
  id: string;
  title: string;
  module: string;
  /** Menor `orden` se selecciona primero (GOB-001/GOB-046/GOB-049); empate → menor
   *  `estimacionHoras`. */
  orden: number;
  estimacionHoras: number;
  gate: BacklogGate;
  status: BacklogStatus;
  /** Contador de intentos fallidos POR LA MISMA CAUSA (GOB-008/GOB-045): al llegar a
   *  3, la tarea pasa automáticamente a `blocked` (ver `recordFailedAttempt`). */
  attempts: number;
  blockedReason: string | null;
  needsHumanReason: string | null;
}

export class InvalidBacklogTransitionError extends Error {
  constructor(from: BacklogStatus, to: BacklogStatus) {
    super(`transicion_invalida_backlog: "${from}" -> "${to}" no está permitida por la máquina de estados de REQ-GOB-007.`);
    this.name = "InvalidBacklogTransitionError";
  }
}

/**
 * Tabla de transiciones válidas. Camino principal
 * `draft→ready→doing→review→done`; `review→doing` es el único retorno a trabajo
 * (cambios solicitados en revisión); `blocked`/`needs-human` son laterales alcanzables
 * SOLO desde `doing` (una tarea se bloquea trabajándola, nunca desde `draft`/`ready`
 * sin haber empezado), y ambas pueden reanudarse hacia `doing` una vez resuelto el
 * bloqueo o aprobada la decisión reservada al fundador (GOB-006/GOB-012); `blocked`
 * puede escalar a `needs-human` si el motivo del bloqueo resulta ser una decisión
 * reservada al fundador.
 */
const TRANSITIONS: Record<BacklogStatus, readonly BacklogStatus[]> = {
  draft: ["ready"],
  ready: ["doing"],
  doing: ["review", "blocked", "needs-human"],
  review: ["done", "doing"],
  done: [],
  blocked: ["doing", "needs-human"],
  "needs-human": ["doing"],
};

export function isValidBacklogTransition(from: BacklogStatus, to: BacklogStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface CreateBacklogTaskInput {
  id: string;
  title: string;
  module: string;
  orden: number;
  estimacionHoras: number;
  gate: BacklogGate;
}

/** Toda tarea nueva nace en `draft` con 0 intentos (GOB-045: "una tarea = un archivo
 *  desde plantilla"). */
export function createBacklogTask(input: CreateBacklogTaskInput): BacklogTask {
  if (!BACKLOG_GATES.includes(input.gate)) {
    throw new Error(`gate_invalido: "${input.gate}" no es uno de ${BACKLOG_GATES.join(", ")}.`);
  }
  return {
    ...input,
    status: "draft",
    attempts: 0,
    blockedReason: null,
    needsHumanReason: null,
  };
}

export interface TransitionOptions {
  /** Obligatorio al transicionar a `blocked` (GOB-003/GOB-008: "la tarea pasa a
   *  blocked con el motivo documentado"). */
  blockedReason?: string;
  /** Obligatorio al transicionar a `needs-human` (GOB-006: "si la tarea toca el
   *  catálogo de decisiones reservadas al fundador, pasa a needs-human"). */
  needsHumanReason?: string;
}

/**
 * Aplica una transición. Lanza `InvalidBacklogTransitionError` si no está en la tabla
 * -- NUNCA permite "forzar" un estado fuera de la máquina. `blocked`/`needs-human`
 * exigen su razón correspondiente (nunca un bloqueo sin motivo documentado).
 */
export function transitionBacklogTask(task: BacklogTask, to: BacklogStatus, opts: TransitionOptions = {}): BacklogTask {
  if (!isValidBacklogTransition(task.status, to)) {
    throw new InvalidBacklogTransitionError(task.status, to);
  }

  if (to === "blocked") {
    if (!opts.blockedReason || opts.blockedReason.trim().length === 0) {
      throw new Error("blocked_sin_motivo: GOB-003/GOB-008 exigen documentar el motivo al bloquear una tarea.");
    }
    return { ...task, status: to, blockedReason: opts.blockedReason, needsHumanReason: null };
  }

  if (to === "needs-human") {
    if (!opts.needsHumanReason || opts.needsHumanReason.trim().length === 0) {
      throw new Error("needs_human_sin_motivo: GOB-006 exige documentar por qué la tarea requiere decisión del fundador.");
    }
    return { ...task, status: to, needsHumanReason: opts.needsHumanReason, blockedReason: null };
  }

  // Salir de blocked/needs-human o llegar a cualquier otro estado limpia ambas razones
  // -- ya no describen el estado actual de la tarea.
  return { ...task, status: to, blockedReason: null, needsHumanReason: null };
}

/**
 * Registra un intento fallido de la MISMA causa (GOB-008/GOB-045: "tres intentos
 * fallidos por la misma causa deben pasar la tarea a blocked con diagnóstico"). Al
 * tercer intento, transiciona automáticamente a `blocked` con el diagnóstico dado --
 * el llamador nunca decide "a mano" cuándo bloquear por reintentos agotados.
 */
export function recordFailedAttempt(task: BacklogTask, diagnostico: string): BacklogTask {
  const attempts = task.attempts + 1;
  if (attempts >= 3) {
    return transitionBacklogTask({ ...task, attempts }, "blocked", {
      blockedReason: `3 intentos fallidos por la misma causa: ${diagnostico}`,
    });
  }
  return { ...task, attempts };
}

// ---------------------------------------------------------------------------
// "una tarea = un archivo desde plantilla" (GOB-045): plantilla Markdown con
// frontmatter YAML simple (sin dependencia de un parser YAML externo -- el
// frontmatter de una tarea es siempre plano, clave: valor). Round-trip probado en
// tests/unit/gob/backlog-state-machine.spec.ts.
// ---------------------------------------------------------------------------

const FRONTMATTER_FIELDS = ["id", "title", "module", "orden", "estimacionHoras", "gate", "status", "attempts", "blockedReason", "needsHumanReason"] as const;

export function renderTaskFile(task: BacklogTask): string {
  const lines = ["---"];
  for (const field of FRONTMATTER_FIELDS) {
    const value = task[field];
    lines.push(`${field}: ${value === null ? "null" : String(value)}`);
  }
  lines.push("---", "", `# ${task.title}`, "");
  return lines.join("\n");
}

export function parseTaskFile(content: string): BacklogTask {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("plantilla_invalida: el archivo de tarea no tiene frontmatter `---`.");

  const raw: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const parseNullable = (v: string | undefined): string | null => (!v || v === "null" ? null : v);

  const gate = raw.gate as BacklogGate;
  if (!BACKLOG_GATES.includes(gate)) throw new Error(`gate_invalido: "${raw.gate}" no es uno de ${BACKLOG_GATES.join(", ")}.`);
  const status = raw.status as BacklogStatus;
  if (!BACKLOG_STATUSES.includes(status)) throw new Error(`status_invalido: "${raw.status}" no es un estado válido.`);

  return {
    id: raw.id!,
    title: raw.title!,
    module: raw.module!,
    orden: Number(raw.orden),
    estimacionHoras: Number(raw.estimacionHoras),
    gate,
    status,
    attempts: Number(raw.attempts ?? "0"),
    blockedReason: parseNullable(raw.blockedReason),
    needsHumanReason: parseNullable(raw.needsHumanReason),
  };
}

/**
 * Selección de la siguiente tarea (GOB-001/GOB-046/GOB-049): filtra `ready`, y de
 * ellas la de menor `orden` (empate → menor `estimacionHoras`). Nunca selecciona una
 * tarea fuera de `ready` -- `doing`/`blocked`/etc. quedan fuera aunque tengan `orden`
 * menor.
 */
export function selectNextReadyTask(tasks: readonly BacklogTask[]): BacklogTask | null {
  const ready = tasks.filter((t) => t.status === "ready");
  if (ready.length === 0) return null;
  return [...ready].sort((a, b) => a.orden - b.orden || a.estimacionHoras - b.estimacionHoras)[0]!;
}
