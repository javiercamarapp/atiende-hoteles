// H4 · GET /hoteles/:hotelId/ocupacion/calendario — grilla tipo-de-habitación × día para
// /disponibilidad (ENTREGA punto 3: "grid tipo-de-habitación × día con inventario y
// precio"), con la capacidad EFECTIVA (incluyendo sobreventa habilitada por umbral de
// ocupación, `@atiende-hoteles/domain-hotel` `effectiveCapacity()` — mismo cálculo que
// `book_availability` en packages/db/migrations/0013, aquí solo para mostrarlo, la
// autoridad real de si una reserva cabe sigue siendo esa función SQL bajo lock).
import { Hono } from "hono";
import { z } from "zod";
import { effectiveCapacity } from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");
const querySchema = z
  .object({ desde: dateSchema, hasta: dateSchema })
  .refine((v) => v.hasta >= v.desde, { message: "hasta debe ser igual o posterior a desde", path: ["hasta"] });

interface RoomTypeRow {
  id: string;
  name: string;
  max_overbook_rooms: number;
  overbooking_occupancy_threshold_pct: string;
}

interface AvailabilityRow {
  room_type_id: string;
  date: string;
  total_rooms: number;
  booked_rooms: number;
}

interface RateRow {
  room_type_id: string;
  date: string;
  price: string;
  min_stay: number;
  closed_to_arrival: boolean;
  closed_to_departure: boolean;
}

export function ocupacionRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/ocupacion/calendario",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/ocupacion/calendario", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const parsed = querySchema.safeParse({ desde: c.req.query("desde"), hasta: c.req.query("hasta") });
    if (!parsed.success) throw Errors.validation("desde/hasta (YYYY-MM-DD, hasta >= desde) son obligatorios.");
    const { desde, hasta } = parsed.data;

    const [{ rows: roomTypes }, { rows: availabilityRows }, { rows: rateRows }] = await Promise.all([
      db.query<RoomTypeRow>(
        "select id, name, max_overbook_rooms, overbooking_occupancy_threshold_pct from public.room_type where hotel_id = $1 order by name asc;",
        [hotelId],
      ),
      db.query<AvailabilityRow>(
        `select room_type_id, date::text as date, total_rooms, booked_rooms
         from public.availability where hotel_id = $1 and date between $2 and $3;`,
        [hotelId, desde, hasta],
      ),
      db.query<RateRow>(
        `select room_type_id, date::text as date, price, min_stay, closed_to_arrival, closed_to_departure
         from public.rate_plan where hotel_id = $1 and date between $2 and $3;`,
        [hotelId, desde, hasta],
      ),
    ]);

    const availabilityByKey = new Map(availabilityRows.map((r) => [`${r.room_type_id}:${r.date}`, r]));
    const rateByKey = new Map(rateRows.map((r) => [`${r.room_type_id}:${r.date}`, r]));

    const dates: string[] = [];
    const cursor = new Date(`${desde}T00:00:00Z`);
    const end = new Date(`${hasta}T00:00:00Z`);
    while (cursor <= end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const grid = roomTypes.map((rt) => {
      const overbookConfig = {
        maxOverbookRooms: rt.max_overbook_rooms,
        occupancyThresholdPct: Number(rt.overbooking_occupancy_threshold_pct),
      };

      const dias = dates.map((fecha) => {
        const avail = availabilityByKey.get(`${rt.id}:${fecha}`);
        const rate = rateByKey.get(`${rt.id}:${fecha}`);
        const totalRooms = avail?.total_rooms ?? null;
        const bookedRooms = avail?.booked_rooms ?? null;
        const capacidadEfectiva =
          totalRooms != null && bookedRooms != null ? effectiveCapacity(totalRooms, bookedRooms, overbookConfig) : null;

        return {
          fecha,
          totalHabitaciones: totalRooms,
          reservadas: bookedRooms,
          disponibles: capacidadEfectiva != null && bookedRooms != null ? capacidadEfectiva - bookedRooms : null,
          precio: rate ? Number(rate.price) : null,
          estadiaMinima: rate?.min_stay ?? null,
          cerradoLlegada: rate?.closed_to_arrival ?? false,
          cerradoSalida: rate?.closed_to_departure ?? false,
        };
      });

      return { roomTypeId: rt.id, roomTypeName: rt.name, dias };
    });

    return c.json({ desde, hasta, tiposHabitacion: grid });
  });

  return app;
}
