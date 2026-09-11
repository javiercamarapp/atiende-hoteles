// REQ-RES-021 (BP-021, H06-004/H06-010/H06-011/H06-012/H06-013, H07-038): implementación
// I/O del servidor MCP de disponibilidad/tarifa/reserva -- protocolo JSON-RPC 2.0
// "tools" (mismo subconjunto que `initialize`/`tools/list`/`tools/call` de la
// especificación MCP), toda la escritura/lectura de negocio delegada a las funciones
// `SECURITY DEFINER` de la migración 0130 (`verify_mcp_agent_credential`,
// `list_mcp_hotel_availability`, `book_reservation_mcp_agent`) -- este archivo nunca
// toca `rate_plan`/`reservation`/`guest` directamente.
import type { DbClient } from "@atiende-hoteles/db";
import { buildHotelAvailabilityJsonLd, type HotelAvailabilityJsonLd, type RoomTypeAvailabilityInput } from "@atiende-hoteles/domain-hotel";
import {
  buscarDisponibilidadInputSchema,
  crearReservaInputSchema,
  jsonRpcRequestSchema,
  MCP_HOTEL_TOOLS,
  type JsonRpcResponse,
} from "./port.ts";

export class McpToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
  }
}

/** Identidad ya verificada de un agente MCP externo (ver `resolveMcpAgentContext`) --
 *  `apiKeyHash` viaja hasta `book_reservation_mcp_agent` porque esa función SIEMPRE
 *  reverifica la credencial por su cuenta (GOB-039: autocontenida, nunca confía en un
 *  `agentId`/`hotelId` que el proceso Node de por medio pudiera afirmar sin probarlo). */
export interface McpHotelAgentContext {
  readonly agentId: string;
  readonly hotelId: string;
  readonly hotelName: string;
  readonly apiKeyHash: string;
}

/** Resuelve una API key ya hasheada (nunca en claro, ver `credentials.ts`) al hotel que
 *  autoriza -- lanza `McpToolError("credencial_mcp_invalida", ...)` fail-closed ante
 *  cualquier ambigüedad (key inexistente, revocada, o cualquier otro error de BD),
 *  mismo criterio "un solo mensaje genérico" que `cancel_reservation_public`. */
export async function resolveMcpAgentContext(db: DbClient, apiKeyHash: string): Promise<McpHotelAgentContext> {
  let rows: { agent_id: string; hotel_id: string; tenant_id: string; hotel_name: string }[];
  try {
    const result = await db.query<{ agent_id: string; hotel_id: string; tenant_id: string; hotel_name: string }>(
      "select * from public.verify_mcp_agent_credential($1);",
      [apiKeyHash],
    );
    rows = result.rows;
  } catch {
    throw new McpToolError("credencial_mcp_invalida", "API key inválida o revocada.");
  }
  const row = rows[0];
  if (!row) throw new McpToolError("credencial_mcp_invalida", "API key inválida o revocada.");
  return { agentId: row.agent_id, hotelId: row.hotel_id, hotelName: row.hotel_name, apiKeyHash };
}

interface AvailabilityRow {
  room_type_id: string;
  room_type_name: string;
  disponibles: number;
  net_amount: string | null;
  currency: string | null;
  reason: string | null;
}

async function callBuscarDisponibilidad(
  db: DbClient,
  ctx: McpHotelAgentContext,
  args: unknown,
): Promise<HotelAvailabilityJsonLd> {
  const input = buscarDisponibilidadInputSchema.parse(args);
  const { rows } = await db.query<AvailabilityRow>(
    "select * from public.list_mcp_hotel_availability($1, $2, $3);",
    [ctx.hotelId, input.checkInDate, input.checkOutDate],
  );
  const roomTypes: RoomTypeAvailabilityInput[] = rows.map((r) => ({
    roomTypeId: r.room_type_id,
    roomTypeName: r.room_type_name,
    disponibles: r.disponibles,
    netAmount: r.net_amount != null ? Number(r.net_amount) : null,
    currency: r.currency ?? "MXN",
    reason: r.reason,
  }));
  return buildHotelAvailabilityJsonLd({
    hotelId: ctx.hotelId,
    hotelName: ctx.hotelName,
    checkInDate: input.checkInDate,
    checkOutDate: input.checkOutDate,
    roomTypes,
  });
}

