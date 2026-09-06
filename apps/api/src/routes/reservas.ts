// H2 · /hoteles/:hotelId/reservas — contrato apps/web `listarReservas()`
// (Reserva[] = {id, huesped, llegada, salida, habitacion, canal, estado, total}) + POST
// crear (idempotente, advisory lock por noche vía `book_availability`, outbox
// `reservation.created` en la MISMA transacción) + PATCH transición de estado.
//
// `canal` se reporta fijo como "directo": el rastreo de canal de origen real
// (REQ-RES-020) no se construye en H2 -- documentado, no simulado con variedad falsa.
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { withIdempotency } from "../lib/idempotency.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");

const createReservationSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    guestId: z.string().uuid().optional().nullable(),
    checkInDate: dateSchema,
    checkOutDate: dateSchema,
  })
  .refine((v) => v.checkOutDate > v.checkInDate, {
    message: "checkOutDate debe ser posterior a checkInDate",
    path: ["checkOutDate"],
  });

const transitionSchema = z.object({
  toStatus: z.enum([
    "cotizada",
    "confirmada",
    "check_in",
    "en_estancia",
    "check_out",
    "cerrada",
    "cancelada",
    "no_show",
  ]),
});

function nightsBetween(checkIn: string, checkOut: string): string[] {
  const nights: string[] = [];
  const cursor = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  while (cursor < end) {
    nights.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

interface ReservaRow {
  id: string;
  huesped: string | null;
  llegada: string;
  salida: string;
  habitacion: string;
  estado: string;
  total: string;
}

export function reservasRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/reservas",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/reservas/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/reservas", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<ReservaRow>(
      `select r.id,
              g.full_name as huesped,
              r.check_in_date::text as llegada,
              r.check_out_date::text as salida,
              rt.name as habitacion,
              r.status as estado,
              r.total_amount::text as total
       from public.reservation r
       join public.room_type rt on rt.id = r.room_type_id
       left join public.guest g on g.id = r.guest_id
       where r.hotel_id = $1
       order by r.check_in_date desc, r.created_at desc;`,
      [hotelId],
    );

    return c.json(
      rows.map((r) => ({
        id: r.id,
        huesped: r.huesped ?? "Sin huésped registrado",
        llegada: r.llegada,
        salida: r.salida,
        habitacion: r.habitacion,
        canal: "directo",
        estado: r.estado,
        total: Number(r.total),
      })),
    );
  });

  app.get("/hoteles/:hotelId/reservas/:reservationId", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<ReservaRow>(
      `select r.id,
              g.full_name as huesped,
              r.check_in_date::text as llegada,
              r.check_out_date::text as salida,
              rt.name as habitacion,
              r.status as estado,
              r.total_amount::text as total
       from public.reservation r
       join public.room_type rt on rt.id = r.room_type_id
       left join public.guest g on g.id = r.guest_id
       where r.id = $1 and r.hotel_id = $2;`,
      [c.req.param("reservationId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Reserva no encontrada.");
    const r = rows[0]!;
    return c.json({
      id: r.id,
      huesped: r.huesped ?? "Sin huésped registrado",
      llegada: r.llegada,
      salida: r.salida,
      habitacion: r.habitacion,
      canal: "directo",
      estado: r.estado,
      total: Number(r.total),
    });
  });

  app.post("/hoteles/:hotelId/reservas", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(createReservationSchema, await c.req.json().catch(() => ({})));

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "reservation.create", key: idempotencyKey, body },
      async () => {
        const nights = nightsBetween(body.checkInDate, body.checkOutDate);

        let totalAmount = 0;
        for (const night of nights) {
          // book_availability(): toma el advisory lock (hotel_id, room_type_id, date) y
          // valida contra total_rooms bajo lock -- lanza `sin_disponibilidad` (P0001) si
          // no hay cupo, capturado por el manejador de errores global (409).
          await db.query("select * from public.book_availability($1, $2, $3, 1);", [
            hotelId,
            body.roomTypeId,
            night,
          ]);

          const { rows: rateRows } = await db.query<{ price: string }>(
            "select price from public.rate_plan where room_type_id = $1 and date = $2;",
            [body.roomTypeId, night],
          );
          totalAmount += rateRows[0] ? Number(rateRows[0].price) : 0;
        }

        const { rows: inserted } = await db.query<{ id: string; status: string }>(
          `insert into public.reservation
             (tenant_id, hotel_id, room_type_id, guest_id, check_in_date, check_out_date, total_amount, idempotency_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id, status;`,
          [
            orgId,
            hotelId,
            body.roomTypeId,
            body.guestId ?? null,
            body.checkInDate,
            body.checkOutDate,
            totalAmount,
            idempotencyKey,
          ],
        );
        const reservation = inserted[0]!;

        await db.query(
          `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
           values ($1, $2, 'reservation', $3, 'reservation.created', $4);`,
          [orgId, hotelId, reservation.id, JSON.stringify({ reservationId: reservation.id, totalAmount })],
        );

        await db.query(
          "select public.record_audit_log($1, $2, 'reservation.created', 'reservation', $3, $4);",
          [orgId, hotelId, reservation.id, JSON.stringify({ totalAmount, checkIn: body.checkInDate, checkOut: body.checkOutDate })],
        );

        return {
          status: 201,
          body: { id: reservation.id, estado: reservation.status, total: totalAmount },
        };
      },
    );

    return c.json(result.body as object, result.status as 200 | 201);
  });

  app.patch("/hoteles/:hotelId/reservas/:reservationId/transicion", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const reservationId = c.req.param("reservationId");
    const body = parseBody(transitionSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<{ id: string; status: string }>(
      `update public.reservation set status = $1, updated_at = now()
       where id = $2 and hotel_id = $3
       returning id, status;`,
      [body.toStatus, reservationId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Reserva no encontrada.");

    await db.query(
      "select public.record_audit_log($1, $2, 'reservation.status_changed', 'reservation', $3, $4);",
      [orgId, hotelId, reservationId, JSON.stringify({ toStatus: body.toStatus })],
    );

    return c.json({ id: rows[0]!.id, estado: rows[0]!.status });
  });

  return app;
}
