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

/**
 * REQ-GOB-006 (GOB-006/GOB-012): catálogo cerrado de 24 categorías de decisión
 * reservadas exclusivamente al fundador humano -- copia EXACTA (mismos 24 valores,
 * mismo orden) del enum real `public.founder_reserved_category` creado por la
 * migración `packages/db/migrations/0081_decisiones_reservadas_fundador.sql`. Este
 * módulo es de dominio PURO (sin I/O, ver cabecera del archivo) y por eso no puede
 * consultar la base de datos para leer el catálogo en tiempo de ejecución -- en su
 * lugar, `tests/unit/gob/tres-intentos-bloqueo.spec.ts` aplica esa migración contra
 * PGlite real (ADR-003) y compara el enum vivo de Postgres contra esta constante
 * campo por campo, así que un drift entre ambos (alguien agrega/quita una categoría en
 * el SQL sin actualizar esta lista, o viceversa) se detecta en CI como test rojo, nunca
 * en silencio.
 */
export const FOUNDER_RESERVED_CATEGORIES = [
  "precios_de_lista",
  "contratos_terceros",
  "flujos_dinero_terceros_o_efirma",
  "retencion_o_biometria",
  "outbound_internacional",
  "modo_autonomo_sensible",
  "cambio_proveedor_modelo_telefonia_bd",
  "migracion_livekit_selfhost",
  "borrado_destructivo_o_force_push",
  "marca_dominio_o_legal",
  "impacto_reputacional_externo",
  "contratacion_despido_o_compensacion",
  "control_fisico_ac_cerraduras_llaves",
  "shadow_a_autopilot_revenue",
  "datos_de_otros_hoteles_cliente",
  "retencion_identidad_mayor_30_dias",
  "cobro_vcc_disputas_o_declaraciones_fiscales",
  "partner_pms_o_cm",
  "compra_de_hardware_o_esco",
  "estructura_de_exito_compartido",
  "modo_sin_recepcion_nocturna",
  "reduccion_de_plantilla",
  "protocolos_de_huracan",
  "abandono_de_lovable_o_convivencia_con_repo",
] as const;
export type FounderReservedCategory = (typeof FOUNDER_RESERVED_CATEGORIES)[number];

/** Runtime guard (necesaria en `parseTaskFile`/`createBacklogTask`, donde el valor
 *  llega como `string` sin garantía estática) -- ver `FOUNDER_RESERVED_CATEGORIES`. */
export function isFounderReservedCategory(value: string): value is FounderReservedCategory {
  return (FOUNDER_RESERVED_CATEGORIES as readonly string[]).includes(value);
}

export interface BacklogTask {
  id: string;
  title: string;
  module: string;
  /** Menor `orden` se selecciona primero (GOB-001/GOB-046/GOB-049); empate → menor
   *  `estimacionHoras`. */
  orden: number;
  estimacionHoras: number;
  gate: BacklogGate;
  /** IDs de otras tareas del backlog de las que esta depende (GOB-001/GOB-046: "sin
   *  dependencias abiertas"). Una dependencia se considera abierta salvo que exista en
   *  el backlog dado y su `status` sea `done`. */
  dependencies: string[];
  /** Criterio de aceptación VERIFICABLE (GOB-003): texto que describe cómo se
   *  comprueba que la tarea quedó hecha (comando/prueba/evidencia esperada). `null`
   *  significa "sin criterio todavía" -- ver `hasVerifiableAcceptanceCriteria` y
   *  `beginImplementation`, que bloquean la tarea en ese caso en vez de implementar. */
  criterioAceptacion: string | null;
  /** REQ-GOB-006/GOB-012: si la tarea toca una de las 24 categorías del catálogo
   *  cerrado de decisiones reservadas al fundador (`FOUNDER_RESERVED_CATEGORIES`),
   *  declarado aquí explícitamente -- igual que `gate`, nunca inferido en silencio de
   *  los `paths` que la tarea toca. `null` significa "no toca ninguna categoría
   *  reservada al fundador". Ver `recordFailedAttempt`, que la usa para decidir si el
   *  3er fallo escala a `needs-human` en vez de `blocked`. */
  founderReservedCategory: FounderReservedCategory | null;
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
  /** Opcional: por defecto sin dependencias (`[]`). */
  dependencies?: string[];
  /** Opcional: por defecto sin criterio de aceptación (`null`, ver GOB-003). */
  criterioAceptacion?: string | null;
  /** Opcional: por defecto no toca ninguna categoría reservada al fundador (`null`,
   *  ver GOB-006/GOB-012). */
  founderReservedCategory?: FounderReservedCategory | null;
}

