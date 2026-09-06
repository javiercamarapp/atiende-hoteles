// auditoria-2/frontend [ALTO] · GET /hoteles/:hotelId/recepcion no existía: el panel
// (`apps/web/src/pages/Recepcion.tsx`, `listarMovimientosRecepcion`) llamaba una ruta
// que ningún archivo de `apps/api/src/routes/*.ts` registraba, y el 404 resultante se
// mostraba como "Pendiente de credenciales del PMS" -- atribución falsa, porque este
// dato NUNCA dependió de un PMS externo: `reservation_status_event` (0006_reservation.sql)
// ya es una bitácora append-only real, escrita por trigger en cada transición de
// `reservation.status` (incluida por `PATCH .../reservas/:id/transicion`, routes/reservas.ts).
// Este endpoint solo LEE esa bitácora para los movimientos de check-in/check-out del
// hotel -- ninguna integración pendiente, ningún dato inventado.
import { Hono } from "hono";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

interface MovimientoRow {
  id: string;
  huesped: string | null;
  habitacion: string;
  tipo: "check_in" | "check_out";
  hora: string;
  estado: string;
}

export function recepcionRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/recepcion",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // Últimos movimientos de check-in/check-out (turno actual y anterior, 100 más
  // recientes): `reservation_status_event` es la única fuente -- RLS ya restringe a las
  // filas del hotel autenticado (0006/0010), sin necesitar un filtro adicional de rol
  // (mismo criterio que `GET /hoteles/:hotelId/reservas`, ninguna de las dos usa
  // `assertRole`).
  app.get("/hoteles/:hotelId/recepcion", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<MovimientoRow>(
      `select e.id,
              g.full_name as huesped,
              rt.name as habitacion,
              e.to_status as tipo,
              to_char(e.created_at, 'HH24:MI') as hora,
              r.status::text as estado
       from public.reservation_status_event e
       join public.reservation r on r.id = e.reservation_id
       join public.room_type rt on rt.id = r.room_type_id
       left join public.guest g on g.id = r.guest_id
       where e.hotel_id = $1
         and e.to_status in ('check_in', 'check_out')
       order by e.created_at desc
       limit 100;`,
      [hotelId],
    );

    return c.json(
      rows.map((m) => ({
        id: m.id,
        huesped: m.huesped ?? "Sin huésped registrado",
        habitacion: m.habitacion,
        tipo: m.tipo === "check_in" ? "check-in" : "check-out",
        hora: m.hora,
        estado: m.estado,
      })),
    );
  });

  return app;
}
