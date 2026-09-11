// REQ-AB-007 (P2/F, H10-011/H10-012) · /hoteles/:hotelId/fnb/centros-consumo — múltiples
// centros de consumo de F&B con traspasos internos hacia/desde el almacén central, y
// reporte de costo teórico del desayuno incluido (imputado, nunca facturado -- ver
// `computeTheoreticalBreakfastCost` en @atiende-hoteles/domain-hotel para el porqué).
//
// El traspaso en sí se valida DOS veces por diseño (mismo criterio que
// `book_availability`/`overbooking.ts`): primero aquí con `planFnbInventoryTransfer`
// (falla rápido, mensaje amigable, sin gastar un viaje a la base si el traspaso es
// obviamente inválido), y de nuevo dentro de `fnb_registrar_traspaso()` bajo
// `pg_advisory_xact_lock` (la autoridad real contra la existencia actual -- la única que
// importa si dos traspasos concurrentes del mismo sku compiten).
import { Hono } from "hono";
import { z } from "zod";
import { computeTheoreticalBreakfastCost, planFnbInventoryTransfer } from "@atiende-hoteles/domain-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

// Alta/operación de centros, existencia y traspasos: mismo grupo que
// `pedidosFnb.ts` usa para operar F&B día a día.
const MANAGE_FNB_ROLES = ["owner", "gm", "fnb"] as const;
// Config de costo de desayuno (dinero real del hotel): solo owner/gm, mismo criterio
// que `clubSegundoViaje.ts`/`hotel_cancellation_policy`.
const ADMIN_ROLES = ["owner", "gm"] as const;
// Consultar el costo imputado: además de owner/gm/fnb, accountant lo necesita para
// cerrar el P&L del período.
const READ_COST_ROLES = ["owner", "gm", "fnb", "accountant"] as const;

const crearCentroSchema = z.object({
  nombre: z.string().trim().min(1).max(150),
  tipo: z.enum(["centro_consumo", "almacen_central"]).default("centro_consumo"),
});

const traspasoSchema = z.object({
  fromCenterId: z.string().uuid(),
  toCenterId: z.string().uuid(),
  sku: z.string().trim().min(1).max(80),
  cantidad: z.number().positive(),
  nota: z.string().trim().max(500).optional(),
});

// Recepción de mercancía: solo entra por el almacén central (ver el handler) -- desde
// ahí se traspasa a los centros de consumo con `POST .../traspasos`.
const existenciaInicialSchema = z.object({
  sku: z.string().trim().min(1).max(80),
  nombre: z.string().trim().min(1).max(150),
  cantidad: z.number().positive(),
  costoUnitario: z.number().min(0),
});

const costoConfigSchema = z.object({ costoPorHabitacionNoche: z.number().min(0) });

interface CenterRow {
  id: string;
  nombre: string;
  tipo: "centro_consumo" | "almacen_central";
  activo: boolean;
}

function serializeCenter(row: CenterRow) {
  return { id: row.id, nombre: row.nombre, tipo: row.tipo, activo: row.activo };
}

