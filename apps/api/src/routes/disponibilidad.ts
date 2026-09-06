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

const gridQuerySchema = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function disponibilidadRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/disponibilidad",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/disponibilidad/grid",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // H4 · GET .../disponibilidad/grid — desglose POR DÍA (a diferencia del endpoint de
  // arriba, que agrega todo el rango en un solo mínimo): alimenta la grilla
  // tipo-de-habitación × día de apps/web/src/pages/Disponibilidad.tsx.
  app.get("/hoteles/:hotelId/disponibilidad/grid", async (c) => {
    const parsed = gridQuerySchema.safeParse({ desde: c.req.query("desde"), hasta: c.req.query("hasta") });
    if (!parsed.success) throw Errors.validation("desde y hasta (YYYY-MM-DD) son obligatorios.");
    const { desde, hasta } = parsed.data;
    if (hasta < desde) throw Errors.validation("hasta debe ser posterior o igual a desde.");

    const db = c.get("db");
    const hotelId = c.req.param("hotelId");

    const { rows } = await db.query<{
      tipo_habitacion_id: string;
      tipo_habitacion: string;
      date: string;
      disponibles: number | null;
      total: number | null;
      tarifa: string | null;
      cerrado_llegada: boolean | null;
      cerrado_salida: boolean | null;
      min_stay: number | null;
    }>(
      `select
         rt.id as tipo_habitacion_id,
         rt.name as tipo_habitacion,
         d.date::date::text as date,
         (a.total_rooms - a.booked_rooms) as disponibles,
         a.total_rooms as total,
         r.price as tarifa,
         r.closed_to_arrival as cerrado_llegada,
         r.closed_to_departure as cerrado_salida,
         r.min_stay as min_stay
       from public.room_type rt
       cross join generate_series($2::date, $3::date, interval '1 day') as d(date)
       left join public.availability a on a.room_type_id = rt.id and a.date = d.date::date
       left join public.rate_plan r on r.room_type_id = rt.id and r.date = d.date::date
       where rt.hotel_id = $1
       order by rt.name asc, d.date::date asc;`,
      [hotelId, desde, hasta],
    );

    const porTipo = new Map<
      string,
      { tipoHabitacionId: string; tipoHabitacion: string; dias: { fecha: string; disponibles: number | null; total: number | null; tarifa: number | null; cerradoLlegada: boolean; cerradoSalida: boolean; estadiaMinima: number }[] }
    >();
    for (const r of rows) {
      if (!porTipo.has(r.tipo_habitacion_id)) {
        porTipo.set(r.tipo_habitacion_id, { tipoHabitacionId: r.tipo_habitacion_id, tipoHabitacion: r.tipo_habitacion, dias: [] });
      }
      porTipo.get(r.tipo_habitacion_id)!.dias.push({
        fecha: r.date,
        disponibles: r.disponibles,
        total: r.total,
        tarifa: r.tarifa != null ? Number(r.tarifa) : null,
        cerradoLlegada: r.cerrado_llegada ?? false,
        cerradoSalida: r.cerrado_salida ?? false,
        estadiaMinima: r.min_stay ?? 1,
      });
    }

    return c.json([...porTipo.values()]);
  });

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
