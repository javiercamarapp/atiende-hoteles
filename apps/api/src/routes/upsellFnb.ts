// REQ-AB-014 (P2/F, H10-010): "El sistema debe disparar ofertas de upsell F&B (cena
// romántica, botella, desayuno en cama) en momentos definidos (T-7, T-3, check-in),
// con el precio siempre proveniente del motor de Revenue."
//
// Tres superficies, todas autenticadas (staff, rol owner/gm/fnb -- mismo criterio que
// `routes/menuQr.ts` para gestionar el menú):
//   * `POST /hoteles/:hotelId/upsell-fnb/plantillas`: da de alta una oferta de upsell
//     apuntando a un `menu_item` REAL ya existente (nunca un precio libre en el body
//     -- ver `crearPlantillaSchema`, que ni siquiera tiene un campo `precio`).
//   * `GET /hoteles/:hotelId/upsell-fnb/plantillas`: lista las plantillas del hotel.
//   * `POST /hoteles/:hotelId/reservas/:reservationId/upsell-fnb/evaluar`: corre la
//     evaluación de momentos vencidos (dominio `dueUpsellTriggerMoments`) para UNA
//     reserva puntual y dispara lo que corresponda -- disparo manual/bajo demanda
//     (ej. un gerente que quiere adelantar la oferta para un huésped VIP); el disparo
//     AUTOMÁTICO real corre en `jobs/fnbUpsellScheduler.ts` (arrancado desde
//     server.ts), que recorre TODAS las reservas activas de todos los hoteles sin
//     necesitar esta ruta.
//   * `GET /hoteles/:hotelId/upsell-fnb/eventos`: lista lo ya disparado, para
//     auditoría/operación (opcionalmente filtrado por `reservationId`).
//
// El precio nunca llega como parámetro de ninguna de estas rutas hacia el disparo: la
// autoridad es `public.trigger_fnb_upsell_offer` (migración 0154), que lo calcula
// dentro de la base de datos leyendo `menu_item.price` -- ver comentario extenso ahí y
// en `packages/domain-hotel/src/fnbUpsellEngine.ts`.
import { Hono } from "hono";
import { z } from "zod";
import { UPSELL_OFFER_TYPES } from "@atiende-hoteles/domain-hotel";
import { evaluateAndTriggerFnbUpsellOffers } from "../jobs/fnbUpsellOffers.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const GESTIONAR_UPSELL_ROLES = ["owner", "gm", "fnb"] as const;

const crearPlantillaSchema = z.object({
  tipoOferta: z.enum(UPSELL_OFFER_TYPES),
  menuItemId: z.string().uuid(),
});

interface PlantillaRow {
  id: string;
  offer_type: string;
  menu_item_id: string;
  menu_item_name: string;
  menu_item_price: string;
  menu_item_active: boolean;
  active: boolean;
  created_at: string;
}

function serializePlantilla(r: PlantillaRow) {
  return {
    id: r.id,
    tipoOferta: r.offer_type,
    menuItemId: r.menu_item_id,
    nombrePlatillo: r.menu_item_name,
    // Precio vigente AHORA MISMO, solo informativo para el panel de staff -- el
    // precio que de verdad se cobra al disparar se recalcula en ese instante (ver
    // cabecera del archivo), nunca se congela aquí.
    precioVigente: Number(r.menu_item_price),
    platilloActivo: r.menu_item_active,
    activa: r.active,
    creadaEn: r.created_at,
  };
}

interface EventoRow {
  id: string;
  reservation_id: string;
  template_id: string;
  offer_type: string;
  trigger_moment: string;
  offered_price: string;
  triggered_at: string;
}

function serializeEvento(r: EventoRow) {
  return {
    id: r.id,
    reservationId: r.reservation_id,
    templateId: r.template_id,
    tipoOferta: r.offer_type,
    momento: r.trigger_moment,
    precioOfertado: Number(r.offered_price),
    disparadaEn: r.triggered_at,
  };
}

