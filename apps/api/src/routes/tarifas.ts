// H4 · Tarifas/planes por temporada (`rate_plan`), impuestos (`hotel_tax_config`),
// política de cancelación (`hotel_cancellation_policy`) y sobreventa por tipo de
// habitación (`room_type.max_overbook_rooms`/`overbooking_occupancy_threshold_pct`).
// Todo lo que aquí se escribe alimenta directamente al motor de cotización determinista
// (`routes/quotes.ts`) — nunca hay una ruta paralela que deje fijar un precio/impuesto
// por otra vía (REQ-REV-001).
//
// Rol requerido para escribir: la matriz de 8 roles de REQ-TEN-003 no tiene un rol
// "revenue" dedicado (docs/PROGRESO.md H4 documenta esta correspondencia); tarifas se
// mapean a `MANAGE_INVENTORY_ROLES` (owner/gm/reservations, mismos que ya pueden
// escribir `rate_plan`/`availability` en la RLS de 0004) e impuestos/política de
// cancelación/sobreventa a `ADMIN_ROLES` (owner/gm, igual que la RLS de 0013 exige).
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MANAGE_INVENTORY_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");

const listQuerySchema = z.object({
  roomTypeId: z.string().uuid().optional(),
  desde: dateSchema.optional(),
  hasta: dateSchema.optional(),
});

// `date` es un atajo para una sola noche (equivalente a `desde === hasta === date`);
// `desde`/`hasta` cubren un rango ("temporada") en una sola llamada. Exactamente una de
// las dos formas debe venir en el body.
const upsertRateSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    date: dateSchema.optional(),
    desde: dateSchema.optional(),
    hasta: dateSchema.optional(),
    price: z.number().nonnegative(),
    minStay: z.number().int().positive().default(1),
    closedToArrival: z.boolean().default(false),
    closedToDeparture: z.boolean().default(false),
  })
  .transform((v) => ({
    ...v,
    desde: v.desde ?? v.date ?? v.hasta,
    hasta: v.hasta ?? v.date ?? v.desde,
  }))
  .refine((v) => v.desde !== undefined && v.hasta !== undefined, {
    message: "envía 'date' (una sola noche) o 'desde'/'hasta' (rango)",
    path: ["date"],
  })
  .refine((v) => v.hasta! >= v.desde!, { message: "hasta debe ser igual o posterior a desde", path: ["hasta"] })
  .transform((v) => ({ ...v, desde: v.desde as string, hasta: v.hasta as string }));

const taxConfigSchema = z.object({
  ivaRate: z.number().min(0).max(1),
  ishRate: z.number().min(0).max(1),
});

const cancellationPolicySchema = z.object({
  freeUntilHours: z.number().int().min(0),
  penaltyPct: z.number().min(0).max(100),
  noShowPct: z.number().min(0).max(100),
  depositPct: z.number().min(0).max(100),
});

const overbookingSchema = z.object({
  maxOverbookRooms: z.number().int().min(0),
  occupancyThresholdPct: z.number().min(0).max(100),
});

