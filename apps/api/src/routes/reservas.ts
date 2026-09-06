// H2/H4 · /hoteles/:hotelId/reservas — contrato apps/web `listarReservas()`
// (Reserva[] = {id, huesped, llegada, salida, habitacion, canal, estado, total}) + POST
// crear (idempotente, advisory lock por noche vía `book_availability`, cotización real
// con validación min-stay/CTA/CTD, outbox `reservation.created` en la MISMA
// transacción) + PATCH transición de estado + PATCH modificar fechas/tipo (H4, libera
// el inventario viejo y reserva el nuevo bajo el MISMO advisory lock/transacción) +
// POST cancelar (H4, aplica `hotel_cancellation_policy`) + POST procesar-no-show
// (H4, dispara `jobs/noShow.ts` acotado a este hotel).
//
// `channel` (migración 0014) hoy siempre vale 'directo': el rastreo de canal de origen
// real vía OTA/agente externo (REQ-RES-020) no se construye en H4 -- documentado, no
// simulado con variedad falsa.
import { Hono } from "hono";
import { z } from "zod";
import type { DbClient } from "@atiende-hoteles/db";
import {
  computeQuote,
  evaluateCancellation,
  isCancellable,
  isModifiable,
  nightsBetween,
  parseQuoteInput,
  QuoteError,
  type ReservationStatus,
} from "@atiende-hoteles/domain-hotel";
import { Errors, ApiError } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { withIdempotency } from "../lib/idempotency.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES, MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import { loadNightlyRates } from "../pms/dbRoomRatePort.ts";
import { loadCancellationPolicy, loadTaxConfig } from "../pms/taxConfig.ts";
import { runNoShowJob } from "../jobs/noShow.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const QUOTE_CODE_STATUS: Record<string, number> = {
  estadia_invalida: 400,
  sin_tarifa: 409,
  cerrado_a_llegada: 409,
  cerrado_a_salida: 409,
  estadia_minima_no_alcanzada: 409,
};

async function quoteNetAmount(
  db: DbClient,
  params: { hotelId: string; roomTypeId: string; checkInDate: string; checkOutDate: string },
): Promise<number> {
  const taxConfig = await loadTaxConfig(db, params.hotelId);
  const nightlyRates = await loadNightlyRates(db, {
    hotelId: params.hotelId,
    roomTypeId: params.roomTypeId,
    fromDateInclusive: params.checkInDate,
    toDateInclusive: params.checkOutDate,
  });
  try {
    const input = parseQuoteInput({
      checkInDate: params.checkInDate,
      checkOutDate: params.checkOutDate,
      taxConfig,
      nightlyRates,
    });
    // `reservation.total_amount` guarda el NETO (sin impuestos): los impuestos se
    // postean como cargo aparte en el folio (H5, apps/api/src/routes/folios.ts) — el
    // desglose completo con IVA/ISH lo entrega POST /quotes para cotizar, no la
    // reserva persistida.
    return computeQuote(input).netAmount;
  } catch (err) {
    if (err instanceof QuoteError) {
      throw new ApiError(QUOTE_CODE_STATUS[err.code] ?? 409, err.code, err.message);
    }
    throw err;
  }
}

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

// 'cancelada'/'no_show' quedan FUERA de este enum a propósito: ambas transiciones
// tienen efectos secundarios (liberar inventario reservado, calcular penalización de
// `hotel_cancellation_policy`) que solo garantizan los endpoints dedicados
// (.../cancelar, .../procesar-no-show) más abajo — permitirlas por esta vía genérica
// dejaría inventario "reservado" huérfano en `availability.booked_rooms`.
const transitionSchema = z.object({
  toStatus: z.enum(["confirmada", "check_in", "en_estancia", "check_out", "cerrada"]),
});

const modifyReservationSchema = z
  .object({
    roomTypeId: z.string().uuid().optional(),
    checkInDate: dateSchema,
    checkOutDate: dateSchema,
  })
  .refine((v) => v.checkOutDate > v.checkInDate, {
    message: "checkOutDate debe ser posterior a checkInDate",
    path: ["checkOutDate"],
  });

interface ReservaRow {
  id: string;
  huesped: string | null;
  llegada: string;
  salida: string;
  habitacion: string;
  estado: string;
  total: string;
  codigoConfirmacion: string;
  canal: string;
}

