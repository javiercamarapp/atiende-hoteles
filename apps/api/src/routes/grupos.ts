// REQ-RES-012 (P1/F): "cotización, contrato, bloqueo de habitaciones (room block) y
// seguimiento de cut-off para grupos/bodas/eventos" -- criterio literal de
// docs/ACEPTACION.md verificado por `tests/integration/grupos/cotizacion.spec.ts`:
// cotización de grupo generada en <15 min y precio que consulta al motor de Revenue
// el costo de desplazamiento de ADR ANTES de fijarse (nunca igual al precio manual
// cuando el desplazamiento es distinto de cero).
import { Hono } from "hono";
import { z } from "zod";
import { GroupQuoteError } from "@atiende-hoteles/domain-hotel";
import { ApiError, Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { authMiddleware, dbSession, requireHotelMembership, assertRole } from "../middleware.ts";
import { MANAGE_RESERVATIONS_ROLES } from "../domain/roles.ts";
import {
  confirmRoomBlock,
  createGroupQuote,
  evaluateRoomBlockCutoff,
  loadRoomBlock,
  releaseRoomBlock,
  RoomBlockTransitionError,
  updateRoomBlockPickup,
  type RoomBlockRow,
} from "../domain/groupQuote.ts";
import { GroupAvailabilityError } from "../pms/dbGroupDisplacementPort.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");

const cotizacionSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    organizerName: z.string().trim().min(1).max(200),
    organizerEmail: z.string().trim().toLowerCase().email(),
    eventType: z.enum(["boda", "evento_corporativo", "retiro", "otro"]),
    checkInDate: dateSchema,
    checkOutDate: dateSchema,
    roomsRequested: z.number().int().positive(),
    manualPrice: z.number().nonnegative(),
    currency: z.string().trim().min(1).max(10).default("MXN"),
    cutoffDate: dateSchema.nullable().optional(),
    /** Momento real en que llegó la solicitud (ISO 8601), si el canal que atendió al
     *  organizador lo capturó por separado de "ahora" (ej. un ticket de WhatsApp
     *  recibido hace unos minutos que un humano apenas está cotizando). Sin este
     *  campo, se asume que la solicitud llegó en este mismo instante. */
    requestedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => v.checkOutDate > v.checkInDate, { message: "checkOutDate debe ser posterior a checkInDate", path: ["checkOutDate"] });

const pickupSchema = z.object({ roomsPickedUp: z.number().int().nonnegative() });

const CODE_STATUS: Record<string, number> = {
  estadia_invalida: 400,
  timestamp_invalido: 400,
  orden_de_tiempo_invalido: 400,
  desplazamiento_incompleto: 409,
  desplazamiento_fuera_de_rango: 409,
  desplazamiento_duplicado: 409,
  desplazamiento_excede_bloque: 409,
  sin_inventario_configurado: 409,
  sin_disponibilidad_suficiente: 409,
  transicion_invalida: 409,
  pickup_excede_bloqueo: 400,
  sin_cutoff: 409,
};

function toResponse(row: RoomBlockRow) {
  return {
    id: row.id,
    roomTypeId: row.roomTypeId,
    organizerName: row.organizerName,
    organizerEmail: row.organizerEmail,
    eventType: row.eventType,
    checkInDate: row.checkInDate,
    checkOutDate: row.checkOutDate,
    roomsRequested: row.roomsRequested,
    currency: row.currency,
    requestedAt: row.requestedAt,
    quotedAt: row.quotedAt,
    slaMinutes: row.slaMinutes,
    withinSla: row.withinSla,
    manualPrice: row.manualPrice,
    displacementCost: row.displacementCost,
    groupPrice: row.groupPrice,
    nightlyDisplacement: row.nightlyDisplacement,
    status: row.status,
    cutoffDate: row.cutoffDate,
    roomsPickedUp: row.roomsPickedUp,
    confirmedAt: row.confirmedAt,
    releasedAt: row.releasedAt,
  };
}