function datesInRange(desde: string, hasta: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${desde}T00:00:00Z`);
  const end = new Date(`${hasta}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function tarifasRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use("/hoteles/:hotelId/tarifas*", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));
  app.use("/hoteles/:hotelId/impuestos*", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));
  app.use(
    "/hoteles/:hotelId/politica-cancelacion*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/tipos-habitacion/:roomTypeId/sobreventa",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // ---- rate_plan (tarifas por temporada) ----

  app.get("/hoteles/:hotelId/tarifas", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const parsed = listQuerySchema.safeParse({
      roomTypeId: c.req.query("roomTypeId") || undefined,
      desde: c.req.query("desde") || undefined,
      hasta: c.req.query("hasta") || undefined,
    });
    if (!parsed.success) throw Errors.validation("Parámetros de consulta inválidos.");
    const { roomTypeId, desde, hasta } = parsed.data;

    const { rows } = await db.query<{
      id: string;
      room_type_id: string;
      date: string;
      price: string;
      currency: string;
      min_stay: number;
      closed_to_arrival: boolean;
      closed_to_departure: boolean;
    }>(
      `select id, room_type_id, date::text as date, price, currency, min_stay, closed_to_arrival, closed_to_departure
       from public.rate_plan
       where hotel_id = $1
         and ($2::uuid is null or room_type_id = $2)
         and ($3::date is null or date >= $3)
         and ($4::date is null or date <= $4)
       order by room_type_id asc, date asc;`,
      [hotelId, roomTypeId ?? null, desde ?? null, hasta ?? null],
    );

    return c.json(
      rows.map((r) => ({
        id: r.id,
        roomTypeId: r.room_type_id,
        fecha: r.date,
        precio: Number(r.price),
        moneda: r.currency,
        estadiaMinima: r.min_stay,
        cerradoLlegada: r.closed_to_arrival,
        cerradoSalida: r.closed_to_departure,
      })),
    );
  });

  app.put("/hoteles/:hotelId/tarifas", async (c) => {
    assertRole(c, MANAGE_INVENTORY_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(upsertRateSchema, await c.req.json().catch(() => ({})));

    const { rows: roomTypeRows } = await db.query<{ id: string }>(
      "select id from public.room_type where id = $1 and hotel_id = $2;",
      [body.roomTypeId, hotelId],
    );
    if (roomTypeRows.length === 0) throw Errors.notFound("Tipo de habitación no encontrado en este hotel.");

    const dates = datesInRange(body.desde, body.hasta);
    for (const date of dates) {
      await db.query(
        `insert into public.rate_plan
           (tenant_id, hotel_id, room_type_id, date, price, min_stay, closed_to_arrival, closed_to_departure)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (room_type_id, date) do update
           set price = excluded.price,
               min_stay = excluded.min_stay,
               closed_to_arrival = excluded.closed_to_arrival,
               closed_to_departure = excluded.closed_to_departure,
               updated_at = now();`,
        [orgId, hotelId, body.roomTypeId, date, body.price, body.minStay, body.closedToArrival, body.closedToDeparture],
      );
    }

    await db.query(
      "select public.record_audit_log($1, $2, 'rate_plan.updated', 'room_type', $3, $4);",
      [orgId, hotelId, body.roomTypeId, JSON.stringify({ desde: body.desde, hasta: body.hasta, price: body.price })],
    );

    return c.json({ roomTypeId: body.roomTypeId, fechasActualizadas: dates.length });
  });

  // ---- Impuestos por hotel ----

  app.get("/hoteles/:hotelId/impuestos", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ iva_rate: string; ish_rate: string }>(
      "select iva_rate, ish_rate from public.hotel_tax_config where hotel_id = $1;",
      [c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Este hotel no tiene impuestos configurados todavía.");
    return c.json({ ivaRate: Number(rows[0]!.iva_rate), ishRate: Number(rows[0]!.ish_rate) });
  });

  app.put("/hoteles/:hotelId/impuestos", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(taxConfigSchema, await c.req.json().catch(() => ({})));

    await db.query(
      `insert into public.hotel_tax_config (tenant_id, hotel_id, iva_rate, ish_rate)
       values ($1, $2, $3, $4)
       on conflict (hotel_id) do update set iva_rate = excluded.iva_rate, ish_rate = excluded.ish_rate, updated_at = now();`,
      [orgId, hotelId, body.ivaRate, body.ishRate],
    );
    await db.query(
      "select public.record_audit_log($1, $2, 'hotel_tax_config.updated', 'hotel', $2, $3);",
      [orgId, hotelId, JSON.stringify(body)],
    );

    return c.json(body);
  });

  // ---- Política de cancelación ----

  app.get("/hoteles/:hotelId/politica-cancelacion", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{
      free_until_hours: number;
      penalty_pct: string;
      no_show_pct: string;
      deposit_pct: string;
    }>(
      "select free_until_hours, penalty_pct, no_show_pct, deposit_pct from public.hotel_cancellation_policy where hotel_id = $1;",
      [c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Este hotel no tiene política de cancelación configurada todavía.");
    const r = rows[0]!;
    return c.json({
      freeUntilHours: r.free_until_hours,
      penaltyPct: Number(r.penalty_pct),
      noShowPct: Number(r.no_show_pct),
      depositPct: Number(r.deposit_pct),
    });
  });

  app.put("/hoteles/:hotelId/politica-cancelacion", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(cancellationPolicySchema, await c.req.json().catch(() => ({})));

    await db.query(
      `insert into public.hotel_cancellation_policy
         (tenant_id, hotel_id, free_until_hours, penalty_pct, no_show_pct, deposit_pct)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (hotel_id) do update
         set free_until_hours = excluded.free_until_hours,
             penalty_pct = excluded.penalty_pct,
             no_show_pct = excluded.no_show_pct,
             deposit_pct = excluded.deposit_pct,
             updated_at = now();`,
      [orgId, hotelId, body.freeUntilHours, body.penaltyPct, body.noShowPct, body.depositPct],
    );
    await db.query(
      "select public.record_audit_log($1, $2, 'hotel_cancellation_policy.updated', 'hotel', $2, $3);",
      [orgId, hotelId, JSON.stringify(body)],
    );

    return c.json(body);
  });

  // ---- Sobreventa por tipo de habitación ----

  app.get("/hoteles/:hotelId/tipos-habitacion/:roomTypeId/sobreventa", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ max_overbook_rooms: number; overbooking_occupancy_threshold_pct: string }>(
      "select max_overbook_rooms, overbooking_occupancy_threshold_pct from public.room_type where id = $1 and hotel_id = $2;",
      [c.req.param("roomTypeId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Tipo de habitación no encontrado.");
    return c.json({
      maxOverbookRooms: rows[0]!.max_overbook_rooms,
      occupancyThresholdPct: Number(rows[0]!.overbooking_occupancy_threshold_pct),
    });
  });

  app.patch("/hoteles/:hotelId/tipos-habitacion/:roomTypeId/sobreventa", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const roomTypeId = c.req.param("roomTypeId");
    const body = parseBody(overbookingSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<{ id: string }>(
      `update public.room_type
       set max_overbook_rooms = $1, overbooking_occupancy_threshold_pct = $2, updated_at = now()
       where id = $3 and hotel_id = $4
       returning id;`,
      [body.maxOverbookRooms, body.occupancyThresholdPct, roomTypeId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Tipo de habitación no encontrado.");

    await db.query(
      "select public.record_audit_log($1, $2, 'room_type.overbooking_updated', 'room_type', $3, $4);",
      [orgId, hotelId, roomTypeId, JSON.stringify(body)],
    );

    return c.json(body);
  });

  return app;
}
