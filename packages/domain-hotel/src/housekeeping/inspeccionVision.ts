/**
 * REQ-HK-003 (P1/F): "La inspección de habitaciones debe asistirse por visión con un
 * set estándar de fotos, generando aprobación o corrección específica en <30 s, con
 * muestreo físico de supervisión del 20-30% conservando la decisión final humana."
 * (BP-075, BP-101, H07-016, H11-004). Dependencia externa declarada en
 * docs/REQUISITOS.md: "ninguna" (docs/ACEPTACION.md: "Depende de credenciales: No") --
 * a diferencia de REQ-HUE-001/002/016 (WhatsApp/telefonía reales), este requisito debe
 * poder cerrarse SIN ningún modelo de visión/LLM externo.
 *
 * Alcance real de "asistida por visión" en este módulo (documentado sin adornos, mismo
 * criterio de honestidad que `EnvProvider`/`OPENROUTER_INTEGRATION_VERIFIED_AGAINST_REAL_API`
 * en agent-core): NO se decodifican píxeles ni se llama a un VLM -- BP-101 exige
 * explícitamente que el modelo de visión sea "apoyo, no veto" y que la supervisora
 * conserve la decisión final, así que la pieza que este REQ puede cerrar de forma
 * verificable y sin credenciales es el CONTRATO alrededor de esa asistencia: (1) exigir
 * el set estándar de 6 fotos (H11-004/BP-075) antes de poder generar cualquier
 * veredicto, (2) detectar fraude de evidencia obvio y objetivamente verificable sin IA
 * (foto reutilizada de otra ranura, foto fechada antes de que empezara ESTA limpieza o
 * en el futuro, checklist personalizado del hotel sin cubrir), (3) producir una
 * corrección ESPECÍFICA (qué falló y por qué) en vez de un simple "rechazado", en
 * milisegundos (siempre <30 s, medido por el llamador), (4) el muestreo determinístico
 * de supervisión física 20-30%, y (5) dejar estructuralmente imposible que este módulo
 * por sí solo cierre una inspección -- solo produce una SUGERENCIA; el cierre real
 * (`housekeeping_task.inspected_by/inspected_at`) vive únicamente en
 * `POST .../inspeccionar` (apps/api/src/routes/housekeeping.ts), que ya exige un
 * supervisor humano autenticado. Cablear aquí un VLM real (Haiku, BP-101) es trabajo
 * futuro que reutilizaría el mismo `LlmProvider`/`EnvProvider` de agent-core -- no un
 * nuevo tipo de dependencia -- y no bloquea el cierre de ESTE criterio de aceptación.
 *
 * Puro, determinístico, sin I/O (mismo principio que `qa/conversationAudit.ts` y
 * `fnbAllergyGuard.ts`): nunca usa `Date.now()`/`new Date()` ni `Math.random()`
 * internamente -- toda "hora actual" y toda selección de muestra dependen de argumentos
 * explícitos, para que el mismo conjunto de fotos siempre produzca el mismo veredicto y
 * la misma decisión de muestreo, reproducible en una auditoría posterior.
 */

/** Las 6 fotos estándar que BP-075/H11-004 piden por habitación. Los identificadores
 *  son estables (persisten en BD y en la evidencia archivada) -- nunca renombrar uno
 *  existente, solo agregar. */
export const STANDARD_INSPECTION_PHOTO_TYPES = [
  "cama",
  "bano",
  "amenidades_closet",
  "pisos_superficies",
  "ventanas_balcon",
  "entrada_general",
] as const;
export type StandardInspectionPhotoType = (typeof STANDARD_INSPECTION_PHOTO_TYPES)[number];

export class InspeccionVisionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InspeccionVisionError";
    this.code = code;
  }
}

export interface InspectionPhotoSubmission {
  readonly tipo: string;
  /** Referencia a la evidencia ya subida (no bytes de imagen -- este módulo no hace I/O
   *  ni decodifica imágenes, ver nota de alcance arriba). */
  readonly url: string;
  /** Momento en que se tomó la foto (ISO-8601), declarado por el cliente que sube la
   *  evidencia (app de la camarista). Se valida contra la ventana de limpieza real de
   *  la tarea -- ver `tomadaEnMs` más abajo. */
  readonly tomadaEn: string;
}

export type InspectionVerdict = "aprobada" | "correccion";

export interface InspectionCorrectionItem {
  readonly tipo: string;
  readonly motivo: string;
}

