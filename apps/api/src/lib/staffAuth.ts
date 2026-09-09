// H5/REQ-AB-012 · Verificación server-side de rol administrativo para un actor OTRO
// que el que hace la solicitud (p.ej. frontdesk trae la autorización de un gm que no
// está logueado en esta sesión, o un dispositivo offline trae la autorización que un
// gm dio en persona). Extraído de `routes/folios.ts` (donde nació para
// REQ-REC-012/descuentos) para reutilizarlo también en `routes/fnbOfflineQueue.ts`
// (REQ-AB-003) sin duplicar la consulta -- nunca se confía en un rol que venga del
// cuerpo de la solicitud sin verificarlo contra `hotel_staff`.
import type { DbClient } from "@atiende-hoteles/db";
import { ADMIN_ROLES } from "../domain/roles.ts";

export async function isAdminStaff(db: DbClient, hotelId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ role: string }>(
    "select role from public.hotel_staff where hotel_id = $1 and user_id = $2;",
    [hotelId, userId],
  );
  return rows.length > 0 && (ADMIN_ROLES as string[]).includes(rows[0]!.role);
}