export function upsellFnbRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/upsell-fnb/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/upsell-fnb",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/reservas/:reservationId/upsell-fnb/*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/upsell-fnb/plantillas", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<PlantillaRow>(
      `select t.id, t.offer_type, t.menu_item_id, mi.name as menu_item_name,
              mi.price::text as menu_item_price, mi.active as menu_item_active,
              t.active, t.created_at::text as created_at
       from public.fnb_upsell_offer_template t
       join public.menu_item mi on mi.id = t.menu_item_id
       where t.hotel_id = $1
       order by t.offer_type, t.created_at;`,
      [c.req.param("hotelId")],
    );
    return c.json(rows.map(serializePlantilla));
  });

  app.post("/hoteles/:hotelId/upsell-fnb/plantillas", async (c) => {
    assertRole(c, [...GESTIONAR_UPSELL_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const orgId = c.get("orgId");
    const body = parseBody(crearPlantillaSchema, await c.req.json().catch(() => ({})));

    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.fnb_upsell_offer_template (tenant_id, hotel_id, offer_type, menu_item_id, created_by)
         values ($1, $2, $3, $4, $5)
         returning id;`,
        [orgId, hotelId, body.tipoOferta, body.menuItemId, c.get("userId")],
      );

      const { rows: full } = await db.query<PlantillaRow>(
        `select t.id, t.offer_type, t.menu_item_id, mi.name as menu_item_name,
                mi.price::text as menu_item_price, mi.active as menu_item_active,
                t.active, t.created_at::text as created_at
         from public.fnb_upsell_offer_template t
         join public.menu_item mi on mi.id = t.menu_item_id
         where t.id = $1;`,
        [rows[0]!.id],
      );
      return c.json(serializePlantilla(full[0]!), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/menu_item_de_otro_hotel|menu_item_no_encontrado/.test(message)) {
        throw Errors.validation("El platillo indicado no existe en este hotel.");
      }
      if (/duplicate key|unique constraint/i.test(message)) {
        throw Errors.conflict("Ya existe una plantilla de upsell para ese tipo de oferta y ese platillo en este hotel.");
      }
      throw err;
    }
  });

  app.get("/hoteles/:hotelId/upsell-fnb/eventos", async (c) => {
    const db = c.get("db");
    const reservationId = c.req.query("reservationId");
    const params: unknown[] = [c.req.param("hotelId")];
    let filtro = "";
    if (reservationId) {
      params.push(reservationId);
      filtro = "and reservation_id = $2";
    }
    const { rows } = await db.query<EventoRow>(
      `select e.id, e.reservation_id, e.template_id, t.offer_type, e.trigger_moment,
              e.offered_price::text as offered_price, e.triggered_at::text as triggered_at
       from public.fnb_upsell_trigger_event e
       join public.fnb_upsell_offer_template t on t.id = e.template_id
       where e.hotel_id = $1 ${filtro}
       order by e.triggered_at desc;`,
      params,
    );
    return c.json(rows.map(serializeEvento));
  });

  // Disparo manual/bajo demanda para UNA reserva puntual -- el disparo automático real
  // vive en jobs/fnbUpsellScheduler.ts (ver cabecera del archivo).
  app.post("/hoteles/:hotelId/reservas/:reservationId/upsell-fnb/evaluar", async (c) => {
    assertRole(c, [...GESTIONAR_UPSELL_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const reservationId = c.req.param("reservationId");
    const orgId = c.get("orgId");

    const { rows: reservaRows } = await db.query<{ id: string; check_in_date: string }>(
      `select id, check_in_date::text as check_in_date from public.reservation where id = $1 and hotel_id = $2;`,
      [reservationId, hotelId],
    );
    if (reservaRows.length === 0) {
      throw Errors.notFound("Esta reserva no existe en este hotel.");
    }

    const result = await evaluateAndTriggerFnbUpsellOffers(db, { hotelId, tenantId: orgId, reservationId });

    return c.json({
      reservationId,
      disparadas: result.triggered.map((t) => ({
        eventId: t.eventId,
        templateId: t.templateId,
        tipoOferta: t.offerType,
        momento: t.triggerMoment,
        precioOfertado: t.offeredPrice,
        yaExistia: t.yaDisparada,
      })),
    });
  });

  return app;
}