export interface InspectionVisionOutcome {
  readonly veredicto: InspectionVerdict;
  readonly items: readonly InspectionCorrectionItem[];
  readonly checklistCubierto: readonly string[];
  readonly checklistPendiente: readonly string[];
}

export interface EvaluateVisionInspectionInput {
  /** Las fotos enviadas para esta inspección -- se exige exactamente el set estándar,
   *  ni de más ni de menos (una foto de un tipo no reconocido es en sí una corrección). */
  readonly fotos: readonly InspectionPhotoSubmission[];
  /** Checklist propio de la tarea (`housekeeping_task.checklist`, texto libre por hotel,
   *  ej. "cambiar toallas") que además del set estándar de fotos debe declararse
   *  cubierto explícitamente por quien sube la evidencia -- nunca inferido de la foto. */
  readonly checklist: readonly string[];
  /** Ítems del checklist que quien sube la evidencia declara haber atendido. Debe ser
   *  superconjunto exacto (comparación normalizada) de `checklist` para que la
   *  inspección se sugiera aprobada. */
  readonly checklistCubierto: readonly string[];
  /** Inicio real de la limpieza de esta tarea (`housekeeping_task.started_at`) -- toda
   *  foto fechada ANTES de este momento es evidencia de otra limpieza (reutilizada), no
   *  de esta. */
  readonly limpiezaIniciadaEn: string;
  /** "Ahora" explícito (nunca `Date.now()` interno) -- ninguna foto puede fecharse en el
   *  futuro respecto a este momento. */
  readonly ahora: string;
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

function parseFechaOInvalida(iso: string, campo: string): number {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    throw new InspeccionVisionError("fecha_invalida", `${campo} no es una fecha ISO-8601 válida: "${iso}"`);
  }
  return ms;
}

/**
 * Evalúa el set de fotos de una inspección y produce una SUGERENCIA de veredicto
 * (nunca un cierre -- ver nota de alcance arriba). Determinístico: la misma entrada
 * siempre produce la misma salida.
 *
 * Corrección específica cuando:
 *   - falta alguna de las 6 fotos estándar, o sobra una foto con `tipo` no reconocido;
 *   - dos fotos del set estándar comparten la misma `url` (evidencia reciclada/copiada
 *     entre ranuras -- nunca dos fotos distintas son literalmente el mismo archivo);
 *   - una foto está fechada antes de `limpiezaIniciadaEn` (evidencia de OTRA limpieza) o
 *     después de `ahora` (fecha futura, dato corrupto o manipulado);
 *   - queda algún ítem del checklist propio de la tarea sin declarar cubierto.
 */
export function evaluateVisionInspection(input: EvaluateVisionInspectionInput): InspectionVisionOutcome {
  const inicioMs = parseFechaOInvalida(input.limpiezaIniciadaEn, "limpiezaIniciadaEn");
  const ahoraMs = parseFechaOInvalida(input.ahora, "ahora");
  if (ahoraMs < inicioMs) {
    throw new InspeccionVisionError("ventana_invalida", '"ahora" no puede ser anterior a "limpiezaIniciadaEn"');
  }

  const items: InspectionCorrectionItem[] = [];

  const requeridos = new Set<string>(STANDARD_INSPECTION_PHOTO_TYPES);
  const porTipo = new Map<string, InspectionPhotoSubmission>();
  const urlsVistas = new Map<string, string>(); // url -> primer tipo que la usó

  for (const foto of input.fotos) {
    if (!requeridos.has(foto.tipo)) {
      items.push({ tipo: foto.tipo, motivo: `tipo de foto no reconocido (esperado uno de: ${STANDARD_INSPECTION_PHOTO_TYPES.join(", ")})` });
      continue;
    }
    if (porTipo.has(foto.tipo)) {
      items.push({ tipo: foto.tipo, motivo: "más de una foto para el mismo tipo -- se esperaba exactamente una" });
      continue;
    }
    porTipo.set(foto.tipo, foto);

    const duplicadaDe = urlsVistas.get(foto.url);
    if (duplicadaDe) {
      items.push({ tipo: foto.tipo, motivo: `misma imagen ya usada para "${duplicadaDe}" -- cada foto del set debe ser distinta` });
    } else {
      urlsVistas.set(foto.url, foto.tipo);
    }

    const tomadaMs = parseFechaOInvalida(foto.tomadaEn, `fotos[].tomadaEn ("${foto.tipo}")`);
    if (tomadaMs < inicioMs) {
      items.push({ tipo: foto.tipo, motivo: "la foto es anterior al inicio de esta limpieza -- parece evidencia de otra limpieza" });
    } else if (tomadaMs > ahoraMs) {
      items.push({ tipo: foto.tipo, motivo: "la foto tiene fecha futura" });
    }
  }

  for (const tipoFaltante of STANDARD_INSPECTION_PHOTO_TYPES) {
    if (!porTipo.has(tipoFaltante)) {
      items.push({ tipo: tipoFaltante, motivo: "falta esta foto del set estándar" });
    }
  }

  const checklistNormalizado = input.checklist.map(normalizar).filter((c) => c.length > 0);
  const cubiertoNormalizado = new Set(input.checklistCubierto.map(normalizar));
  const checklistPendiente = input.checklist.filter((item) => !cubiertoNormalizado.has(normalizar(item)));
  for (const pendiente of checklistPendiente) {
    items.push({ tipo: "checklist", motivo: `checklist sin cubrir: "${pendiente}"` });
  }
  const checklistCubierto = checklistNormalizado.length === 0 ? [] : input.checklist.filter((item) => cubiertoNormalizado.has(normalizar(item)));

  return {
    veredicto: items.length === 0 ? "aprobada" : "correccion",
    items,
    checklistCubierto,
    checklistPendiente,
  };
}

