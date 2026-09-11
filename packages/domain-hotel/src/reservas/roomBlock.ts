// REQ-RES-012 (P1/F, fuentes H01-008/H02-016/H05-013): "bloqueo de habitaciones (room
// block) y seguimiento de cut-off para grupos/bodas/eventos". Este módulo es el cálculo
// puro (sin I/O) de si un room block está en riesgo de attrition al acercarse su fecha
// de cut-off -- contraparte determinista de `apps/api/src/routes/grupos.ts` (que
// reserva/libera el inventario REAL en `public.availability` vía
// `book_availability`/`release_availability`, packages/db/migrations/0004, y persiste
// el estado en `public.room_block`, migración 0130).
//
// Alcance deliberado (para no fingir más de lo que este cierre construye): este módulo
// decide CUÁNDO un bloque necesita atención (H05-013, "notifica automáticamente cuando
// un bloque se acerca a su fecha de cut-off sin pickup suficiente") y CUÁNTAS
// habitaciones liberar tras el cut-off -- no genera el contrato en PDF (H02-016,
// "generar contrato") ni el seguimiento automático de la SOLICITUD de RFP sin responder
// (eso es REQ-RES-013, otra fila, con su propio job) ni el micrositio de bloque con
// pago por invitado (REQ-RES-014, ya bloqueada por credenciales de pasarela).

export const ROOM_BLOCK_STATUSES = ["activo", "liberado", "cerrado"] as const;
export type RoomBlockStatus = (typeof ROOM_BLOCK_STATUSES)[number];

export class RoomBlockError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RoomBlockError";
    this.code = code;
  }
}

/** H05-013 no fija un número exacto de días de anticipación -- se documenta aquí como
 *  constante única (mismo criterio que `GROUP_QUOTE_SLA_MINUTES` de groupQuote.ts) en
 *  vez de adivinarla distinto en cada llamador: una semana de aviso antes del cut-off es
 *  el estándar de la industria hotelera para poder re-vender el inventario liberado. */
export const CUTOFF_WARNING_WINDOW_DAYS = 7;

/** Debajo de este % de pickup, un bloque a punto de llegar a su cut-off se considera en
 *  riesgo real de attrition (no solo "todavía falta gente por confirmar"). */
export const CUTOFF_MIN_PICKUP_PCT = 80;

export function assertValidPickup(roomsBlocked: number, roomsPickedUp: number): void {
  if (!Number.isInteger(roomsBlocked) || roomsBlocked <= 0) {
    throw new RoomBlockError("bloque_invalido", `roomsBlocked debe ser un entero positivo, recibido ${roomsBlocked}.`);
  }
  if (!Number.isInteger(roomsPickedUp) || roomsPickedUp < 0) {
    throw new RoomBlockError("pickup_invalido", `roomsPickedUp debe ser un entero no negativo, recibido ${roomsPickedUp}.`);
  }
  if (roomsPickedUp > roomsBlocked) {
    throw new RoomBlockError(
      "pickup_excede_bloqueo",
      `roomsPickedUp (${roomsPickedUp}) no puede exceder roomsBlocked (${roomsBlocked}) -- eso indicaría más reservas confirmadas que habitaciones bloqueadas.`,
    );
  }
}

/** Días completos entre `asOfDate` y `cutoffDate` (YYYY-MM-DD) -- negativo si el
 *  cut-off ya pasó. Comparación puramente calendario (sin hora), mismo criterio que
 *  `nightsBetween` de quote.ts. */
export function daysUntilCutoff(cutoffDate: string, asOfDate: string): number {
  const cutoff = new Date(`${cutoffDate}T00:00:00Z`).getTime();
  const asOf = new Date(`${asOfDate}T00:00:00Z`).getTime();
  return Math.round((cutoff - asOf) / (24 * 60 * 60 * 1000));
}

