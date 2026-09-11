// REQ-OBS-008 (P2/OBS): `GET /hoteles/:hotelId/reportes/room-nights-directas` -- % de
// room-nights generadas directamente por el agente de IA propio del hotel, como
// métrica de producto periódica (H06-016/BP-169, "KPI de la tesis agéntica").
//
// Sin restricción de rol adicional a la membresía del hotel (mismo criterio que
// `routes/roi.ts`): es un KPI de producto/uso, no una cifra de dinero de comisión como
// `atribucionCanal.ts` (que sí restringe a PL_ROLES) -- cualquier miembro de staff del
// hotel puede consultar cuánto está generando el agente.
import { Hono } from "hono";
import { buildAgenticOriginReportForHotel } from "../domain/atribucionOrigenAgentico.ts";
import { Errors } from "../lib/errors.ts";
import { authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string | undefined, paramName: string): string {
  if (!value || !ISO_DATE_RE.test(value)) {
    throw Errors.validation(`El parámetro "${paramName}" es obligatorio y debe tener formato YYYY-MM-DD.`);
  }
  return value;
}

export function roomNightsDirectasRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/reportes/room-nights-directas",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/reportes/room-nights-directas", async (c) => {
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const desde = parseIsoDate(c.req.query("desde"), "desde");
    const hasta = parseIsoDate(c.req.query("hasta"), "hasta");
    if (desde > hasta) throw Errors.validation('El parámetro "desde" no puede ser posterior a "hasta".');

    const report = await buildAgenticOriginReportForHotel(db, hotelId, desde, hasta);
    return c.json(report);
  });

  return app;
}