// ---------------------------------------------------------------------------
// Muestreo de supervisión física (BP-101: 20-30% de las inspecciones).
// ---------------------------------------------------------------------------

/** Tasa objetivo del muestreo -- punto medio del rango 20-30% que pide BP-101/H11-004.
 *  Un valor fijo (no configurable por hotel) porque el criterio de aceptación mide el
 *  agregado, no una preferencia por propiedad. */
export const PHYSICAL_SUPERVISION_SAMPLE_RATE = 0.25;

/** FNV-1a de 32 bits -- mismo hash determinístico que `qa/conversationAudit.ts` usa
 *  para sembrar su PRNG; aquí basta un valor uniforme en [0,1) por id, sin necesitar
 *  Fisher-Yates (no se selecciona un tamaño fijo de un pool, cada inspección decide
 *  independientemente si le toca supervisión física). */
function hashToUnitInterval(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Decide, determinísticamente a partir de `taskId`, si esta inspección entra al
 * muestreo de supervisión física. Misma tarea → siempre la misma decisión (auditable);
 * sobre una población grande de tareas, la proporción marcada `true` converge a
 * `PHYSICAL_SUPERVISION_SAMPLE_RATE` (verificado por conteo en
 * `tests/unit/domain-hotel/inspeccion-vision.spec.ts`), dentro del rango 20-30% que
 * exige el criterio de aceptación.
 */
export function requiresPhysicalSupervision(taskId: string): boolean {
  return hashToUnitInterval(`housekeeping-vision-supervision::${taskId}`) < PHYSICAL_SUPERVISION_SAMPLE_RATE;
}

// ---------------------------------------------------------------------------
// Decisión final humana (BP-101: "apoyo, no veto"; 0 cierres automáticos).
// ---------------------------------------------------------------------------

export class PhysicalSupervisionNoteRequiredError extends InspeccionVisionError {
  constructor() {
    super(
      "nota_supervision_fisica_requerida",
      "esta inspección entró al muestreo de supervisión física (REQ-HK-003): el cierre debe " +
        "incluir una nota del supervisor documentando la revisión física, no solo confirmar la " +
        "sugerencia de la evidencia fotográfica",
    );
  }
}

/**
 * Guarda que exige nota humana no vacía cuando la tarea fue seleccionada para
 * supervisión física -- decisión final SIEMPRE humana (0 cierres automáticos sin
 * registro de supervisor), y para las tareas muestreadas, ese registro debe documentar
 * la revisión física real, no ser un clic vacío que solo repite el veredicto de la
 * evidencia. Para tareas fuera del muestreo, cualquier decisión humana (con o sin nota)
 * basta -- el criterio de aceptación exige la nota únicamente para el 20-30%
 * muestreado.
 */
export function assertHumanClosureAllowed(input: { requiresPhysicalSupervision: boolean; nota: string | null | undefined }): void {
  if (!input.requiresPhysicalSupervision) return;
  if (!input.nota || input.nota.trim().length === 0) {
    throw new PhysicalSupervisionNoteRequiredError();
  }
}
