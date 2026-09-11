// REQ-RES-021 (BP-021, H06-004/H06-010/H06-011/H06-012/H06-013, H07-038): servidor MCP
// público de disponibilidad/tarifa/reserva -- UN endpoint JSON-RPC 2.0, sin sesión de
// staff, autenticado por API key de agente MCP (`Authorization: Bearer <api key>`,
// emitida vía `routes/mcpAgentes.ts`). Mismo criterio de ruta pública que
// `cancelacionPublica.ts`/`experienciasPublicas.ts`: usa `deps.engine.admin` (sin RLS
// de staff) porque quien llama nunca tiene un `hotel_staff`, y TODA la lógica de
// negocio vive en las funciones `SECURITY DEFINER` de la migración 0130 -- este
// archivo es solo transporte HTTP<->JSON-RPC, nunca toca una tabla de negocio
// directamente. El rate limit por IP ya aplica globalmente (`ipRateLimit`,
// apps/api/src/app.ts), igual que en esas dos rutas.
import { Hono } from "hono";
import { extractBearerApiKey, handleMcpHotelRequest, hashMcpAgentApiKey, McpToolError, resolveMcpAgentContext } from "@atiende-hoteles/mcp-hotel";
import { Errors } from "../lib/errors.ts";
import type { AppDeps, HonoEnvBindings } from "../types.ts";

export function mcpHotelRoutes(deps: AppDeps): Hono<HonoEnvBindings> {
  const app = new Hono<HonoEnvBindings>();

  app.post("/mcp/reservas", async (c) => {
    const apiKey = extractBearerApiKey(c.req.header("authorization"));
    if (!apiKey) throw Errors.unauthorized("Falta el header Authorization: Bearer <api key>.");

    let ctx;
    try {
      ctx = await resolveMcpAgentContext(deps.engine.admin, hashMcpAgentApiKey(apiKey));
    } catch (err) {
      if (err instanceof McpToolError) throw Errors.unauthorized("API key inválida o revocada.");
      throw err;
    }

    const body = await c.req.json().catch(() => null);
    if (body === null) throw Errors.validation("Cuerpo JSON-RPC inválido.");

    // JSON-RPC 2.0 sobre HTTP: la respuesta SIEMPRE es 200 -- tanto un error de
    // protocolo (método desconocido) como un error de herramienta (sin tarifa,
    // credencial revocada a mitad de reserva) viajan DENTRO del sobre JSON-RPC
    // (`error`/`result.isError`), nunca como status HTTP -- mismo criterio que
    // cualquier transporte JSON-RPC/MCP real.
    const response = await handleMcpHotelRequest(deps.engine.admin, ctx, body);
    return c.json(response, 200);
  });

  return app;
}