interface ReservationDetailRow {
  id: string;
  tenant_id: string;
  hotel_id: string;
  room_type_id: string;
  check_in_date: string;
  check_out_date: string;
  status: ReservationStatus;
  total_amount: string;
  confirmation_code: string;
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
              r.total_amount::text as total,
              r.confirmation_code as "codigoConfirmacion",
              r.channel as canal
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
        canal: r.canal,
        estado: r.estado,
        total: Number(r.total),
        codigoConfirmacion: r.codigoConfirmacion,
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
              r.total_amount::text as total,
              r.confirmation_code as "codigoConfirmacion",
              r.channel as canal
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
      canal: r.canal,
      estado: r.estado,
      total: Number(r.total),
      codigoConfirmacion: r.codigoConfirmacion,
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
        // Cotiza ANTES de tocar inventario: min-stay/CTA/CTD se validan contra tarifa
        // real (REQ-RES-002/H07-005) y la reserva se rechaza sin dejar locks a medias
        // si la estadía no cumple la restricción.
        const totalAmount = await quoteNetAmount(db, {
          hotelId,
          roomTypeId: body.roomTypeId,
          checkInDate: body.checkInDate,
          checkOutDate: body.checkOutDate,
        });

        const nights = nightsBetween(body.checkInDate, body.checkOutDate);
        for (const night of nights) {
          // book_availability(): toma el advisory lock (hotel_id, room_type_id, date) y
          // valida contra total_rooms (+ sobreventa configurada, REQ-RES-007) bajo lock
          // -- lanza `sin_disponibilidad` (P0001) si no hay cupo, capturado por el
          // manejador de errores global (409).
          await db.query("select * from public.book_availability($1, $2, $3, 1);", [
            hotelId,
            body.roomTypeId,
            night,
          ]);
        }

        const { rows: inserted } = await db.query<{ id: string; status: string; confirmation_code: string }>(
          `insert into public.reservation
             (tenant_id, hotel_id, room_type_id, guest_id, check_in_date, check_out_date, total_amount, idempotency_key)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id, status, confirmation_code;`,
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
          body: {
            id: reservation.id,
            estado: reservation.status,
            total: totalAmount,
            codigoConfirmacion: reservation.confirmation_code,
          },
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

  // H4 · PATCH modificar fechas/tipo de habitación: re-verifica disponibilidad bajo el
  // MISMO advisory lock que la creación. Libera el inventario viejo y reserva el nuevo
  // DENTRO de la misma transacción de sesión (dbSession): si `book_availability` del
  // nuevo rango falla, Postgres revierte también la liberación anterior -- la reserva
  // nunca queda en un estado intermedio.
  app.patch("/hoteles/:hotelId/reservas/:reservationId/fechas", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const idempotencyKey = c.req.header("idempotency-key");
    if (!idempotencyKey) throw Errors.idempotencyRequired();

    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const reservationId = c.req.param("reservationId");
    const body = parseBody(modifyReservationSchema, await c.req.json().catch(() => ({})));

    const result = await withIdempotency(
      db,
      { tenantId: orgId, scope: "reservation.modify", key: idempotencyKey, body: { reservationId, ...body } },
      async () => {
        const { rows: currentRows } = await db.query<ReservationDetailRow>(
          `select id, tenant_id, hotel_id, room_type_id, check_in_date::text as check_in_date,
                  check_out_date::text as check_out_date, status, total_amount::text as total_amount,
                  confirmation_code
           from public.reservation
           where id = $1 and hotel_id = $2;`,
          [reservationId, hotelId],
        );
        if (currentRows.length === 0) throw Errors.notFound("Reserva no encontrada.");
        const current = currentRows[0]!;

        if (!isModifiable(current.status)) {
          throw Errors.conflict(`La reserva está en estado "${current.status}" y ya no admite modificar fechas/tipo.`);
        }

        const newRoomTypeId = body.roomTypeId ?? current.room_type_id;

        const totalAmount = await quoteNetAmount(db, {
          hotelId,
          roomTypeId: newRoomTypeId,
          checkInDate: body.checkInDate,
          checkOutDate: body.checkOutDate,
        });

        for (const night of nightsBetween(current.check_in_date, current.check_out_date)) {
          await db.query("select * from public.release_availability($1, $2, $3, 1);", [
            hotelId,
            current.room_type_id,
            night,
          ]);
        }
        for (const night of nightsBetween(body.checkInDate, body.checkOutDate)) {
          await db.query("select * from public.book_availability($1, $2, $3, 1);", [hotelId, newRoomTypeId, night]);
        }

        const { rows: updatedRows } = await db.query<{ id: string; status: string; confirmation_code: string }>(
          `update public.reservation
           set room_type_id = $1, check_in_date = $2, check_out_date = $3, total_amount = $4, updated_at = now()
           where id = $5
           returning id, status, confirmation_code;`,
          [newRoomTypeId, body.checkInDate, body.checkOutDate, totalAmount, reservationId],
        );
        const updated = updatedRows[0]!;

        await db.query(
          `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
           values ($1, $2, 'reservation', $3, 'reservation.modified', $4);`,
          [
            orgId,
            hotelId,
            reservationId,
            JSON.stringify({ checkIn: body.checkInDate, checkOut: body.checkOutDate, roomTypeId: newRoomTypeId, totalAmount }),
          ],
        );
        await db.query(
          "select public.record_audit_log($1, $2, 'reservation.modified', 'reservation', $3, $4);",
          [
            orgId,
            hotelId,
            reservationId,
            JSON.stringify({
              antes: { checkIn: current.check_in_date, checkOut: current.check_out_date, roomTypeId: current.room_type_id },
              despues: { checkIn: body.checkInDate, checkOut: body.checkOutDate, roomTypeId: newRoomTypeId },
            }),
          ],
        );

        return {
          status: 200,
          body: { id: updated.id, estado: updated.status, total: totalAmount, codigoConfirmacion: updated.confirmation_code },
        };
      },
    );

    return c.json(result.body as object, result.status as 200);
  });

