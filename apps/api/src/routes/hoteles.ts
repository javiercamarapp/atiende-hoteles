// H2 · GET /hoteles: hoteles del usuario autenticado (contrato de apps/web/src/lib/api.ts
// `listarHoteles()` → `Hotel[] = {id, nombre}`). Vía RLS (current_hotel_ids()), nunca
// filtrado a mano en la aplicación.
import { Hono } from "hono";
import { authMiddleware, dbSession } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

export function hotelesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use("/hoteles", authMiddleware(deps.env), dbSession(deps.engine));
  app.get("/hoteles", async (c) => {
    const db = c.get("db");
    const { rows } = await db.query<{ id: string; nombre: string }>(
      "select h.id as id, l.name as nombre from public.hotel h join public.location l on l.id = h.id order by l.name asc;",
    );
    return c.json(rows);
  });

  return app;
}