export function gruposRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/grupos/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  // POST .../grupos/cotizaciones -- genera la cotización real: consulta
  // disponibilidad/tarifa reales, consulta al motor de Revenue el desplazamiento de
  // ADR de cada noche, calcula el precio de grupo, y persiste (aún SIN tocar
  // inventario -- ver .../confirmar).
  app.post("/hoteles/:hotelId/grupos/cotizaciones", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const userId = c.get("userId") ?? null;
    const hotelId = c.req.param("hotelId");
    const body = parseBody(cotizacionSchema, await c.req.json().catch(() => ({})));

    const { rows: roomTypeRows } = await db.query<{ id: string }>(
      "select id from public.room_type where id = $1 and hotel_id = $2;",
      [body.roomTypeId, hotelId],
    );
    if (roomTypeRows.length === 0) throw Errors.notFound("Tipo de habitación no encontrado en este hotel.");

    try {
      const { row } = await createGroupQuote(db, {
        hotelId,
        tenantId: orgId,
        createdBy: userId,
        roomTypeId: body.roomTypeId,
        organizerName: body.organizerName,
        organizerEmail: body.organizerEmail,
        eventType: body.eventType,
        checkInDate: body.checkInDate,
        checkOutDate: body.checkOutDate,
        roomsRequested: body.roomsRequested,
        manualPrice: body.manualPrice,
        currency: body.currency,
        cutoffDate: body.cutoffDate ?? null,
        requestedAt: body.requestedAt ? new Date(body.requestedAt) : undefined,
      });
      return c.json(toResponse(row), 201);
    } catch (err) {
      if (err instanceof GroupQuoteError || err instanceof GroupAvailabilityError) {
        const status = CODE_STATUS[err.code] ?? 409;
        throw new ApiError(status, err.code, err.message);
      }
      throw err;
    }
  });

  app.get("/hoteles/:hotelId/grupos/cotizaciones/:id", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const row = await loadRoomBlock(db, hotelId, c.req.param("id"));
    if (!row) throw Errors.notFound("Cotización de grupo no encontrada.");
    return c.json(toResponse(row));
  });

  // POST .../confirmar -- el grupo aceptó: bloquea el inventario REAL (H02-016).
  app.post("/hoteles/:hotelId/grupos/cotizaciones/:id/confirmar", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    try {
      const row = await confirmRoomBlock(db, hotelId, c.req.param("id"));
      return c.json(toResponse(row));
    } catch (err) {
      if (err instanceof RoomBlockTransitionError) {
        const status = err.code === "no_encontrado" ? 404 : CODE_STATUS[err.code] ?? 409;
        throw new ApiError(status, err.code, err.message);
      }
      throw err;
    }
  });

  // POST .../liberar y .../cancelar -- libera lo que quedó sin recoger del bloque.
  for (const action of ["liberar", "cancelar"] as const) {
    const finalStatus = action === "liberar" ? "liberado" : "cancelado";
    app.post(`/hoteles/:hotelId/grupos/cotizaciones/:id/${action}`, async (c) => {
      assertRole(c, MANAGE_RESERVATIONS_ROLES);
      const db = c.get("db");
      const hotelId = c.req.param("hotelId");
      try {
        const row = await releaseRoomBlock(db, hotelId, c.req.param("id"), finalStatus);
        return c.json(toResponse(row));
      } catch (err) {
        if (err instanceof RoomBlockTransitionError) {
          const status = err.code === "no_encontrado" ? 404 : CODE_STATUS[err.code] ?? 409;
          throw new ApiError(status, err.code, err.message);
        }
        throw err;
      }
    });
  }

  // PATCH .../pickup -- staff reporta cuántas habitaciones del bloque ya se recogieron
  // (reservas individuales confirmadas del grupo).
  app.patch("/hoteles/:hotelId/grupos/cotizaciones/:id/pickup", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(pickupSchema, await c.req.json().catch(() => ({})));
    try {
      const row = await updateRoomBlockPickup(db, hotelId, c.req.param("id"), body.roomsPickedUp);
      return c.json(toResponse(row));
    } catch (err) {
      if (err instanceof RoomBlockTransitionError) {
        const status = err.code === "no_encontrado" ? 404 : CODE_STATUS[err.code] ?? 409;
        throw new ApiError(status, err.code, err.message);
      }
      throw err;
    }
  });

  // GET .../cutoff-alerta -- H05-013: ¿este bloque necesita atención por acercarse a
  // su cut-off sin pickup suficiente?
  app.get("/hoteles/:hotelId/grupos/cotizaciones/:id/cutoff-alerta", async (c) => {
    assertRole(c, MANAGE_RESERVATIONS_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    try {
      const evaluacion = await evaluateRoomBlockCutoff(db, hotelId, c.req.param("id"));
      return c.json(evaluacion);
    } catch (err) {
      if (err instanceof RoomBlockTransitionError) {
        const status = err.code === "no_encontrado" ? 404 : CODE_STATUS[err.code] ?? 409;
        throw new ApiError(status, err.code, err.message);
      }
      throw err;
    }
  });

  return app;
}