/** Toda tarea nueva nace en `draft` con 0 intentos (GOB-045: "una tarea = un archivo
 *  desde plantilla"). */
export function createBacklogTask(input: CreateBacklogTaskInput): BacklogTask {
  if (!BACKLOG_GATES.includes(input.gate)) {
    throw new Error(`gate_invalido: "${input.gate}" no es uno de ${BACKLOG_GATES.join(", ")}.`);
  }
  if (input.founderReservedCategory != null && !isFounderReservedCategory(input.founderReservedCategory)) {
    throw new Error(
      `founder_reserved_category_invalida: "${input.founderReservedCategory}" no es una de ${FOUNDER_RESERVED_CATEGORIES.join(", ")}.`,
    );
  }
  return {
    ...input,
    dependencies: input.dependencies ?? [],
    criterioAceptacion: input.criterioAceptacion ?? null,
    founderReservedCategory: input.founderReservedCategory ?? null,
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
 * tercer intento, transiciona automáticamente -- el llamador nunca decide "a mano"
 * cuándo bloquear ni a qué estado lateral:
 *
 *   - REQ-GOB-006 (GOB-006/GOB-012): si la tarea toca el catálogo cerrado de
 *     decisiones reservadas al fundador (`task.founderReservedCategory` es una de las
 *     24 `FOUNDER_RESERVED_CATEGORIES`), escala DIRECTO a `needs-human` -- nunca pasa
 *     por `blocked` primero, porque agotar 3 reintentos automatizados sobre una
 *     decisión reservada al fundador no es "un bloqueo técnico que alguien puede
 *     destrabar" (ese es el caso `blocked`), es evidencia de que la tarea necesita esa
 *     decisión del fundador desde el principio.
 *   - Cualquier otra tarea (sin categoría reservada, o con una categoría que esta
 *     versión del código no reconoce -- ver `isFounderReservedCategory`, nunca se trata
 *     una categoría desconocida como "sí reservada" por defecto) sigue el camino
 *     existente: `blocked` con el diagnóstico (GOB-008).
 */
export function recordFailedAttempt(task: BacklogTask, diagnostico: string): BacklogTask {
  const attempts = task.attempts + 1;
  if (attempts < 3) {
    return { ...task, attempts };
  }

  const tocaDecisionReservadaAlFundador =
    task.founderReservedCategory !== null && isFounderReservedCategory(task.founderReservedCategory);

  if (tocaDecisionReservadaAlFundador) {
    return transitionBacklogTask({ ...task, attempts }, "needs-human", {
      needsHumanReason:
        `REQ-GOB-006/GOB-012: 3 intentos fallidos por la misma causa sobre una tarea que toca la categoría ` +
        `reservada al fundador "${task.founderReservedCategory}" -- requiere decisión del fundador, no solo ` +
        `desbloqueo técnico. Diagnóstico: ${diagnostico}`,
    });
  }

  return transitionBacklogTask({ ...task, attempts }, "blocked", {
    blockedReason: `3 intentos fallidos por la misma causa: ${diagnostico}`,
  });
}

// ---------------------------------------------------------------------------
// "una tarea = un archivo desde plantilla" (GOB-045): plantilla Markdown con
// frontmatter YAML simple (sin dependencia de un parser YAML externo -- el
// frontmatter de una tarea es siempre plano, clave: valor). Round-trip probado en
// tests/unit/gob/backlog-state-machine.spec.ts.
// ---------------------------------------------------------------------------

const FRONTMATTER_FIELDS = [
  "id",
  "title",
  "module",
  "orden",
  "estimacionHoras",
  "gate",
  "dependencies",
  "criterioAceptacion",
  "founderReservedCategory",
  "status",
  "attempts",
  "blockedReason",
  "needsHumanReason",
] as const;

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

  const founderReservedCategoryRaw = parseNullable(raw.founderReservedCategory);
  if (founderReservedCategoryRaw !== null && !isFounderReservedCategory(founderReservedCategoryRaw)) {
    throw new Error(
      `founder_reserved_category_invalida: "${founderReservedCategoryRaw}" no es una de ${FOUNDER_RESERVED_CATEGORIES.join(", ")}.`,
    );
  }

  return {
    id: raw.id!,
    title: raw.title!,
    module: raw.module!,
    orden: Number(raw.orden),
    estimacionHoras: Number(raw.estimacionHoras),
    gate,
    dependencies: raw.dependencies ? raw.dependencies.split(",").filter((d) => d.length > 0) : [],
    criterioAceptacion: parseNullable(raw.criterioAceptacion),
    founderReservedCategory: founderReservedCategoryRaw,
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

/**
 * Una dependencia está ABIERTA salvo que exista en `tasks` con `status === "done"`
 * (GOB-001/GOB-046: "sin dependencias abiertas"). Una dependencia declarada que no
 * aparece en `tasks` se trata como abierta (nunca se asume resuelta sin evidencia).
 */
function hasOpenDependencies(task: BacklogTask, tasks: readonly BacklogTask[]): boolean {
  return task.dependencies.some((depId) => tasks.find((t) => t.id === depId)?.status !== "done");
}

/**
 * REQ-GOB-001 (GOB-001/GOB-046/GOB-049): selección de la siguiente tarea del backlog.
 * Filtra `ready`, sin dependencias abiertas, dentro de `openModules` (los módulos
 * abiertos del `FOCUS.md` vigente -- ese archivo lo produce/lee REQ-GOB-014; aquí se
 * recibe ya resuelto como lista de módulos), por menor `orden` (empate → menor
 * `estimacionHoras`), y la MUEVE a `doing` (transición real vía
 * `transitionBacklogTask`, nunca una copia con `status` reescrito a mano). Devuelve
 * `null` si ninguna tarea del backlog cumple los 3 filtros.
 */
export function selectNextTask(tasks: readonly BacklogTask[], openModules: readonly string[]): BacklogTask | null {
  const candidates = tasks.filter(
    (t) => t.status === "ready" && openModules.includes(t.module) && !hasOpenDependencies(t, tasks),
  );
  if (candidates.length === 0) return null;
  const selected = [...candidates].sort((a, b) => a.orden - b.orden || a.estimacionHoras - b.estimacionHoras)[0]!;
  return transitionBacklogTask(selected, "doing");
}

// ---------------------------------------------------------------------------
// REQ-GOB-003 (GOB-003): "Si falta un criterio de aceptación verificable, el agente no
// debe implementar: la tarea pasa a blocked con el motivo documentado."
// ---------------------------------------------------------------------------

/**
 * Un criterio de aceptación es VERIFICABLE cuando es texto no vacío (más allá de
 * espacios en blanco) -- describe cómo se comprueba que la tarea quedó hecha (comando,
 * prueba, evidencia esperada). `criterioAceptacion: null` o una cadena en blanco NO
 * cuentan como criterio verificable.
 */
export function hasVerifiableAcceptanceCriteria(task: BacklogTask): boolean {
  return typeof task.criterioAceptacion === "string" && task.criterioAceptacion.trim().length > 0;
}

/**
 * REQ-GOB-003 (GOB-003): puerta que se aplica ANTES de implementar una tarea ya movida
 * a `doing` (ver REQ-GOB-001/`selectNextTask`). Si le falta un criterio de aceptación
 * verificable, la tarea transiciona a `blocked` con el motivo documentado y `implement`
 * NUNCA se invoca -- "nunca se implementa sin ese criterio" queda verificado como
 * invariante (un espía que no se llama), no como una promesa de proceso. Si el criterio
 * SÍ está presente, se invoca `implement()` (el efecto de lado real -- escribir código,
 * fuera de este módulo puro -- vive en quien orquesta) y la tarea se devuelve sin
 * cambios de estado; pasar a `review` es responsabilidad de REQ-GOB-005, no de esta
 * puerta.
 *
 * Si la tarea NO está en `doing` (nunca se empezó a trabajar), `transitionBacklogTask`
 * rechaza el intento de bloquearla con `InvalidBacklogTransitionError` -- igual que
 * cualquier otro camino a `blocked` (GOB-007: "una tarea se bloquea trabajándola, nunca
 * desde draft/ready sin haber empezado") -- y `implement` tampoco se invoca en ese caso.
 */
export function beginImplementation(task: BacklogTask, implement: () => void): BacklogTask {
  if (!hasVerifiableAcceptanceCriteria(task)) {
    return transitionBacklogTask(task, "blocked", {
      blockedReason: `sin_criterio_de_aceptacion_verificable: REQ-GOB-003 exige un criterio de aceptación verificable antes de implementar "${task.id}" (${task.title}).`,
    });
  }
  implement();
  return task;
}
