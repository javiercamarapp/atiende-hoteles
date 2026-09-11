// REQ-OBS-008 (P2/OBS): "el sistema debe instrumentar y reportar el % de room-nights
// generadas directamente por agentes de IA como métrica de producto [periódica]"
// (H06-016; BP-169 la llama "métrica norte comercial ... KPI de la tesis agéntica").
// Módulo de dominio PURO (mismo principio de separación que
// `reservas/atribucionCanal.ts`): sin I/O, solo la aritmética sobre filas ya
// agregadas por `apps/api/src/domain/atribucionOrigenAgentico.ts`.
//
// Distinción deliberada con REQ-RES-020/`atribucionCanal.ts`: ese módulo mide POR
// CANAL de distribución (directo/OTA/agente externo que reserva a nombre del huésped).
// Este mide un eje ORTOGONAL: POR ACTOR que creó la reserva dentro del propio flujo del
// producto (staff humano vía panel, o el agente de IA propio del hotel vía conversación
// directa). Una reserva de canal 'directo' puede haber sido tecleada por staff o
// generada por el agente -- ese es exactamente el dato que este KPI aísla, porque es la
// prueba de que EL AGENTE (no solo "el hotel sin intermediario") está generando
// negocio.
//
// Import HONESTO (mismo criterio que `atribucionCanal.ts`): hoy NINGÚN escritor de este
// repo produce `origin_actor = 'agente_ia'` -- el único endpoint de creación de reservas
// exige sesión de staff autenticado (ver migración 0130). Este módulo no inventa ni
// simula esa diversidad; calcula correctamente sobre lo que exista en la columna,
// listo para cuando un flujo de reserva conversacional directa (REQ-AGT/REQ-RES
// futuro, fuera de alcance de este cierre) empiece a escribir 'agente_ia'.
import { roundCurrency } from "../money.ts";

/** Único actor que cualquier escritor de este repo produce hoy (ver migración 0130). */
export const MANUAL_ORIGIN_ACTOR = "manual";
/** Actor que un flujo de reserva conversacional directa (aún no construido) escribirá
 *  el día que exista. */
export const AGENTIC_ORIGIN_ACTOR = "agente_ia";

export function isAgenticOrigin(originActor: string): boolean {
  return originActor === AGENTIC_ORIGIN_ACTOR;
}

export interface ReservationOriginInput {
  readonly id: string;
  /** `reservation.origin_actor` (migración 0130): 'manual' | 'agente_ia'. */
  readonly originActor: string;
  /** Número de noches de la reserva (>= 1). */
  readonly nights: number;
}

export interface OriginActorSummary {
  readonly originActor: string;
  readonly reservationCount: number;
  readonly roomNights: number;
}

export interface AgenticOriginReport {
  readonly origins: OriginActorSummary[];
  readonly totalReservations: number;
  readonly totalRoomNights: number;
  /** Room-nights cuyo `origin_actor` es 'agente_ia' -- el numerador exacto del KPI de
   *  H06-016/BP-169. */
  readonly agenticRoomNights: number;
  /** 0..100. `0` (no `NaN`) cuando no hay reservas en el periodo -- mismo criterio de
   *  REQ-UX-002 que ya aplica `atribucionCanal.ts`: el llamador decide si mostrar "sin
   *  datos" con `totalReservations === 0`, este módulo nunca devuelve un valor no
   *  numérico. */
  readonly agenticRoomNightsPct: number;
}

/**
 * Agrega reservas por actor de origen: cuenta de reservas y room-nights por actor, más
 * el KPI de producto que pide el requisito -- room-nights agénticas (absoluto) y su %
 * sobre el total de room-nights del periodo.
 */
export function buildAgenticOriginReport(reservations: readonly ReservationOriginInput[]): AgenticOriginReport {
  const byActor = new Map<string, { count: number; nights: number }>();
  for (const r of reservations) {
    const acc = byActor.get(r.originActor) ?? { count: 0, nights: 0 };
    acc.count += 1;
    acc.nights += r.nights;
    byActor.set(r.originActor, acc);
  }

  const origins: OriginActorSummary[] = [...byActor.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([originActor, acc]) => ({
      originActor,
      reservationCount: acc.count,
      roomNights: acc.nights,
    }));

  const totalRoomNights = origins.reduce((sum, o) => sum + o.roomNights, 0);
  const agenticRoomNights = origins.find((o) => o.originActor === AGENTIC_ORIGIN_ACTOR)?.roomNights ?? 0;

  return {
    origins,
    totalReservations: reservations.length,
    totalRoomNights,
    agenticRoomNights,
    agenticRoomNightsPct: totalRoomNights > 0 ? roundCurrency((agenticRoomNights / totalRoomNights) * 100) : 0,
  };
}
