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

// ---------------------------------------------------------------------------
// REQ-GOB-014 (GOB-049, BP-136): "Debe existir un archivo de foco (`FOCUS.md`) por
// fase/línea que fije la fase vigente y los módulos abiertos; el flujo de
// planificación (REQ-GOB-001/`selectNextTask`, ver más abajo) solo debe abrir tareas
// del foco vigente."
//
// Este módulo sigue siendo de dominio PURO (sin I/O, ver cabecera del archivo):
// `parseFocusFile` recibe el CONTENIDO ya leído de `docs/FOCUS.md` (igual que
// `parseTaskFile` recibe el contenido de una tarea, nunca una ruta de disco) y
// devuelve `{ phase, openModules }` -- exactamente el array `openModules` que
// `selectNextTask` ya declaraba recibir "resuelto externamente hasta que REQ-GOB-014
// produzca `FOCUS.md` real" (ver comentario de `selectNextTask`). `renderFocusFile` es
// el inverso (mismo patrón round-trip que `renderTaskFile`/`parseTaskFile`), para
// generar/actualizar el archivo real desde código en vez de arriesgar un typo de
// módulo editándolo a mano.
// ---------------------------------------------------------------------------

/** Foco vigente de una fase/línea (GOB-049): la fase actual y los módulos que puede
 *  abrir el flujo de planificación mientras ese foco esté vigente. */
export interface FocusFile {
  /** Fase vigente, texto libre corto (p.ej. "cierre-p0", "H4"). Nunca vacío: un
   *  `FOCUS.md` sin fase declarada no fija nada y `parseFocusFile` lo rechaza. */
  phase: string;
  /** Módulos abiertos -- mismos códigos que `BacklogTask.module` (p.ej. "REC", "GOB").
   *  Único insumo real de `openModules` en `selectNextTask`; nunca vacío (un foco sin
   *  ningún módulo abierto detendría el loop por completo, y eso se declara con la
   *  ausencia/blocked de tareas, no con un `FOCUS.md` vacío). */
  openModules: string[];
}

export class InvalidFocusFileError extends Error {
  constructor(reason: string) {
    super(`focus_file_invalido: ${reason}`);
    this.name = "InvalidFocusFileError";
  }
}

/**
 * Parsea el contenido de un `FOCUS.md`: frontmatter `---` con `phase:` y
 * `openModules:` (lista separada por comas), mismo estilo de frontmatter plano que
 * `parseTaskFile` (sin dependencia de un parser YAML externo). Rechaza (nunca asume un
 * default en silencio) cuando falta el frontmatter, falta `phase`, falta
 * `openModules`, o `openModules` queda vacío tras filtrar espacios en blanco.
 */
