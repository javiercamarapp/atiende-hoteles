// REQ-RES-021 · Contrato del servidor MCP (Model Context Protocol, spec JSON-RPC 2.0
// "tools") de disponibilidad/tarifa/reserva. Tipos/esquemas puros de protocolo --
// ningún I/O aquí (eso vive en `server.ts`).
import { z } from "zod";

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato de fecha esperado YYYY-MM-DD");

// `.strip()` (comportamiento default de zod) descarta cualquier campo no declarado --
// en particular, un `precio`/`price` que un agente externo intentara enviar nunca
// llega al SQL (GOB-039/REQ-TEN-004, mismo criterio que `experienciasPublicas.ts`).
export const buscarDisponibilidadInputSchema = z
  .object({ checkInDate: dateSchema, checkOutDate: dateSchema })
  .refine((v) => v.checkOutDate > v.checkInDate, {
    message: "checkOutDate debe ser posterior a checkInDate",
    path: ["checkOutDate"],
  });
export type BuscarDisponibilidadInput = z.infer<typeof buscarDisponibilidadInputSchema>;

export const crearReservaInputSchema = z
  .object({
    roomTypeId: z.string().uuid(),
    checkInDate: dateSchema,
    checkOutDate: dateSchema,
    guest: z.object({
      fullName: z.string().trim().min(1).max(200),
      email: z.string().trim().email().optional(),
      phone: z.string().trim().min(3).max(40).optional(),
    }),
    clientRequestId: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => v.checkOutDate > v.checkInDate, {
    message: "checkOutDate debe ser posterior a checkInDate",
    path: ["checkOutDate"],
  });
export type CrearReservaInput = z.infer<typeof crearReservaInputSchema>;

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** `tools/list` -- forma JSON Schema mínima (no zod-to-json-schema completo, que no es
 *  dependencia del repo): suficiente para que un cliente MCP real sepa qué mandar. */
export const MCP_HOTEL_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "buscar_disponibilidad",
    description:
      "Consulta disponibilidad y tarifa neta por tipo de habitación de este hotel para un rango de fechas. Devuelve datos estructurados schema.org Hotel/Offer.",
    inputSchema: {
      type: "object",
      properties: {
        checkInDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
        checkOutDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
      },
      required: ["checkInDate", "checkOutDate"],
      additionalProperties: false,
    },
  },
  {
    name: "crear_reserva",
    description:
      "Crea una reserva directa en este hotel para el tipo de habitación indicado. El precio SIEMPRE se recalcula en el servidor a partir de la tarifa vigente -- esta herramienta no acepta ningún campo de precio.",
    inputSchema: {
      type: "object",
      properties: {
        roomTypeId: { type: "string", format: "uuid" },
        checkInDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
        checkOutDate: { type: "string", format: "date", description: "YYYY-MM-DD" },
        guest: {
          type: "object",
          properties: {
            fullName: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
          },
          required: ["fullName"],
          additionalProperties: false,
        },
        clientRequestId: {
          type: "string",
          description: "Llave de idempotencia del propio agente: una segunda llamada con el mismo valor devuelve la misma reserva, nunca crea una segunda.",
        },
      },
      required: ["roomTypeId", "checkInDate", "checkOutDate", "guest"],
      additionalProperties: false,
    },
  },
];
