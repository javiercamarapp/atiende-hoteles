// REQ-RES-021 (BP-021/H06-004/H06-011) · el servidor MCP expone RESERVA (dinero real,
// identidad de huésped) a un llamador que NUNCA tiene sesión de staff -- misma
// categoría adversarial que REQ-TEN-004/GOB-039 (rpc-security-definer.spec.ts). Esta
// suite ataca los tres vectores obvios de un agente externo malicioso o mal
// configurado: credencial revocada, cruce de hotel/tenant, e inyección de precio.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiFixture, destroyApiFixture, loginAs, type ApiFixture } from "../support/api-fixture.ts";

interface JsonRpcResult {
  result?: { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
}

describe("servidor MCP de reservas -- adversarial (REQ-RES-021)", () => {
  let fixture: ApiFixture;
  let hotelAId: string;
  let hotelBId: string;
  let roomTypeAId: string;
  let roomTypeBId: string;
  let checkInDate: string;
  let checkOutDate: string;
  let apiKeyHotelA: string;
  let agentIdHotelA: string;

  beforeAll(async () => {
    fixture = await createApiFixture();
    const hotelA = fixture.seed.hotels[0]!;
    const hotelB = fixture.seed.hotels[1]!;
    hotelAId = hotelA.id;
    hotelBId = hotelB.id;
    roomTypeAId = hotelA.roomTypes[0]!.id;
    roomTypeBId = hotelB.roomTypes[0]!.id;

    const { rows: dates } = await fixture.engine.admin.query<{ date: string }>(
      "select date::text as date from public.availability where hotel_id = $1 and room_type_id = $2 order by date asc;",
      [hotelAId, roomTypeAId],
    );
    checkInDate = dates[0]!.date;
    checkOutDate = dates[1]!.date;

    const ownerToken = await loginAs(fixture.app, hotelA.staff.find((s) => s.role === "owner")!.email);
    const created = await fixture.app.request(`/hoteles/${hotelAId}/mcp-agentes`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Agente hotel A" }),
    });
    const body = (await created.json()) as { id: string; apiKey: string };
    apiKeyHotelA = body.apiKey;
    agentIdHotelA = body.id;
  });

  afterAll(async () => {
    await destroyApiFixture(fixture);
  });

  function mcpCall(apiKey: string, method: string, params?: unknown) {
    return fixture.app.request("/mcp/reservas", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  }

  it("una credencial revocada es rechazada de inmediato (401), incluso para tools/list", async () => {
    await fixture.engine.admin.query("update public.mcp_agent_credential set revoked_at = now() where id = $1;", [agentIdHotelA]);
    const res = await mcpCall(apiKeyHotelA, "tools/list");
    expect(res.status).toBe(401);
    // Restaura para el resto de la suite (cada `it` de este archivo comparte fixture).
    await fixture.engine.admin.query("update public.mcp_agent_credential set revoked_at = null where id = $1;", [agentIdHotelA]);
  });

  it("un agente del hotel A NO puede reservar un tipo de habitación del hotel B (0 reservas creadas)", async () => {
    const res = await mcpCall(apiKeyHotelA, "tools/call", {
      name: "crear_reserva",
      arguments: {
        roomTypeId: roomTypeBId,
        checkInDate,
        checkOutDate,
        guest: { fullName: "Atacante Cruzado" },
        clientRequestId: randomUUID(),
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0]!.text).toContain("tipo_habitacion_invalido");

    const { rows } = await fixture.engine.admin.query<{ count: string }>(
      "select count(*)::text as count from public.reservation where hotel_id = $1 and room_type_id = $2 and guest_id in (select id from public.guest where full_name = 'Atacante Cruzado');",
      [hotelBId, roomTypeBId],
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("un precio/total inyectado en los argumentos de crear_reserva es ignorado -- el monto persistido es SIEMPRE el de rate_plan", async () => {
    const clientRequestId = randomUUID();
    const res = await mcpCall(apiKeyHotelA, "tools/call", {
      name: "crear_reserva",
      arguments: {
        roomTypeId: roomTypeAId,
        checkInDate,
        checkOutDate,
        guest: { fullName: "Cliente Honesto" },
        clientRequestId,
        // Campos que un agente malicioso (o un LLM "creativo") podría intentar --
        // zod los descarta (`.strip()` default, ver `port.ts`) antes de llegar a SQL.
        precio: 0.01,
        price: 0.01,
        total: 0.01,
        netAmount: 0.01,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcResult;
    expect(body.result!.isError).toBeUndefined();
    const booking = body.result!.structuredContent as { reservationId: string; netAmount: number };
    expect(booking.netAmount).toBeGreaterThan(1); // la tarifa real sembrada es de cientos/miles de MXN, nunca 0.01.

    const { rows } = await fixture.engine.admin.query<{ total_amount: string }>(
      "select total_amount::text as total_amount from public.reservation where id = $1;",
      [booking.reservationId],
    );
    expect(Number(rows[0]!.total_amount)).toBe(booking.netAmount);
    expect(Number(rows[0]!.total_amount)).not.toBe(0.01);
  });

  it("un nombre de huésped vacío es rechazado (nunca crea una reserva ni un guest fantasma)", async () => {
    const res = await mcpCall(apiKeyHotelA, "tools/call", {
      name: "crear_reserva",
      arguments: { roomTypeId: roomTypeAId, checkInDate, checkOutDate, guest: { fullName: "   " }, clientRequestId: randomUUID() },
    });
    const body = (await res.json()) as JsonRpcResult;
    // Falla en la validación zod (`fullName` no puede ser solo espacios tras `.trim().min(1)`)
    // como error de herramienta, antes de tocar la base de datos.
    expect(body.result!.isError).toBe(true);
  });
});