interface BookingRow {
  reservation_id: string;
  confirmation_code: string;
  net_amount: string;
  currency: string;
  ya_registrado: boolean;
}

// Prefijo de excepción `raise exception '<code>: mensaje'` (migración 0130) -> código
// corto de máquina, mismo vocabulario que `QuoteError.code` en
// `packages/domain-hotel/src/quote.ts` cuando aplica.
function extractPgErrorCode(message: string): string {
  const match = /^([a-z0-9_]+):/i.exec(message);
  return match?.[1] ?? "error_desconocido";
}

async function callCrearReserva(db: DbClient, ctx: McpHotelAgentContext, args: unknown) {
  const input = crearReservaInputSchema.parse(args);
  try {
    const { rows } = await db.query<BookingRow>(
      "select * from public.book_reservation_mcp_agent($1, $2, $3, $4, $5, $6, $7, $8);",
      [
        ctx.apiKeyHash,
        input.roomTypeId,
        input.checkInDate,
        input.checkOutDate,
        input.guest.fullName,
        input.guest.email ?? null,
        input.guest.phone ?? null,
        input.clientRequestId ?? null,
      ],
    );
    const row = rows[0]!;
    return {
      reservationId: row.reservation_id,
      confirmationCode: row.confirmation_code,
      netAmount: Number(row.net_amount),
      currency: row.currency,
      channel: "agente_ia_externo" as const,
      yaRegistrado: row.ya_registrado,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new McpToolError(extractPgErrorCode(message), message);
  }
}

interface ToolCallParams {
  name: string;
  arguments?: unknown;
}

async function handleToolCall(db: DbClient, ctx: McpHotelAgentContext, id: string | number | null, params: unknown): Promise<JsonRpcResponse> {
  const { name, arguments: args } = (params ?? {}) as Partial<ToolCallParams>;
  try {
    switch (name) {
      case "buscar_disponibilidad": {
        const jsonLd = await callBuscarDisponibilidad(db, ctx, args);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(jsonLd) }], structuredContent: jsonLd },
        };
      }
      case "crear_reserva": {
        const booking = await callCrearReserva(db, ctx, args);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(booking) }], structuredContent: booking },
        };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Herramienta desconocida: ${String(name)}` } };
    }
  } catch (err) {
    // Un error de NEGOCIO (sin tarifa, sin disponibilidad, credencial inválida a mitad
    // de una reserva ya en curso, validación de zod) se reporta como resultado de
    // herramienta con `isError: true` (protocolo MCP), NUNCA como excepción JSON-RPC de
    // transporte -- el `tools/call` en sí se completó, la herramienta fue la que falló.
    const code = err instanceof McpToolError ? err.code : "solicitud_invalida";
    const message = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `${code}: ${message}` }], isError: true },
    };
  }
}

/**
 * Punto de entrada único del servidor MCP: un mensaje JSON-RPC 2.0 -> una respuesta.
 * `ctx` ya viene resuelto (`resolveMcpAgentContext`) -- este handler nunca ve la API key
 * en claro.
 */
export async function handleMcpHotelRequest(db: DbClient, ctx: McpHotelAgentContext, raw: unknown): Promise<JsonRpcResponse> {
  const parsed = jsonRpcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Solicitud JSON-RPC inválida." } };
  }
  const { id: rawId, method, params } = parsed.data;
  const id = rawId ?? null;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "atiende-hoteles-mcp", version: "1.0.0" },
        },
      };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_HOTEL_TOOLS } };
    case "tools/call":
      return handleToolCall(db, ctx, id, params);
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Método no soportado: ${method}` } };
  }
}