  // H4 · REQ-RES-004: cancelación iniciada por staff (distinta de la pública verificada
  // por código+apellido de `routes/cancelacionPublica.ts`, REQ-RES-005) — aquí la
  // autorización ya la dio el rol/membresía del hotel, no hace falta re-verificar
  // identidad del huésped. Aplica `hotel_cancellation_policy` para calcular la
  // penalización y libera todo el inventario restante de la estancia.
  app.post("/hoteles/:hotelId/reservas/:reservationId/cancelar", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const reservationId = c.req.param("reservationId");

    const { rows: currentRows } = await db.query<ReservationDetailRow>(
      `select id, tenant_id, hotel_id, room_type_id, check_in_date::text as check_in_date,
              check_out_date::text as check_out_date, status, total_amount::text as total_amount,
              confirmation_code
       from public.reservation
       where id = $1 and hotel_id = $2;`,
      [reservationId, hotelId],
    );
    if (currentRows.length === 0) throw Errors.notFound("Reserva no encontrada.");
    const current = currentRows[0]!;

    if (!isCancellable(current.status)) {
      throw Errors.conflict(`La reserva está en estado "${current.status}" y ya no admite cancelación.`);
    }

    const policy = await loadCancellationPolicy(db, hotelId);
    const evaluation = policy
      ? evaluateCancellation(policy, new Date().toISOString(), current.check_in_date, Number(current.total_amount))
      : { isFree: true, hoursUntilCheckIn: Infinity, penaltyAmount: 0, refundAmount: Number(current.total_amount) };

    for (const night of nightsBetween(current.check_in_date, current.check_out_date)) {
      await db.query("select * from public.release_availability($1, $2, $3, 1);", [
        hotelId,
        current.room_type_id,
        night,
      ]);
    }

    await db.query(
      `update public.reservation
       set status = 'cancelada', canceled_at = now(), cancellation_penalty_amount = $1, updated_at = now()
       where id = $2;`,
      [evaluation.penaltyAmount, reservationId],
    );

    await db.query(
      "select public.record_audit_log($1, $2, 'reservation.canceled', 'reservation', $3, $4);",
      [orgId, hotelId, reservationId, JSON.stringify({ penaltyAmount: evaluation.penaltyAmount, canceledBy: "staff" })],
    );
    await db.query(
      `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
       values ($1, $2, 'reservation', $3, 'reservation.canceled', $4);`,
      [orgId, hotelId, reservationId, JSON.stringify({ penaltyAmount: evaluation.penaltyAmount, canceledBy: "staff" })],
    );

    return c.json({
      id: reservationId,
      estado: "cancelada",
      codigoConfirmacion: current.confirmation_code,
      montoPenalizacion: evaluation.penaltyAmount,
      montoReembolso: evaluation.refundAmount,
    });
  });

  // H4 · REQ-RES-008/H02-012: disparo manual/operativo del job de no-show (idempotente,
  // ver jobs/noShow.ts), acotado a este hotel bajo la sesión RLS normal de quien lo
  // dispara (owner/gm). `asOfDate` es opcional y solo existe para poder probarlo sin
  // depender del reloj real del sistema.
  const procesarNoShowSchema = z.object({ asOfDate: dateSchema.optional() });

  app.post("/hoteles/:hotelId/reservas/procesar-no-show", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(procesarNoShowSchema, await c.req.json().catch(() => ({})));

    const resultados = await runNoShowJob(db, { tenantId: orgId, hotelId, asOfDate: body.asOfDate });

    return c.json({
      procesados: resultados.map((r) => ({ id: r.reservationId, montoCargo: r.chargeAmount })),
    });
  });

  return app;
}
