// REQ-RES-006/H01-010,H02-011 (P1/F): /hoteles/:hotelId/lista-espera — inscripción a
// la cola FIFO por room_type + rango exacto de fechas (POST), listado ordenado por
// llegada a la cola (GET) y aceptación de una oferta activa (POST .../aceptar), que
// crea la reserva real al precio directo congelado en la oferta (nunca recalculado —
// ver comentario de `offer_amount` en packages/db/migrations/0096_waitlist.sql). La
// oferta AUTOMÁTICA en sí (qué contacto se marca 'ofertada' y con qué monto) se
// dispara desde las dos rutas de cancelación (routes/reservas.ts POST .../cancelar y
// routes/cancelacionPublica.ts) vía `apps/api/src/pms/waitlistOffer.ts` — este archivo
// NUNCA la dispara directamente, solo gestiona la cola y la aceptación manual.
import { Hono } from "hono";
import { z } from "zod";
import { isOfferExpired, nightsBetween } from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");

const joinWaitlistSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    guestId: z.string().uuid(),
    checkInDate: dateSchema,
    checkOutDate: dateSchema,
  })
  .refine((v) => v.checkOutDate > v.checkInDate, {
    message: "checkOutDate debe ser posterior a checkInDate",
    path: ["checkOutDate"],
  });

interface WaitlistEntryRow {
  id: string;
  huesped: string | null;
  habitacion: string;
  llegada: string;
  salida: string;
  estado: string;
  ofertaMonto: string | null;
  ofertaExpira: string | null;
  createdAt: string;
}

const SELECT_ENTRY_SQL = `select w.id,
         g.full_name as huesped,
         rt.name as habitacion,
         w.check_in_date::text as llegada,
         w.check_out_date::text as salida,
         w.status as estado,
         w.offer_amount::text as "ofertaMonto",
         w.offer_expires_at::text as "ofertaExpira",
         w.created_at::text as "createdAt"
  from public.hotel_waitlist_entry w
  join public.room_type rt on rt.id = w.room_type_id
  left join public.guest g on g.id = w.guest_id`;

