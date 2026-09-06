// H2 · /hoteles/:hotelId/huespedes — contrato apps/web `listarHuespedes()`
// (Huesped[] = {id, nombre, email, estancias}), + GET :id y POST crear.
import { Hono } from "hono";
import { z } from "zod";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const createGuestSchema = z.object({
  nombre: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().optional().nullable(),
  telefono: z.string().trim().max(40).optional().nullable(),
});

export function huespedesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  // RENDIMIENTO: un solo `app.use` (patrón "path*") -- registrar la ruta exacta Y
  // "/huespedes/*" por separado ejecutaba AMBOS middlewares para
  // "/hoteles/:hotelId/huespedes" (Hono hace match de "/huespedes/*" incluso sin
  // segmento adicional), abriendo dos conexiones del pool por request.
  app.use(
    "/hoteles/:hotelId/huespedes*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/huespedes", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<{ id: string; nombre: string; email: string | null; estancias: string }>(
      `select g.id, g.full_name as nombre, g.email,
              count(r.id)::text as estancias
       from public.guest g
       left join public.reservation r on r.guest_id = g.id
       where g.hotel_id = $1
       group by g.id, g.full_name, g.email
       order by g.full_name asc;`,
      [hotelId],
    );
    return c.json(rows.map((r) => ({ id: r.id, nombre: r.nombre, email: r.email, estancias: Number(r.estancias) })));
  });

  app.get("/hoteles/:hotelId/huespedes/:guestId", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ id: string; nombre: string; email: string | null; telefono: string | null }>(
      `select id, full_name as nombre, email, phone as telefono from public.guest
       where id = $1 and hotel_id = $2;`,
      [c.req.param("guestId"), c.req.param("hotelId")],
    );
    if (rows.length === 0) throw Errors.notFound("Huésped no encontrado.");
    return c.json(rows[0]);
  });

  app.post("/hoteles/:hotelId/huespedes", async (c) => {
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(createGuestSchema, await c.req.json().catch(() => ({})));

    const { rows } = await db.query<{ id: string }>(
      `insert into public.guest (tenant_id, hotel_id, full_name, email, phone)
       values ($1, $2, $3, $4, $5)
       returning id;`,
      [orgId, hotelId, body.nombre, body.email ?? null, body.telefono ?? null],
    );

    return c.json({ id: rows[0]!.id, nombre: body.nombre, email: body.email ?? null }, 201);
  });

  return app;
}
