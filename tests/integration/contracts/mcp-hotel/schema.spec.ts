// REQ-RES-021 · docs/ACEPTACION.md: "Servidor MCP expone disponibilidad/tarifa/reserva
// con datos estructurados schema.org Hotel/Offer; un cliente MCP externo simulado
// obtiene respuesta en segundos (<5s medido) y valida contra el esquema." Este archivo
// es el "cliente MCP externo simulado": llama `POST /mcp/reservas` (JSON-RPC 2.0,
// `initialize`/`tools/list`/`tools/call`) exactamente como lo haría un agente real, sin
// ninguna sesión de staff -- solo la API key emitida por `POST
// /hoteles/:hotelId/mcp-agentes` (owner/gm). Contra `embedded-postgres` real (H1/ADR-003).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hotelAvailabilityJsonLdSchema, type HotelAvailabilityJsonLd } from "@atiende-hoteles/domain-hotel";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../../../support/api-fixture.ts";

interface JsonRpcResult {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function resultContentText(body: JsonRpcResult): string {
  const content = body.result?.content as { type: string; text: string }[] | undefined;
  return content?.[0]?.text ?? "";
}

interface BookingResult {
  reservationId: string;
  confirmationCode: string;
  netAmount: number;
  currency: string;
  channel: string;
  yaRegistrado: boolean;
}

describe("servidor MCP de disponibilidad/tarifa/reserva (REQ-RES-021, embedded-postgres real)", () => {
  let fixture: ApiFixture;
  let hotelId: string;
  let roomTypeId: string;
  let checkInDate: string;
  let checkOutDate: string;
  let apiKey: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    hotelId = hotelA.id;
    roomTypeId = hotelA.roomTypes[0]!.id;

    const { rows: dates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelId, roomTypeId],
    );
    checkInDate = dates[0]!.date;
    checkOutDate = dates[1]!.date;

    const ownerToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "owner")!.email);
    const created = await fixture.app.request(`/hoteles/${hotelId}/mcp-agentes`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Agente MCP de prueba" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { apiKey: string };
    apiKey = body.apiKey;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function mcpCall(method: string, params?: unknown, headers: Record<string, string> = { authorization: `Bearer ${apiKey}` }) {
    return fixture.app.request("/mcp/reservas", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  }

  it("rechaza sin Authorization (401, sin exponer ninguna herramienta)", async () => {
    const res = await mcpCall("tools/list", undefined, {});
    expect(res.status).toBe(401);
  });

  it("rechaza una API key inexistente (401, mensaje genérico)", async () => {
    const res = await mcpCall("tools/list", undefined, { authorization: "Bearer mcp_live_no-existe" });
    expect(res.status).toBe(401);
  });

  it("tools/list expone buscar_disponibilidad y crear_reserva", async () => {
    const res = await mcpCall("tools/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResult;
    const tools = body.result?.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["buscar_disponibilidad", "crear_reserva"]));
  });

  it("buscar_disponibilidad responde en <5s con JSON-LD Hotel/Offer que valida contra el esquema", async () => {
    const start = Date.now();
    const res = await mcpCall("tools/call", { name: "buscar_disponibilidad", arguments: { checkInDate, checkOutDate } });
    const elapsedMs = Date.now() - start;

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(5000);

    const body = (await res.json()) as JsonRpcResult;
    const jsonLd = body.result!.structuredContent as HotelAvailabilityJsonLd;
    expect(() => hotelAvailabilityJsonLdSchema.parse(jsonLd)).not.toThrow();
    expect(jsonLd["@id"]).toBe(hotelId);

    const offer = jsonLd.makesOffer.find((o) => o["@id"] === roomTypeId);
    expect(offer).toBeDefined();
    expect(offer!.availability).toBe("https://schema.org/InStock");
    expect(offer!.priceSpecification!.price).toBeGreaterThan(0);
  });

  it("crear_reserva crea una reserva real (channel=agente_ia_externo) sin que la herramienta acepte ningún precio", async () => {
    const clientRequestId = randomUUID();
    const res = await mcpCall("tools/call", {
      name: "crear_reserva",
      arguments: {
        roomTypeId,
        checkInDate,
        checkOutDate,
        guest: { fullName: "Ana Externa", email: "ana.externa@example.com" },
        clientRequestId,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.result!.isError).toBeUndefined();
    const booking = body.result!.structuredContent as BookingResult;
    expect(booking.yaRegistrado).toBe(false);
    expect(booking.netAmount).toBeGreaterThan(0);

    const { rows } = await fixture.engine.admin.query<{ channel: string; total_amount: string; guest_id: string }>(
      "select channel, total_amount::text as total_amount, guest_id from public.reservation where id = $1;",
      [booking.reservationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("agente_ia_externo");
    expect(Number(rows[0]!.total_amount)).toBe(booking.netAmount);

    const { rows: guestRows } = await fixture.engine.admin.query<{ full_name: string }>(
      "select full_name from public.guest where id = $1;",
      [rows[0]!.guest_id],
    );
    expect(guestRows[0]!.full_name).toBe("Ana Externa");
  });

  it("idempotencia: la misma clientRequestId nunca duplica la reserva", async () => {
    const clientRequestId = randomUUID();
    const args = { roomTypeId, checkInDate, checkOutDate, guest: { fullName: "Beto Externo" }, clientRequestId };

    const first = await mcpCall("tools/call", { name: "crear_reserva", arguments: args });
    const firstBooking = ((await first.json()) as JsonRpcResult).result!.structuredContent as BookingResult;
    expect(firstBooking.yaRegistrado).toBe(false);

    const second = await mcpCall("tools/call", { name: "crear_reserva", arguments: args });
    const secondBooking = ((await second.json()) as JsonRpcResult).result!.structuredContent as BookingResult;
    expect(secondBooking.yaRegistrado).toBe(true);
    expect(secondBooking.reservationId).toBe(firstBooking.reservationId);

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.reservation where mcp_client_request_id = $1;",
      [clientRequestId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("caso negativo: agota el inventario y la siguiente reserva falla con sin_disponibilidad, sin sobrepasar el máximo configurado", async () => {
    const { rows: beforeRows } = await fixture.engine.admin.query<{ disponibles: number }>(
      "select min(total_rooms - booked_rooms)::int as disponibles from public.availability where hotel_id=$1 and room_type_id=$2 and date >= $3 and date < $4;",
      [hotelId, roomTypeId, checkInDate, checkOutDate],
    );
    const disponibles = beforeRows[0]!.disponibles;

    for (let i = 0; i < disponibles; i += 1) {
      const res = await mcpCall("tools/call", {
        name: "crear_reserva",
        arguments: { roomTypeId, checkInDate, checkOutDate, guest: { fullName: `Huésped agotador ${i}` }, clientRequestId: randomUUID() },
      });
      const body = (await res.json()) as JsonRpcResult;
      expect(body.result!.isError, `la reserva ${i} debía tener cupo`).toBeUndefined();
    }

    const overRes = await mcpCall("tools/call", {
      name: "crear_reserva",
      arguments: { roomTypeId, checkInDate, checkOutDate, guest: { fullName: "Sin cupo" }, clientRequestId: randomUUID() },
    });
    expect(overRes.status).toBe(200);
    const overBody = (await overRes.json()) as JsonRpcResult;
    expect(overBody.result!.isError).toBe(true);
    expect(resultContentText(overBody)).toContain("sin_disponibilidad");

    const { rows: afterRows } = await fixture.engine.admin.query<{ booked_rooms: number; total_rooms: number }>(
      "select booked_rooms, total_rooms from public.availability where hotel_id=$1 and room_type_id=$2 and date=$3;",
      [hotelId, roomTypeId, checkInDate],
    );
    expect(afterRows[0]!.booked_rooms).toBe(afterRows[0]!.total_rooms);
  });

  it("un método JSON-RPC desconocido responde con error de protocolo dentro del sobre 200", async () => {
    const res = await mcpCall("metodo/inexistente");
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.error?.code).toBe(-32601);
  });
});