export function fnbCentrosConsumoRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/fnb/centros-consumo*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/fnb/traspasos*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/fnb/costo-desayuno*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/fnb/centros-consumo", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<CenterRow>(
      `select id, nombre, tipo, activo from public.fnb_consumption_center
       where hotel_id = $1 order by tipo desc, nombre asc;`,
      [c.req.param("hotelId")],
    );
    return c.json(rows.map(serializeCenter));
  });

  app.post("/hoteles/:hotelId/fnb/centros-consumo", async (c) => {
    assertRole(c, [...MANAGE_FNB_ROLES]);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(crearCentroSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<CenterRow>(
      `insert into public.fnb_consumption_center (tenant_id, hotel_id, nombre, tipo)
       values ($1, $2, $3, $4) returning id, nombre, tipo, activo;`,
      [orgId, hotelId, body.nombre, body.tipo],
    );
    return c.json(serializeCenter(rows[0]!), 201);
  });

  // Recepción de mercancía en el almacén central (el único punto de entrada de
  // existencia nueva al sistema de centros de consumo -- desde ahí se reparte por
  // traspaso). Rechaza explícitamente sobre un centro que no sea el almacén central:
  // un centro de consumo solo recibe existencia por traspaso, nunca "de la nada".
  app.post("/hoteles/:hotelId/fnb/centros-consumo/:centerId/existencia-inicial", async (c) => {
    assertRole(c, [...MANAGE_FNB_ROLES]);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const centerId = c.req.param("centerId");
    const body = parseBody(existenciaInicialSchema, await c.req.json().catch(() => ({})));

    const { rows: centerRows } = await db.query<{ id: string; tipo: string }>(
      "select id, tipo from public.fnb_consumption_center where id = $1 and hotel_id = $2;",
      [centerId, hotelId],
    );
    if (centerRows.length === 0) throw Errors.notFound("Centro de consumo no encontrado.");
    if (centerRows[0]!.tipo !== "almacen_central") {
      throw Errors.conflict(
        "La existencia nueva solo se recibe en el almacén central; un centro de consumo la recibe por traspaso.",
      );
    }

    await db.query(
      `insert into public.fnb_stock_item (tenant_id, hotel_id, center_id, sku, nombre, unit_cost, quantity)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (center_id, sku)
       do update set quantity = public.fnb_stock_item.quantity + excluded.quantity,
                     unit_cost = excluded.unit_cost, nombre = excluded.nombre, updated_at = now();`,
      [orgId, hotelId, centerId, body.sku, body.nombre, body.costoUnitario, body.cantidad],
    );
    return c.json({ ok: true }, 201);
  });

  app.get("/hoteles/:hotelId/fnb/centros-consumo/:centerId/existencia", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ sku: string; nombre: string; unit_cost: string; quantity: string }>(
      `select sku, nombre, unit_cost::text as unit_cost, quantity::text as quantity
       from public.fnb_stock_item where center_id = $1 and hotel_id = $2 order by nombre asc;`,
      [c.req.param("centerId"), c.req.param("hotelId")],
    );
    return c.json(
      rows.map((r) => ({ sku: r.sku, nombre: r.nombre, costoUnitario: Number(r.unit_cost), cantidad: Number(r.quantity) })),
    );
  });

  app.get("/hoteles/:hotelId/fnb/traspasos", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query(
      `select id, from_center_id, to_center_id, sku, quantity::text as quantity,
              unit_cost_snapshot::text as unit_cost_snapshot, nota, created_at::text as created_at
       from public.fnb_inventory_transfer where hotel_id = $1 order by created_at desc;`,
      [c.req.param("hotelId")],
    );
    return c.json(rows);
  });

  // Traspaso interno hacia/desde el almacén central (H10-011). `planFnbInventoryTransfer`
  // pre-valida con la existencia leída aquí (mensaje amigable, sin gastar el lock); la
  // autoridad real es `fnb_registrar_traspaso()`, que vuelve a validar todo bajo lock
  // contra la existencia real en ese instante.
  app.post("/hoteles/:hotelId/fnb/traspasos", async (c) => {
    assertRole(c, [...MANAGE_FNB_ROLES]);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(traspasoSchema, await c.req.json().catch(() => ({})));

    const { rows: centerRows } = await db.query<{ id: string; tipo: "centro_consumo" | "almacen_central" }>(
      "select id, tipo from public.fnb_consumption_center where hotel_id = $1 and id = any($2::uuid[]);",
      [hotelId, [body.fromCenterId, body.toCenterId]],
    );
    const fromCenter = centerRows.find((r) => r.id === body.fromCenterId);
    const toCenter = centerRows.find((r) => r.id === body.toCenterId);
    if (!fromCenter) throw Errors.notFound("Centro origen no encontrado.");
    if (!toCenter) throw Errors.notFound("Centro destino no encontrado.");

    const { rows: stockRows } = await db.query<{ quantity: string }>(
      "select quantity::text as quantity from public.fnb_stock_item where center_id = $1 and sku = $2;",
      [body.fromCenterId, body.sku],
    );
    const sourceQuantity = stockRows[0] ? Number(stockRows[0].quantity) : 0;

    try {
      planFnbInventoryTransfer({
        fromCenter: { id: fromCenter.id, tipo: fromCenter.tipo },
        toCenter: { id: toCenter.id, tipo: toCenter.tipo },
        sourceQuantity,
        quantity: body.cantidad,
      });
    } catch (err) {
      throw Errors.conflict(err instanceof Error ? err.message : String(err));
    }

    const { rows } = await db.query(
      `select * from public.fnb_registrar_traspaso($1, $2, $3, $4, $5, $6, $7, $8);`,
      [hotelId, orgId, body.fromCenterId, body.toCenterId, body.sku, body.cantidad, c.get("userId"), body.nota ?? null],
    );
    return c.json(rows[0], 201);
  });

  app.get("/hoteles/:hotelId/fnb/costo-desayuno/config", async (c) => {
    assertRole(c, [...READ_COST_ROLES]);
    const db = c.get("db");
    const { rows } = await db.query<{ cost_per_room_night: string }>(
      "select cost_per_room_night::text as cost_per_room_night from public.hotel_breakfast_cost_config where hotel_id = $1;",
      [c.req.param("hotelId")],
    );
    return c.json({ costoPorHabitacionNoche: rows[0] ? Number(rows[0].cost_per_room_night) : 0 });
  });

  app.put("/hoteles/:hotelId/fnb/costo-desayuno/config", async (c) => {
    assertRole(c, [...ADMIN_ROLES]);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(costoConfigSchema, await c.req.json().catch(() => ({})));

    await db.query(
      `insert into public.hotel_breakfast_cost_config (hotel_id, tenant_id, cost_per_room_night)
       values ($1, $2, $3)
       on conflict (hotel_id) do update set cost_per_room_night = excluded.cost_per_room_night, updated_at = now();`,
      [hotelId, orgId, body.costoPorHabitacionNoche],
    );
    return c.json({ costoPorHabitacionNoche: body.costoPorHabitacionNoche });
  });

  // Reporte de costo imputado (H10-012): ocupación real de `reservation` para la fecha
  // (habitaciones cuya estancia cubre `fecha`, en un estado que sí ocupa la habitación
  // físicamente) × el costo configurado. Se recalcula EN CADA LLAMADA desde datos
  // vigentes -- nunca lee un total guardado -- así que un cambio en las reservas (o en
  // la config de costo) se refleja de inmediato en la siguiente consulta, sin ningún
  // paso de invalidación de caché que se pueda olvidar.
  app.get("/hoteles/:hotelId/fnb/costo-desayuno", async (c) => {
    assertRole(c, [...READ_COST_ROLES]);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const fecha = c.req.query("fecha");
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      throw Errors.validation("El parámetro `fecha` (YYYY-MM-DD) es obligatorio.");
    }

    const { rows: occRows } = await db.query<{ occupied: string }>(
      `select count(*)::text as occupied from public.reservation
       where hotel_id = $1 and check_in_date <= $2 and check_out_date > $2
         and status in ('confirmada', 'check_in', 'en_estancia');`,
      [hotelId, fecha],
    );
    const { rows: costRows } = await db.query<{ cost_per_room_night: string }>(
      "select cost_per_room_night::text as cost_per_room_night from public.hotel_breakfast_cost_config where hotel_id = $1;",
      [hotelId],
    );

    const result = computeTheoreticalBreakfastCost({
      occupiedRoomNights: Number(occRows[0]!.occupied),
      costPerRoomNight: costRows[0] ? Number(costRows[0].cost_per_room_night) : 0,
    });
    return c.json({ fecha, ...result });
  });

  return app;
}
