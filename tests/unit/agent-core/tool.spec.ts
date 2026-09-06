// REQ-AGT-001, REQ-AGT-004, GOB-026, GOB-032: las tools son tipadas (zod), nunca reciben
// identificadores de tenant/hotel/actor del modelo, y toda tool con effect
// external/money exige needsApproval=true; alwaysApprove esta prohibido en precio/emision.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolDefinitionError, ToolRegistry, defineTool, type ToolContext } from "@atiende-hoteles/agent-core";

function fakeCtx(): ToolContext {
  return {
    orgId: "org-1",
    hotelId: "hotel-1",
    actor: { type: "staff", id: "staff-1" },
    requestId: "req-1",
    budget: {
      limits: {},
      snapshot: () => ({ tokensUsed: 0, elapsedMs: 0, usdSpent: 0 }),
      remainingMs: () => undefined,
      remainingTokens: () => undefined,
      remainingUsd: () => undefined,
      agotado: () => false,
      registrarTokens: () => {},
      registrarCostoUsd: () => {},
    },
  };
}

describe("defineTool", () => {
  it("acepta una tool de lectura con esquema vacio (patron Likida properties:{})", () => {
    const tool = defineTool({
      name: "consultar_politica",
      description: "Consulta la politica publicada del hotel",
      inputSchema: z.object({}),
      effect: "read",
      needsApproval: false,
      run: () => ({ ok: true, summary: "politica consultada" }),
    });
    expect(tool.name).toBe("consultar_politica");
  });

  it("rechaza una tool external sin needsApproval=true (GOB-026)", () => {
    expect(() =>
      defineTool({
        name: "enviar_whatsapp",
        description: "Envia un mensaje proactivo",
        inputSchema: z.object({}),
        effect: "external",
        needsApproval: false,
        run: () => ({ ok: true, summary: "enviado" }),
      }),
    ).toThrow(ToolDefinitionError);
  });

  it("rechaza una tool de dinero sin needsApproval=true (GOB-026)", () => {
    expect(() =>
      defineTool({
        name: "cobrar_folio",
        description: "Cobra el folio del huesped",
        inputSchema: z.object({}),
        effect: "money",
        needsApproval: false,
        run: () => ({ ok: true, summary: "cobrado" }),
      }),
    ).toThrow(ToolDefinitionError);
  });

  it("rechaza alwaysApprove=true en una tool de precio/emision (GOB-026)", () => {
    expect(() =>
      defineTool({
        name: "cotizar_tarifa",
        description: "Cotiza una tarifa",
        inputSchema: z.object({}),
        effect: "money",
        needsApproval: true,
        isPriceOrEmission: true,
        alwaysApprove: true,
        run: () => ({ ok: true, summary: "cotizado" }),
      }),
    ).toThrow(ToolDefinitionError);
  });

  it("permite alwaysApprove=true en una tool que NO es de precio/emision", () => {
    const tool = defineTool({
      name: "marcar_leida",
      description: "Marca una notificacion como leida",
      inputSchema: z.object({}),
      effect: "write",
      needsApproval: true,
      alwaysApprove: true,
      run: () => ({ ok: true, summary: "marcada" }),
    });
    expect(tool.alwaysApprove).toBe(true);
  });

  it("rechaza un esquema que declare hotel_id/tenant_id/guest_id (nunca vienen del modelo)", () => {
    expect(() =>
      defineTool({
        name: "cerrar_ticket",
        description: "Cierra un ticket de housekeeping",
        inputSchema: z.object({ hotel_id: z.string() }),
        effect: "write",
        needsApproval: true,
        run: () => ({ ok: true, summary: "cerrado" }),
      }),
    ).toThrow(/nunca deben venir del modelo/);
  });

  it("rechaza un nombre de tool invalido", () => {
    expect(() =>
      defineTool({
        name: "Cotizar-Tarifa",
        description: "x",
        inputSchema: z.object({}),
        effect: "read",
        needsApproval: false,
        run: () => ({ ok: true, summary: "x" }),
      }),
    ).toThrow(ToolDefinitionError);
  });
});

describe("ToolRegistry", () => {
  it("registra y recupera una tool por nombre", () => {
    const registry = new ToolRegistry();
    const tool = defineTool({
      name: "estado_viaje",
      description: "Consulta estado",
      inputSchema: z.object({}),
      effect: "read",
      needsApproval: false,
      run: () => ({ ok: true, summary: "ok" }),
    });
    registry.register(tool);
    expect(registry.get("estado_viaje")).toBe(tool);
    expect(registry.list()).toHaveLength(1);
  });

  it("rechaza registrar dos tools con el mismo nombre", () => {
    const registry = new ToolRegistry();
    const make = () =>
      defineTool({
        name: "duplicada",
        description: "x",
        inputSchema: z.object({}),
        effect: "read",
        needsApproval: false,
        run: () => ({ ok: true, summary: "x" }),
      });
    registry.register(make());
    expect(() => registry.register(make())).toThrow(ToolDefinitionError);
  });

  it("ejecuta run(ctx, input) recibiendo el ToolContext del servidor", async () => {
    const tool = defineTool({
      name: "sumar",
      description: "suma dos numeros",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      effect: "read",
      needsApproval: false,
      run: (ctx, input) => ({ ok: true, summary: `hotel=${ctx.hotelId}`, data: input.a + input.b }),
    });
    const result = await tool.run(fakeCtx(), { a: 2, b: 3 });
    expect(result.data).toBe(5);
    expect(result.summary).toContain("hotel-1");
  });
});
