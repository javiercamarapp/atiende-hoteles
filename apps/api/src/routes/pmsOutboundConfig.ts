// H18 · conector-pms-enterprise: /hoteles/:hotelId/integraciones/pms-outbound --
// configuración por hotel del conector outbound genérico (packages/mcp-servers/outbound
// `OutboundTaskSyncPort`, ver docs/integraciones/conector-pms-enterprise.md) que empuja
// housekeeping_task/maintenance_ticket/guest_ticket al sistema propio del hotel de
// cadena (HotSOS/Optii-style). Mismo patrón que routes/mensajeria.ts (webhook_secret de
// `hotel_messaging_config`) -- pero, a diferencia de ese, SOLO owner/gm pueden ver o
// modificar `webhook_url`/`webhook_secret` (ver comentario de la migración 0127: es una
// credencial de integración técnica hacia el sistema del hotel, no algo que frontdesk
// necesite para soporte de primer nivel).
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { outboundTaskTypes } from "@atiende-hoteles/mcp-outbound";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const taskTypeEnum = z.enum(outboundTaskTypes);

const putConfigSchema = z.object({
  webhookUrl: z.string().trim().url().max(500),
  taskTypes: z.array(taskTypeEnum).min(1).default([...outboundTaskTypes]),
  enabled: z.boolean().default(false),
  /** Si se omite, se conserva el secreto ya guardado (o se genera uno nuevo la primera
   *  vez) -- nunca se obliga a re-teclear el secreto solo para cambiar la URL/`enabled`. */
  rotateSecret: z.boolean().default(false),
});

interface ConfigRow {
  webhook_url: string;
  webhook_secret: string;
  task_types: string[];
  enabled: boolean;
  updated_at: string;
}

function serializeConfig(row: ConfigRow) {
  return {
    webhookUrl: row.webhook_url,
    // El secreto SÍ se devuelve (solo owner/gm llegan aquí, ver RLS de la migración
    // 0127): es la única forma de que quien lo configuró pueda copiarlo al sistema del
    // hotel del otro lado -- mismo criterio que `hotel_messaging_config` con frontdesk.
    webhookSecret: row.webhook_secret,
    taskTypes: row.task_types,
    enabled: row.enabled,
    actualizadoEn: row.updated_at,
  };
}

export function pmsOutboundConfigRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/integraciones/pms-outbound",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/integraciones/pms-outbound", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const { rows } = await db.query<ConfigRow>(
      `select webhook_url, webhook_secret, task_types, enabled, updated_at::text as updated_at
       from public.hotel_pms_outbound_config where hotel_id = $1;`,
      [c.req.param("hotelId")],
    );
    if (!rows[0]) return c.json({ configurado: false });
    return c.json({ configurado: true, ...serializeConfig(rows[0]) });
  });

  app.put("/hoteles/:hotelId/integraciones/pms-outbound", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(putConfigSchema, await c.req.json().catch(() => ({})));

    const { rows: existingRows } = await db.query<{ webhook_secret: string }>(
      "select webhook_secret from public.hotel_pms_outbound_config where hotel_id = $1;",
      [hotelId],
    );
    const webhookSecret =
      body.rotateSecret || !existingRows[0] ? randomBytes(32).toString("hex") : existingRows[0].webhook_secret;

    const { rows } = await db.query<ConfigRow>(
      `insert into public.hotel_pms_outbound_config
         (hotel_id, tenant_id, webhook_url, webhook_secret, task_types, enabled)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (hotel_id) do update
         set webhook_url = excluded.webhook_url,
             webhook_secret = excluded.webhook_secret,
             task_types = excluded.task_types,
             enabled = excluded.enabled,
             updated_at = now()
       returning webhook_url, webhook_secret, task_types, enabled, updated_at::text as updated_at;`,
      [hotelId, orgId, body.webhookUrl, webhookSecret, body.taskTypes, body.enabled],
    );
    if (!rows[0]) throw Errors.validation("No se pudo guardar la configuración del conector.");
    return c.json({ configurado: true, ...serializeConfig(rows[0]) });
  });

  app.delete("/hoteles/:hotelId/integraciones/pms-outbound", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    await db.query("delete from public.hotel_pms_outbound_config where hotel_id = $1;", [c.req.param("hotelId")]);
    return c.json({ configurado: false });
  });

  return app;
}
