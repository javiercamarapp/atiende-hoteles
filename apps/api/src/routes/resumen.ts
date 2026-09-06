// H2 · GET /hoteles/:hotelId/resumen — contrato apps/web `obtenerResumen()`.
import { Hono } from "hono";
import { calcularResumen } from "../domain/resumen.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

export function resumenRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use("/hoteles/:hotelId/resumen", authMiddleware(deps.env), dbSession(deps.engine), requireHotelMembership("hotelId"));
  app.get("/hoteles/:hotelId/resumen", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const kpis = await calcularResumen(db, hotelId);
    return c.json(kpis);
  });

  return app;
}
