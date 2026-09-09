// REQ-RES-020 (P1/F): `GET /hoteles/:hotelId/reportes/atribucion-canal` -- reporte de
// atribución de canal/agente de origen (room-nights por canal, ingreso neto, comisión
// calculada, room-nights directas y su %) + `GET`/`PUT` de
// `hotel_channel_commission` (comisión configurable por canal, mismo patrón que
// `hotel_cancellation_policy` en routes/tarifas.ts).
//
// Restringido a `PL_ROLES` (owner/gm/accountant, ver routes/plUsali.ts): es
// información financiera de comisión/ingreso por canal, mismo nivel de sensibilidad
// que el P&L.
import { Hono } from "hono";
import { z } from "zod";
import { assertValidChannelCommissionConfig, DIRECT_CHANNEL } from "@atiende-hoteles/domain-hotel";
import { buildChannelAttributionReportForHotel, loadChannelCommissionConfig } from "../domain/atribucionCanal.ts";
import { PL_ROLES } from "./plUsali.ts";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string | undefined, paramName: string): string {
  if (!value || !ISO_DATE_RE.test(value)) {
    throw Errors.validation(`El parámetro "${paramName}" es obligatorio y debe tener formato YYYY-MM-DD.`);
  }
  return value;
}

const commissionConfigSchema = z.object({
  channel: z
    .string()
    .trim()
    .min(1)
    .refine((v) => v !== DIRECT_CHANNEL, { message: `'${DIRECT_CHANNEL}' nunca paga comisión, no se configura` }),
  commissionPct: z.number().min(0).max(100),
});

export function atribucionCanalRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/reportes/atribucion-canal",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );
  app.use(
    "/hoteles/:hotelId/comision-canal*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/reportes/atribucion-canal", async (c) => {
    assertRole(c, PL_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const desde = parseIsoDate(c.req.query("desde"), "desde");
    const hasta = parseIsoDate(c.req.query("hasta"), "hasta");
    if (desde > hasta) throw Errors.validation('El parámetro "desde" no puede ser posterior a "hasta".');

    const report = await buildChannelAttributionReportForHotel(db, hotelId, desde, hasta);
    return c.json(report);
  });

  app.get("/hoteles/:hotelId/comision-canal", async (c) => {
    assertRole(c, PL_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const configs = await loadChannelCommissionConfig(db, hotelId);
    return c.json({ canales: configs });
  });

  // Alta/actualización idempotente por (hotelId, channel) vía upsert -- solo
  // owner/gm dan de alta comisión de dinero real (mismo criterio de
  // `hotel_cancellation_policy`), no basta con PL_ROLES (accountant queda excluido de
  // ESCRIBIR la tasa, aunque sí puede leerla arriba).
  app.put("/hoteles/:hotelId/comision-canal", async (c) => {
    assertRole(c, ["owner", "gm"]);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(commissionConfigSchema, await c.req.json().catch(() => ({})));

    try {
      assertValidChannelCommissionConfig(body);
    } catch (err) {
      throw Errors.validation(err instanceof Error ? err.message : String(err));
    }

    await db.query(
      `insert into public.hotel_channel_commission (hotel_id, tenant_id, channel, commission_pct)
       values ($1, $2, $3, $4)
       on conflict (hotel_id, channel) do update set commission_pct = excluded.commission_pct, updated_at = now();`,
      [hotelId, orgId, body.channel, body.commissionPct],
    );

    return c.json({ channel: body.channel, commissionPct: body.commissionPct });
  });

  return app;
}
