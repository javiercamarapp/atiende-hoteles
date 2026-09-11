// REQ-RES-013 (P2/F, H02-014/H07-027): "El sistema debe dar seguimiento automático a
// solicitudes de grupo sin respuesta (48h y 7 días) y requerir validación humana
// obligatoria antes de enviar cualquier propuesta de RFP." Criterio de aceptación
// LITERAL (docs/ACEPTACION.md, fila REQ-RES-013): "Solicitud de grupo sin respuesta
// recibe seguimiento automático a las 48h y a los 7 días; ninguna propuesta de RFP sale
// sin un registro de validación humana previa (0 propuestas sin ese registro)."
//
// Puro, sin I/O (mismo criterio que tickets/slaPolicy.ts y fraude/deteccion.ts): el
// reloj SIEMPRE se recibe como parámetro, nunca `new Date()`/`Date.now()` interno, para
// que la ventana de 48h/7 días sea reproducible con "reloj simulado" en pruebas. Este
// módulo calcula CUÁNDO debe dispararse cada seguimiento y CUÁLES ya están vencidos, y
// expone el gate de validación humana como aserción reutilizable; la ejecución real
// (enviar el mensaje, escribir en la BD) vive en
// `apps/api/src/jobs/seguimientoSolicitudGrupo.ts`, misma separación dominio-puro /
// orquestador-con-I/O que `tickets/slaPolicy.ts` + `apps/api/src/jobs/ticketEscalation.ts`.

export const GROUP_FOLLOW_UP_TYPES = ["48h", "7d"] as const;
export type GroupFollowUpType = (typeof GROUP_FOLLOW_UP_TYPES)[number];

/** Horas desde la creación de la solicitud a las que corresponde cada seguimiento --
 *  literal del criterio de aceptación ("a las 48h y a los 7 días"), no una política de
 *  negocio configurable por hotel. */
export const GROUP_FOLLOW_UP_WINDOW_HOURS: Record<GroupFollowUpType, number> = {
  "48h": 48,
  "7d": 24 * 7,
};

export interface GroupFollowUpSchedule {
  tipo: GroupFollowUpType;
  programadoPara: Date;
}

/** Calcula los 2 seguimientos (48h y 7 días) a partir de la fecha de creación de la
 *  solicitud de grupo -- se llama UNA VEZ al crear la solicitud (ver
 *  `apps/api/src/routes/grupos.ts`) y las filas resultantes nunca se recalculan
 *  después: mover la ventana retroactivamente rompería la trazabilidad de cuándo se
 *  prometió dar seguimiento. */
export function computeGroupFollowUpSchedule(creadaEn: Date): GroupFollowUpSchedule[] {
  return GROUP_FOLLOW_UP_TYPES.map((tipo) => ({
    tipo,
    programadoPara: new Date(creadaEn.getTime() + GROUP_FOLLOW_UP_WINDOW_HOURS[tipo] * 60 * 60 * 1000),
  }));
}

export interface PendingGroupFollowUp {
  id: string;
  tipo: GroupFollowUpType;
  programadoPara: Date;
  ejecutadoEn: Date | null;
}

/** `true` si, al instante `now` (reloj inyectado, nunca `Date.now()` interno), un
 *  seguimiento programado ya debe dispararse: llegó su hora Y todavía no se ejecutó.
 *  Mismo criterio de "vencido" que `isSlaOverdue` de tickets/slaPolicy.ts, aplicado a
 *  una ventana fija (48h/7d) en vez de un SLA configurable por hotel. */
export function isGroupFollowUpDue(now: Date, followUp: Pick<PendingGroupFollowUp, "programadoPara" | "ejecutadoEn">): boolean {
  return followUp.ejecutadoEn === null && now.getTime() >= followUp.programadoPara.getTime();
}

/** Filtra, de una lista de seguimientos candidatos (normalmente los de todas las
 *  solicitudes `pendiente` de un hotel), los que ya deben dispararse al instante `now`.
 *  Preserva el orden de entrada (el llamador real ordena por `programado_para asc` en
 *  SQL antes de pasar la lista aquí). */
export function selectDueGroupFollowUps<T extends PendingGroupFollowUp>(now: Date, followUps: readonly T[]): T[] {
  return followUps.filter((f) => isGroupFollowUpDue(now, f));
}

// ---------------------------------------------------------------------------------
// Gate de validación humana previa a una propuesta de RFP
// ---------------------------------------------------------------------------------

export interface HumanValidationRecord {
  id: string;
  solicitudId: string;
  validadoEn: Date;
}

export class PropuestaRfpSinValidacionError extends Error {
  readonly code = "propuesta_rfp_sin_validacion_humana";
  constructor(message: string) {
    super(message);
    this.name = "PropuestaRfpSinValidacionError";
  }
}

/** Verificación de MEJOR ESFUERZO en la capa de aplicación (antes de siquiera intentar
 *  el INSERT) de que existe un registro de validación humana PREVIO para ESTA solicitud
 *  de grupo. La autoridad real e inapelable es el trigger de Postgres
 *  `propuesta_rfp_guard` (`packages/db/migrations/0130_seguimiento_solicitud_grupo.sql`,
 *  mismo criterio que `roi_baseline`/`cobro_resultado_activacion`, 0120): esta función
 *  solo existe para devolver un error 400 legible al staff en vez de que la única señal
 *  sea un error crudo de Postgres -- nunca sustituye al trigger como el gate de verdad
 *  (una llamada directa a SQL que se salte esta función igual queda bloqueada). */
export function assertHumanValidationBeforeProposal(
  solicitudId: string,
  validacion: HumanValidationRecord | null,
  now: Date,
): asserts validacion is HumanValidationRecord {
  if (validacion === null) {
    throw new PropuestaRfpSinValidacionError(
      `La solicitud de grupo ${solicitudId} no tiene ningún registro de validación humana -- no se puede enviar una propuesta de RFP sin esa validación previa (REQ-RES-013).`,
    );
  }
  if (validacion.solicitudId !== solicitudId) {
    throw new PropuestaRfpSinValidacionError(
      `El registro de validación humana ${validacion.id} corresponde a otra solicitud de grupo, no a ${solicitudId}.`,
    );
  }
  if (validacion.validadoEn.getTime() > now.getTime()) {
    throw new PropuestaRfpSinValidacionError(
      `El registro de validación humana ${validacion.id} quedó fechado después del envío de la propuesta -- la validación debe ser PREVIA, no simultánea ni posterior.`,
    );
  }
}
