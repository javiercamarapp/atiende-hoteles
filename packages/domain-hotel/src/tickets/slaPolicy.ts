// REQ-HUE-014: "Cada mensaje/petición del huésped (WhatsApp, voz, QR) debe convertirse
// en un ticket con departamento, habitación, prioridad y SLA [...]; un ticket sin cierre
// dentro del SLA debe escalar automáticamente." (docs/REQUISITOS.md). El criterio de
// aceptación real (docs/ACEPTACION.md, fila REQ-HUE-014) declara "Depende de
// credenciales: No" y prescribe una prueba de integración puramente de dominio/SLA
// (`tests/integration/tickets/sla-escalado.spec.ts`) -- a propósito NO habla de
// WhatsApp/voz/QR en el criterio verificable: el canal de INGRESO del mensaje (ese sí
// depende de credenciales reales de Meta/Telnyx, ver REQ-HUE-001/002/004, marcados
// aparte como "pendiente-credenciales") es una preocupación distinta de la CONVERSIÓN
// mensaje→ticket y de la ESCALACIÓN por SLA, que son reglas de negocio 100% internas y
// las que este módulo (+ `packages/agent-core/src/tools/ticketTools.ts` +
// `apps/api/src/jobs/ticketEscalation*.ts`) implementa y prueba contra
// PGlite/embedded-postgres real (ADR-003). Por eso `docs/TRAZABILIDAD.md` clasificaba
// antes este REQ como "pendiente-credenciales" citando el inventario de
// `docs/cierre-p0/inventario.md` §2 (una generalización de TODOS los REQ-HUE-* que
// mencionan WhatsApp/voz en su prosa) -- esa fila queda corregida al cerrar este REQ
// (mismo criterio de reclasificación ya aplicado antes a REQ-BO-024, ver ese inventario
// §2 "corrección").
//
// Puro, determinístico, sin I/O (mismo principio que fraude/deteccion.ts y
// reputacion/clasificador.ts): nada aquí llama a un LLM ni a un reloj real -- el reloj
// SIEMPRE se recibe como parámetro (`Date`), nunca `new Date()`/`Date.now()` internos,
// para que tanto la clasificación como el vencimiento de SLA sean 100% reproducibles en
// pruebas con "reloj simulado" (mismo patrón de inyección de `now` que
// `apps/api/src/jobs/nightAuditScheduler.ts`).

/** Subconjunto de `public.hotel_role` (REQ-TEN-003, "8 roles hoteleros exactos") que
 *  puede recibir un ticket generado a partir de un mensaje de huésped -- se reutiliza
 *  el mismo enum de roles en vez de inventar una taxonomía de "departamento" paralela
 *  (el mismo error que docs/auditoria-0/documentos.md ya encontró una vez con
 *  "hotel" como raíz duplicada). La columna `guest_ticket.department` en Postgres
 *  acepta cualquiera de los 8 roles (un ticket puede reasignarse a mano a
 *  `accountant`/`owner`/`gm` si hace falta); este tipo más estrecho es solo el
 *  resultado por defecto de `classifyGuestMessage`.
 */
export const GUEST_TICKET_DEPARTMENTS = ["frontdesk", "housekeeping", "maintenance", "fnb", "reservations"] as const;
export type GuestTicketDepartment = (typeof GUEST_TICKET_DEPARTMENTS)[number];

export const GUEST_TICKET_PRIORITIES = ["alta", "media", "baja"] as const;
export type GuestTicketPriority = (typeof GUEST_TICKET_PRIORITIES)[number];

export interface GuestMessageClassification {
  department: GuestTicketDepartment;
  priority: GuestTicketPriority;
}

