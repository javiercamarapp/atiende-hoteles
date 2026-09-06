// H4 · Espejo, a nivel de aplicación, de la máquina de estados REAL de
// `packages/db/migrations/0006_reservation.sql` (`reservation_status_transition` +
// trigger `reservation_validate_transition`). La autoridad final SIGUE SIENDO la base
// de datos (mismo criterio que `apps/api/src/domain/roles.ts` para los roles) — este
// módulo permite validar/explicar una transición ANTES de pagar el costo de un
// round-trip a Postgres, y documentar qué rol puede ejecutar cada una.
export const RESERVATION_STATUSES = [
  "cotizada",
  "confirmada",
  "check_in",
  "en_estancia",
  "check_out",
  "cerrada",
  "cancelada",
  "no_show",
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export type HotelRoleLike =
  | "owner"
  | "gm"
  | "frontdesk"
  | "reservations"
  | "housekeeping"
  | "maintenance"
  | "fnb"
  | "accountant"
  /** Job automático (no-show), nunca un usuario humano — ver jobs/noShow.ts de apps/api. */
  | "system";

const TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  cotizada: ["confirmada", "cancelada"],
  confirmada: ["check_in", "cancelada", "no_show"],
  check_in: ["en_estancia"],
  en_estancia: ["check_out"],
  check_out: ["cerrada"],
  cerrada: [],
  cancelada: [],
  no_show: [],
};

/** Roles habilitados para ejecutar cada transición. La RLS de packages/db no distingue
 *  el rol POR transición (cualquier `MANAGE_RESERVATIONS_ROLES` puede escribir
 *  `reservation.status`) — esta tabla es una política de aplicación más fina, exigida
 *  por el encargo ("quién puede hacerlas por rol"), verificada en apps/api. */
const ROLE_TRANSITIONS: Record<string, HotelRoleLike[]> = {
  "cotizada->confirmada": ["owner", "gm", "frontdesk", "reservations"],
  "cotizada->cancelada": ["owner", "gm", "frontdesk", "reservations"],
  "confirmada->check_in": ["owner", "gm", "frontdesk"],
  "confirmada->cancelada": ["owner", "gm", "frontdesk", "reservations"],
  "confirmada->no_show": ["owner", "gm", "frontdesk", "reservations", "system"],
  "check_in->en_estancia": ["owner", "gm", "frontdesk"],
  "en_estancia->check_out": ["owner", "gm", "frontdesk"],
  "check_out->cerrada": ["owner", "gm", "frontdesk", "accountant"],
};

export function isValidStatus(value: string): value is ReservationStatus {
  return (RESERVATION_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: ReservationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function allowedNextStatuses(from: ReservationStatus): ReservationStatus[] {
  return [...TRANSITIONS[from]];
}

export function rolesAllowedForTransition(from: ReservationStatus, to: ReservationStatus): HotelRoleLike[] {
  return ROLE_TRANSITIONS[`${from}->${to}`] ?? [];
}

export function canRolePerformTransition(role: HotelRoleLike, from: ReservationStatus, to: ReservationStatus): boolean {
  return canTransition(from, to) && rolesAllowedForTransition(from, to).includes(role);
}

/** Estados desde los que una reserva todavía admite modificar fechas/tipo de
 *  habitación o cancelarse — antes de que el huésped haya hecho check-in. */
export function isModifiable(status: ReservationStatus): boolean {
  return status === "cotizada" || status === "confirmada";
}

export function isCancellable(status: ReservationStatus): boolean {
  return status === "cotizada" || status === "confirmada";
}
