// H2 · GET /hoteles/:hotelId/disponibilidad — contrato apps/web `listarDisponibilidad()`
// (DisponibilidadFila[] = {tipoHabitacion, disponibles, total, tarifaDesde}) para una
// sola fecha (hoy, por defecto), y "rango por tipo de habitación" cuando se pasan
// `desde`/`hasta` (ISO, YYYY-MM-DD): `disponibles` es el mínimo del rango (peor caso: si
// alguna noche del rango no tiene cupo, el tipo de habitación se reporta como no
// disponible para TODO el rango, no solo esa noche) y `tarifaDesde` el precio mínimo.
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const querySchema = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export function disponibilidadRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/disponibilidad",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.get("/hoteles/:hotelId/disponibilidad", async (c) => {
    const parsed = querySchema.safeParse({ desde: c.req.query("desde"), hasta: c.req.query("hasta") });
    if (!parsed.success) throw Errors.validation("desde/hasta deben tener formato YYYY-MM-DD.");
    const desde = parsed.data.desde ?? null;
    const hasta = parsed.data.hasta ?? parsed.data.desde ?? null;
    if ((desde && !hasta) || (!desde && hasta)) throw Errors.validation("desde y hasta deben enviarse juntos.");

    const db = c.get("db");
    const hotelId = c.req.param("hotelId");

    const { rows } = await db.query<{
      tipo_habitacion_id: string;
      tipo_habitacion: string;
      disponibles: number | null;
      total: number | null;
      tarifa_desde: string | null;
    }>(
      `select
         rt.id as tipo_habitacion_id,
         rt.name as tipo_habitacion,
         min(a.total_rooms - a.booked_rooms) as disponibles,
         max(a.total_rooms) as total,
         min(r.price) as tarifa_desde
       from public.room_type rt
       left join public.availability a
         on a.room_type_id = rt.id and a.date between coalesce($2::date, current_date) and coalesce($3::date, current_date)
       left join public.rate_plan r
         on r.room_type_id = rt.id and r.date between coalesce($2::date, current_date) and coalesce($3::date, current_date)
       where rt.hotel_id = $1
       group by rt.id, rt.name
       order by rt.name asc;`,
      [hotelId, desde, hasta],
    );

    return c.json(
      rows.map((r) => ({
        tipoHabitacionId: r.tipo_habitacion_id,
        tipoHabitacion: r.tipo_habitacion,
        disponibles: r.disponibles,
        total: r.total,
        tarifaDesde: r.tarifa_desde != null ? Number(r.tarifa_desde) : null,
      })),
    );
  });

  return app;
}