export function listaEsperaRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/lista-espera*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/lista-espera", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const roomTypeId = c.req.query("roomTypeId");

    const params: unknown[] = [hotelId];
    let where = "w.hotel_id = $1";
    if (roomTypeId) {
      params.push(roomTypeId);
      where += ` and w.room_type_id = $${params.length}`;
    }

    // Orden FIFO real (created_at asc): quien se inscribió primero se ve primero, el
    // mismo orden que `selectNextWaitlistCandidate()` usa para decidir a quién ofertar.
    const { rows } = await db.query<WaitlistEntryRow>(
      `${SELECT_ENTRY_SQL} where ${where} order by w.created_at asc;`,
      params,
    );

    return c.json(
      rows.map((r) => ({
        id: r.id,
        huesped: r.huesped ?? "Sin huésped registrado",
        habitacion: r.habitacion,
        llegada: r.llegada,
        salida: r.salida,
        estado: r.estado,
        ofertaMonto: r.ofertaMonto != null ? Number(r.ofertaMonto) : null,
        ofertaExpira: r.ofertaExpira,
        creadoEn: r.createdAt,
      })),
    );
  });

  app.post("/hoteles/:hotelId/lista-espera", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(joinWaitlistSchema, await c.req.json().catch(() => ({})));

    const { rows: roomTypeRows } = await db.query<{ id: string }>(
      "select id from public.room_type where id = $1 and hotel_id = $2;",
      [body.roomTypeId, hotelId],
    );
    if (roomTypeRows.length === 0) throw Errors.notFound("Tipo de habitación no encontrado en este hotel.");

    const { rows: guestRows } = await db.query<{ id: string }>(
      "select id from public.guest where id = $1 and hotel_id = $2;",
      [body.guestId, hotelId],
    );
    if (guestRows.length === 0) throw Errors.notFound("Huésped no encontrado en este hotel.");

    const { rows: inserted } = await db.query<{ id: string; status: string; created_at: string }>(
      `insert into public.hotel_waitlist_entry
         (tenant_id, hotel_id, room_type_id, guest_id, check_in_date, check_out_date)
       values ($1, $2, $3, $4, $5, $6)
       returning id, status, created_at::text as created_at;`,
      [orgId, hotelId, body.roomTypeId, body.guestId, body.checkInDate, body.checkOutDate],
    );
    const entry = inserted[0]!;

    await db.query(
      "select public.record_audit_log($1, $2, 'waitlist.joined', 'hotel_waitlist_entry', $3, $4);",
      [orgId, hotelId, entry.id, JSON.stringify({ roomTypeId: body.roomTypeId, guestId: body.guestId })],
    );

    return c.json(
      { id: entry.id, estado: entry.status, creadoEn: entry.created_at },
      201,
    );
  });

  // Retiro manual (staff o huésped que ya no quiere esperar) — nunca borra la fila
  // (evidencia de la cola), solo la saca de la carrera FIFO marcándola 'cancelada'.
  app.post("/hoteles/:hotelId/lista-espera/:id/retirar", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const entryId = c.req.param("id");

    const { rows } = await db.query<{ id: string; status: string }>(
      "select id, status from public.hotel_waitlist_entry where id = $1 and hotel_id = $2 for update;",
      [entryId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Entrada de lista de espera no encontrada.");
    const current = rows[0]!;
    if (current.status === "confirmada" || current.status === "cancelada") {
      throw Errors.conflict(`La entrada está en estado "${current.status}" y ya no admite retiro.`);
    }

    await db.query(
      "update public.hotel_waitlist_entry set status = 'cancelada', updated_at = now() where id = $1;",
      [entryId],
    );
    await db.query(
      "select public.record_audit_log($1, $2, 'waitlist.withdrawn', 'hotel_waitlist_entry', $3, $4);",
      [orgId, hotelId, entryId, JSON.stringify({ previousStatus: current.status })],
    );

    return c.json({ id: entryId, estado: "cancelada" });
  });

  // REQ-RES-006: confirma una oferta ACTIVA (no expirada) como reserva real, al precio
  // congelado en `offer_amount` — nunca recotiza, para que una tarifa que suba entre la
  // oferta y la aceptación no le cambie el precio al contacto que ya recibió su turno.
  // `book_availability()` (mismo advisory lock que la creación normal de reservas)
  // sigue siendo la barrera real: si alguien más ya tomó ese inventario por otra vía
  // entre la oferta y esta aceptación, esto responde 409 `sin_disponibilidad` como
  // cualquier otra reserva.
  app.post("/hoteles/:hotelId/lista-espera/:id/aceptar", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const entryId = c.req.param("id");

    const { rows } = await db.query<{
      id: string;
      room_type_id: string;
      guest_id: string;
      check_in_date: string;
      check_out_date: string;
      status: string;
      offer_amount: string | null;
      offer_expires_at: string | null;
    }>(
      `select id, room_type_id, guest_id, check_in_date::text as check_in_date, check_out_date::text as check_out_date,
              status, offer_amount::text as offer_amount, offer_expires_at::text as offer_expires_at
       from public.hotel_waitlist_entry
       where id = $1 and hotel_id = $2
       for update;`,
      [entryId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Entrada de lista de espera no encontrada.");
    const entry = rows[0]!;

    if (entry.status !== "ofertada" || entry.offer_amount == null || entry.offer_expires_at == null) {
      throw Errors.conflict(`La entrada está en estado "${entry.status}" y no tiene una oferta activa que aceptar.`);
    }

    const nowIso = new Date().toISOString();
    if (isOfferExpired(entry.offer_expires_at, nowIso)) {
      await db.query(
        "update public.hotel_waitlist_entry set status = 'expirada', updated_at = now() where id = $1;",
        [entryId],
      );
      throw Errors.conflict("La oferta de esta entrada ya expiró.");
    }

    for (const night of nightsBetween(entry.check_in_date, entry.check_out_date)) {
      await db.query("select * from public.book_availability($1, $2, $3, 1);", [hotelId, entry.room_type_id, night]);
    }

    const totalAmount = Number(entry.offer_amount);
    const { rows: insertedReservation } = await db.query<{ id: string; status: string; confirmation_code: string }>(
      `insert into public.reservation
         (tenant_id, hotel_id, room_type_id, guest_id, check_in_date, check_out_date, total_amount)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, status, confirmation_code;`,
      [orgId, hotelId, entry.room_type_id, entry.guest_id, entry.check_in_date, entry.check_out_date, totalAmount],
    );
    const reservation = insertedReservation[0]!;

    await db.query(
      `update public.hotel_waitlist_entry
       set status = 'confirmada', reservation_id = $2, updated_at = now()
       where id = $1;`,
      [entryId, reservation.id],
    );

    await db.query(
      `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
       values ($1, $2, 'reservation', $3, 'reservation.created', $4);`,
      [orgId, hotelId, reservation.id, JSON.stringify({ totalAmount, fromWaitlistEntryId: entryId })],
    );
    await db.query(
      "select public.record_audit_log($1, $2, 'waitlist.offer_accepted', 'hotel_waitlist_entry', $3, $4);",
      [orgId, hotelId, entryId, JSON.stringify({ reservationId: reservation.id, totalAmount })],
    );

    return c.json({
      id: reservation.id,
      estado: reservation.status,
      total: totalAmount,
      codigoConfirmacion: reservation.confirmation_code,
      listaEsperaEntryId: entryId,
    });
  });

  return app;
}