/** Quita acentos/diacríticos y normaliza a minúsculas -- mismo criterio de
 *  normalización que `reputacion/clasificador.ts::normalizar`, reimplementado aquí (sin
 *  importar ese módulo) porque pertenecen a dos contextos de dominio distintos
 *  (reseñas post-estancia vs. peticiones en vivo del huésped) que no deben acoplarse
 *  por una utilidad compartida accidental. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function contieneAlguna(textoNormalizado: string, frases: readonly string[]): boolean {
  return frases.some((frase) => textoNormalizado.includes(frase));
}

const DEPARTMENT_KEYWORDS: Record<GuestTicketDepartment, readonly string[]> = {
  maintenance: [
    "aire acondicionado", "climatizacion", "minisplit", "clima no", "no enfria",
    "fuga", "gotea", "goteando", "inundacion", "no hay luz", "no prende", "no funciona",
    "foco fundido", "electricidad", "cortocircuito", "television", "tv no", "control remoto",
    "cerradura", "no abre la puerta", "puerta no cierra", "sin agua caliente", "regadera",
    "plomeria", "tuberia", "huele a gas",
  ],
  housekeeping: [
    "toalla", "toallas", "sabana", "sabanas", "limpieza", "limpiar mi habitacion",
    "esta sucio", "esta sucia", "basura", "shampoo", "jabon", "amenidades", "papel higienico",
    "cambiar sabanas", "tender la cama",
  ],
  fnb: [
    "room service", "servicio a la habitacion", "restaurante", "desayuno", "comida",
    "bebida", "bar del hotel", "menu",
  ],
  reservations: [
    "mi reserva", "factura", "cambiar mi fecha", "late checkout", "checkout tardio",
    "upgrade de habitacion", "cambio de habitacion por reserva",
  ],
  frontdesk: [],
};

const HIGH_PRIORITY_KEYWORDS = [
  "emergencia", "urgente", "ahora mismo", "inundacion", "huele a gas", "incendio",
  "no hay luz", "sin luz", "atrapado", "atrapada", "no puedo salir", "fuga de agua",
];
const LOW_PRIORITY_KEYWORDS = ["cuando puedan", "no es urgente", "sin prisa", "cuando tengan tiempo"];

/** Clasificación heurística de MEJOR ESFUERZO de un mensaje/petición libre del
 *  huésped en (departamento, prioridad) -- usada como valor por defecto SOLO cuando
 *  quien crea el ticket (agente conversacional o staff transcribiendo una petición) no
 *  indica explícitamente el departamento/prioridad ya conocidos (p. ej. un formulario
 *  de QR con selector de categoría no necesita adivinar nada). Determinístico: el mismo
 *  texto siempre produce la misma clasificación, sin LLM ni servicio externo -- un falso
 *  negativo aquí (mensaje ambiguo cae en 'frontdesk'/'media') nunca bloquea la creación
 *  del ticket, solo su enrutamiento inicial, que el staff puede corregir a mano
 *  (`PATCH .../reasignar`). */
export function classifyGuestMessage(message: string): GuestMessageClassification {
  const normalized = normalizar(message);

  let department: GuestTicketDepartment = "frontdesk";
  for (const dept of GUEST_TICKET_DEPARTMENTS) {
    const keywords = DEPARTMENT_KEYWORDS[dept];
    if (keywords.length > 0 && contieneAlguna(normalized, keywords)) {
      department = dept;
      break;
    }
  }

  let priority: GuestTicketPriority = "media";
  if (contieneAlguna(normalized, HIGH_PRIORITY_KEYWORDS)) {
    priority = "alta";
  } else if (contieneAlguna(normalized, LOW_PRIORITY_KEYWORDS)) {
    priority = "baja";
  }

  return { department, priority };
}

/** SLA por defecto (minutos) cuando el hotel no configuró una política propia para esa
 *  combinación (departamento, prioridad) en `ticket_sla_policy` -- placeholder
 *  razonable (mismo espíritu documentado que `DEFAULT_CONVERSATION_RETENTION_DAYS` de
 *  `purgeConversations.ts`: un número de negocio que el hotel puede sobreescribir, nunca
 *  el plazo definitivo de nadie). 30 min/2 h/8 h para alta/media/baja respectivamente. */
export const DEFAULT_SLA_MINUTES_BY_PRIORITY: Record<GuestTicketPriority, number> = {
  alta: 30,
  media: 120,
  baja: 480,
};

/** Minutos de SLA a aplicar: la política configurada por el hotel para
 *  (departamento, prioridad) si existe, si no el default de arriba por prioridad. */
export function resolveSlaMinutes(configuredMinutes: number | null | undefined, priority: GuestTicketPriority): number {
  if (configuredMinutes != null && configuredMinutes > 0) return configuredMinutes;
  return DEFAULT_SLA_MINUTES_BY_PRIORITY[priority];
}

/** Fecha límite de SLA = fecha de creación + minutos de SLA. */
export function computeSlaDueAt(createdAt: Date, slaMinutes: number): Date {
  return new Date(createdAt.getTime() + slaMinutes * 60_000);
}

/** `true` si, al instante `now` (reloj inyectado, nunca `Date.now()` interno), el
 *  ticket ya superó su `slaDueAt` sin cerrarse. */
export function isSlaOverdue(now: Date, slaDueAt: Date): boolean {
  return now.getTime() > slaDueAt.getTime();
}