export function pickupPct(roomsBlocked: number, roomsPickedUp: number): number {
  assertValidPickup(roomsBlocked, roomsPickedUp);
  return (roomsPickedUp / roomsBlocked) * 100;
}

export type CutoffAlertLevel = "ninguna" | "atencion" | "critica";

export interface CutoffAlertEvaluation {
  readonly daysUntilCutoff: number;
  readonly pickupPct: number;
  readonly alertLevel: CutoffAlertLevel;
  readonly reason: string;
}

/**
 * H05-013: evalúa si un room block necesita atención por acercarse a su cut-off sin
 * pickup suficiente.
 *  - "critica": el cut-off YA PASÓ (`daysUntilCutoff <= 0`) con pickup insuficiente --
 *    el inventario no confirmado debe liberarse ya (ver `roomsToRelease`).
 *  - "atencion": el cut-off está dentro de `CUTOFF_WARNING_WINDOW_DAYS` con pickup
 *    insuficiente -- todavía hay margen para recordarle al grupo/GM.
 *  - "ninguna": fuera de la ventana de aviso, o pickup ya suficiente (>= umbral) --
 *    nunca se alerta por un bloque que ya cumplió su meta de pickup, sin importar qué
 *    tan cerca esté el cut-off.
 */
export function evaluateCutoffAlert(params: {
  roomsBlocked: number;
  roomsPickedUp: number;
  cutoffDate: string;
  asOfDate: string;
  warningWindowDays?: number;
  minPickupPct?: number;
}): CutoffAlertEvaluation {
  const warningWindowDays = params.warningWindowDays ?? CUTOFF_WARNING_WINDOW_DAYS;
  const minPickupPct = params.minPickupPct ?? CUTOFF_MIN_PICKUP_PCT;
  const pct = pickupPct(params.roomsBlocked, params.roomsPickedUp);
  const days = daysUntilCutoff(params.cutoffDate, params.asOfDate);

  if (pct >= minPickupPct) {
    return {
      daysUntilCutoff: days,
      pickupPct: pct,
      alertLevel: "ninguna",
      reason: `pickup_suficiente: ${pct.toFixed(1)}% >= ${minPickupPct}% del bloque ya confirmado.`,
    };
  }

  if (days <= 0) {
    return {
      daysUntilCutoff: days,
      pickupPct: pct,
      alertLevel: "critica",
      reason: `cutoff_vencido: la fecha de cut-off ya pasó (hace ${Math.abs(days)} día(s)) con solo ${pct.toFixed(1)}% de pickup -- liberar el inventario no confirmado.`,
    };
  }

  if (days <= warningWindowDays) {
    return {
      daysUntilCutoff: days,
      pickupPct: pct,
      alertLevel: "atencion",
      reason: `cutoff_proximo: faltan ${days} día(s) para el cut-off y solo ${pct.toFixed(1)}% de pickup (mínimo esperado ${minPickupPct}%).`,
    };
  }

  return {
    daysUntilCutoff: days,
    pickupPct: pct,
    alertLevel: "ninguna",
    reason: `fuera_de_ventana: faltan ${days} día(s) para el cut-off, todavía fuera de la ventana de aviso de ${warningWindowDays} día(s).`,
  };
}

/** Habitaciones a devolver a `public.availability` (vía `release_availability`) cuando
 *  el cut-off ya pasó: todo lo bloqueado que nadie recogió. Nunca negativo -- un bloque
 *  con pickup completo (o sobre-pickeado, que ya se rechaza en `assertValidPickup`) no
 *  libera nada. */
export function roomsToRelease(roomsBlocked: number, roomsPickedUp: number): number {
  assertValidPickup(roomsBlocked, roomsPickedUp);
  return Math.max(0, roomsBlocked - roomsPickedUp);
}

export function isValidRoomBlockStatus(value: string): value is RoomBlockStatus {
  return (ROOM_BLOCK_STATUSES as readonly string[]).includes(value);
}
