// H2 · REQ-TEN-003/ADR-004: los 8 roles exactos de `hotel_staff.role`. Estas listas son
// el espejo, a nivel de aplicación, de las mismas funciones RLS de
// packages/db/migrations/0003_membership_and_rls_helpers.sql y 0007_folio.sql
// (`has_hotel_role`/`can_access_money`) — la autoridad final SIGUE SIENDO la RLS (si
// este espejo se desincroniza, la peor consecuencia es un 403 de más, nunca un acceso
// de más, porque la query de negocio corre igual bajo RLS real).
export const HOTEL_ROLES = [
  "owner",
  "gm",
  "frontdesk",
  "reservations",
  "housekeeping",
  "maintenance",
  "fnb",
  "accountant",
] as const;

export type HotelRole = (typeof HOTEL_ROLES)[number];

export const MONEY_ROLES: HotelRole[] = ["owner", "gm", "frontdesk", "reservations", "fnb", "accountant"];
export const MANAGE_INVENTORY_ROLES: HotelRole[] = ["owner", "gm", "reservations"];
export const MANAGE_RESERVATIONS_ROLES: HotelRole[] = ["owner", "gm", "frontdesk", "reservations"];
export const MANAGE_ROOM_STATUS_ROLES: HotelRole[] = ["owner", "gm", "frontdesk", "housekeeping", "maintenance"];
export const ADMIN_ROLES: HotelRole[] = ["owner", "gm"];