export function parseFocusFile(content: string): FocusFile {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new InvalidFocusFileError('el archivo no tiene frontmatter "---" con `phase`/`openModules`.');
  }

  const raw: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    raw[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const phase = raw.phase?.trim();
  if (!phase) {
    throw new InvalidFocusFileError('falta "phase" (la fase vigente) en el frontmatter.');
  }

  const openModules = (raw.openModules ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (openModules.length === 0) {
    throw new InvalidFocusFileError('"openModules" está vacío -- GOB-049 exige al menos un módulo abierto.');
  }

  return { phase, openModules };
}

/** Inverso de `parseFocusFile` (round-trip probado en
 *  `tests/unit/gob/focus-vigente.spec.ts`) -- genera el `FOCUS.md` real desde código,
 *  con `body` opcional (la sección Markdown libre bajo el frontmatter, p.ej. la
 *  justificación de qué módulos están abiertos y por qué). */
export function renderFocusFile(focus: FocusFile, body: string = ""): string {
  const lines = ["---", `phase: ${focus.phase}`, `openModules: ${focus.openModules.join(", ")}`, "---"];
  const trimmedBody = body.trim();
  lines.push("", trimmedBody.length > 0 ? trimmedBody : `# Foco vigente: ${focus.phase}`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// REQ-OBS-003 (GOB-009, BP-142/BP-143): "cada N tareas cerradas del backlog se ejecuta
// una auditoría periódica automatizada (checklist del blueprint) que escribe un
// veredicto fechado en un documento; un veredicto rojo detiene el loop de construcción
// hasta su resolución." GOB-009 fija N=8 ("cada 8 tareas cerradas").
//
// Este módulo es de dominio PURO (sin I/O, ver cabecera del archivo): NO ejecuta el
// checklist ni escribe/lee el documento del veredicto -- eso vive en
// `scripts/checks/auditoria-periodica.ts` (el orquestador con I/O real: cuenta tareas
// `done` bajo `tasks/**`, corre el checklist, escribe `docs/auditoria-N/ronda-<n>.md` y
// lee el último veredicto). Lo que SÍ vive aquí, como en el resto del archivo, es la
// regla verificable: dado un conteo de tareas cerradas, ¿toca ronda? Y dado el último
// veredicto conocido, ¿el loop de construcción debe bloquearse? `selectNextTask` --el
// único punto real de "el loop toma la siguiente tarea"-- aplica esa regla ANTES de
// seleccionar nada, para que "un veredicto rojo detiene el loop" sea un invariante
// verificado (una excepción real que nunca se puede esquivar en silencio), no una
// promesa de proceso.
// ---------------------------------------------------------------------------

/** GOB-009: "cada 8 tareas cerradas". Única fuente de verdad del intervalo -- tanto la
 *  máquina de estados como `scripts/checks/auditoria-periodica.ts` lo importan de aquí. */
export const PERIODIC_AUDIT_INTERVAL_TASKS = 8;

export type AuditVerdict = "verde" | "rojo";

/** Registro del último veredicto de auditoría periódica conocido, tal como lo produce
 *  `scripts/checks/auditoria-periodica.ts` a partir del documento fechado real bajo
 *  `docs/auditoria-N/`. `resolved` es `false` mientras un veredicto `rojo` siga sin
 *  atenderse (solo `--resolver <ronda>` en ese script, tras corregir la causa, lo pasa
 *  a `true`); un veredicto `verde` no necesita resolución. */
export interface PeriodicAuditRecord {
  round: number;
  date: string;
  closedTaskCount: number;
  verdict: AuditVerdict;
  resolved: boolean;
  documentPath: string;
}

/** ¿El conteo de tareas `done` alcanza el próximo múltiplo del intervalo? `0` tareas
 *  cerradas NUNCA cuenta como "toca ronda" (una ronda de auditoría sin nada que auditar
 *  no tiene sentido) -- mismo criterio de "vacío honesto" que el resto del backlog de
 *  archivos (`tasks/` aún no materializado en este repo, ver `scripts/checks/*.ts`). */
export function isPeriodicAuditDue(closedTaskCount: number, intervalN: number = PERIODIC_AUDIT_INTERVAL_TASKS): boolean {
  return closedTaskCount > 0 && closedTaskCount % intervalN === 0;
}

/** Tareas `done` del backlog dado -- lo que cuenta como "tarea cerrada" para GOB-009. */
export function countClosedTasks(tasks: readonly BacklogTask[]): number {
  return tasks.filter((t) => t.status === "done").length;
}

/** Un veredicto `rojo` sin resolver bloquea el loop -- SIEMPRE, sin importar si ya toca
 *  una ronda nueva o no (GOB-009: "hasta resolución", no "hasta la próxima ronda"). Sin
 *  auditoría previa (`null`/`undefined`), o con la última en `verde`, o ya `resolved`,
 *  el loop sigue libre. */
export function isBuildLoopBlockedByAudit(lastAudit: PeriodicAuditRecord | null | undefined): boolean {
  return !!lastAudit && lastAudit.verdict === "rojo" && !lastAudit.resolved;
}

export class BuildLoopBlockedByAuditError extends Error {
  readonly audit: PeriodicAuditRecord;

  constructor(audit: PeriodicAuditRecord) {
    super(
      `loop_bloqueado_por_auditoria: REQ-OBS-003/GOB-009 -- la ronda de auditoría periódica ` +
        `#${audit.round} (${audit.date}, ${audit.documentPath}) dio veredicto ROJO y sigue sin resolverse; ` +
        `el loop de construcción no puede tomar una nueva tarea hasta que se resuelva.`,
    );
    this.name = "BuildLoopBlockedByAuditError";
    this.audit = audit;
  }
}

/**
 * REQ-GOB-001 (GOB-001/GOB-046/GOB-049): selección de la siguiente tarea del backlog.
 * Filtra `ready`, sin dependencias abiertas, dentro de `openModules` (los módulos
 * abiertos del `FOCUS.md` vigente -- REQ-GOB-014/`parseFocusFile` produce ese array a
 * partir del `FOCUS.md` real de la línea; aquí se recibe ya resuelto como lista de
 * módulos, nunca leyendo el archivo por sí misma, ver cabecera del archivo sobre
 * dominio puro), por menor `orden` (empate → menor
 * `estimacionHoras`), y la MUEVE a `doing` (transición real vía
 * `transitionBacklogTask`, nunca una copia con `status` reescrito a mano). Devuelve
 * `null` si ninguna tarea del backlog cumple los 3 filtros.
 *
 * `lastAudit` (REQ-OBS-003/GOB-009, opcional -- por defecto `undefined`, sin bloqueo):
 * si es un veredicto `rojo` sin resolver (`isBuildLoopBlockedByAudit`), esta función
 * lanza `BuildLoopBlockedByAuditError` ANTES de mirar ninguna tarea -- ninguna selección
 * ocurre mientras el loop esté bloqueado, sea cual sea el estado del backlog.
 */
export function selectNextTask(
  tasks: readonly BacklogTask[],
  openModules: readonly string[],
  lastAudit?: PeriodicAuditRecord | null,
): BacklogTask | null {
  if (isBuildLoopBlockedByAudit(lastAudit)) {
    // `isBuildLoopBlockedByAudit` ya descartó null/undefined -- `lastAudit` es un
    // `PeriodicAuditRecord` real en este punto.
    throw new BuildLoopBlockedByAuditError(lastAudit as PeriodicAuditRecord);
  }

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
