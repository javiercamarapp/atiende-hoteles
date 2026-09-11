// REQ-RES-021 · Gestión (staff, owner/gm) de credenciales de agentes MCP externos --
// contraparte administrativa de `routes/mcpHotel.ts` (el endpoint público que un
// agente de IA externo consulta). Emitir/revocar una API key es una decisión de
// negocio (quién puede reservar en nombre del hotel), mismo criterio de rol que
// `hotel_channel_commission`/`hotel_tax_config` (ver migración 0130).
import { Hono } from "hono";
import { z } from "zod";
import { generateMcpAgentApiKey, hashMcpAgentApiKey } from "@atiende-hoteles/mcp-hotel";
import { Errors } from "../lib/errors.ts";
import { parseBody } from "../lib/validate.ts";
import { assertRole, authMiddleware, dbSession, requireHotelMembership } from "../middleware.ts";
import { ADMIN_ROLES } from "../domain/roles.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

const crearAgenteSchema = z.object({ name: z.string().trim().min(1).max(200) });

interface AgentRow {
  id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export function mcpAgentesRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.use(
    "/hoteles/:hotelId/mcp-agentes*",
    authMiddleware(deps.env),
    dbSession(deps.engine),
    requireHotelMembership("hotelId"),
  );

  app.get("/hoteles/:hotelId/mcp-agentes", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const { rows } = await db.query<AgentRow>(
      `select id, name, created_at::text as created_at, revoked_at::text as revoked_at, last_used_at::text as last_used_at
       from public.mcp_agent_credential
       where hotel_id = $1
       order by created_at desc;`,
      [hotelId],
    );
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
        lastUsedAt: r.last_used_at,
      })),
    );
  });

  // La API key en claro SOLO se devuelve en esta respuesta -- nunca se puede
  // recuperar después (ni siquiera un owner/gm puede verla de nuevo): perderla
  // implica revocar esta credencial y emitir una nueva. Mismo criterio que
  // cualquier proveedor real de API keys (Stripe, GitHub, etc.).
  app.post("/hoteles/:hotelId/mcp-agentes", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const orgId = c.get("orgId");
    const hotelId = c.req.param("hotelId");
    const body = parseBody(crearAgenteSchema, await c.req.json().catch(() => ({})));

    const apiKey = generateMcpAgentApiKey();
    const apiKeyHash = hashMcpAgentApiKey(apiKey);

    const { rows } = await db.query<{ id: string; created_at: string }>(
      `insert into public.mcp_agent_credential (tenant_id, hotel_id, name, api_key_hash)
       values ($1, $2, $3, $4)
       returning id, created_at::text as created_at;`,
      [orgId, hotelId, body.name, apiKeyHash],
    );
    const created = rows[0]!;
    return c.json({ id: created.id, name: body.name, apiKey, createdAt: created.created_at }, 201);
  });

  app.delete("/hoteles/:hotelId/mcp-agentes/:agentId", async (c) => {
    assertRole(c, ADMIN_ROLES);
    const db = c.get("db");
    const hotelId = c.req.param("hotelId");
    const agentId = c.req.param("agentId");

    const { rows } = await db.query<{ id: string }>(
      `update public.mcp_agent_credential
       set revoked_at = now()
       where id = $1 and hotel_id = $2 and revoked_at is null
       returning id;`,
      [agentId, hotelId],
    );
    if (rows.length === 0) throw Errors.notFound("Agente MCP no encontrado o ya revocado.");
    return c.json({ id: rows[0]!.id, revoked: true });
  });

  return app;
}
