// AgentRunner: bucle de tool-calling con loop-guard, presupuesto, fallback de proveedor,
// gate shadow/propone/autopilot y salida siempre cerrada hacia el humano.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentRunner,
  DEFAULT_PRICING,
  EnvProvider,
  FakeProvider,
  InMemoryApprovalQueue,
  InMemoryCostLedger,
  ToolRegistry,
  buildToolContext,
  createRunBudget,
  defineTool,
  type AgentRunnerOptions,
  type ToolContext,
} from "@atiende-hoteles/agent-core";

function ctxFor(hotelId = "hotel-1"): ToolContext {
  return buildToolContext(
    { orgId: "org-1", hotelId, actor: { type: "staff", id: "staff-1" }, requestId: "req-1" },
    createRunBudget({}),
  );
}

function baseOptions(overrides: Partial<AgentRunnerOptions>): AgentRunnerOptions {
  return {
    agentName: "recepcionista",
    provider: new FakeProvider([{ kind: "final", text: "listo" }]),
    tools: new ToolRegistry(),
    approvalQueue: new InMemoryApprovalQueue(),
    systemPrompt: "eres el recepcionista del hotel",
    modelSlug: "claude-sonnet-5",
    temperature: 0,
    maxSteps: 5,
    pricing: DEFAULT_PRICING,
    gate: "propone",
    ...overrides,
  };
}

describe("AgentRunner", () => {
  it("termina 'completado' cuando el modelo responde sin pedir tools", async () => {
    const runner = new AgentRunner(baseOptions({}));
    const result = await runner.run(ctxFor(), "hola");
    expect(result.status).toBe("completado");
    expect(result.finalText).toBe("listo");
  });

  it("ejecuta una tool de lectura sin aprobacion y termina completado", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "disponible" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "consultar_disponibilidad",
        description: "consulta disponibilidad",
        inputSchema: z.object({}),
        effect: "read",
        needsApproval: false,
        run: runSpy,
      }),
    );
    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "consultar_disponibilidad", input: {} }] },
      { kind: "final", text: "hay 3 habitaciones libres" },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools }));
    const result = await runner.run(ctxFor(), "hay lugar?");
    expect(result.status).toBe("completado");
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("en gate=shadow NINGUNA tool de escritura se ejecuta", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "ajustado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "ajustar_ac",
        description: "ajusta el aire acondicionado",
        inputSchema: z.object({}),
        effect: "write",
        needsApproval: false,
        run: runSpy,
      }),
    );
    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "ajustar_ac", input: {} }] },
      { kind: "final", text: "listo (shadow)" },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, gate: "shadow" }));
    const result = await runner.run(ctxFor(), "baja el AC");
    expect(result.status).toBe("completado");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("una tool con needsApproval sin aprobacion previa deja la corrida 'esperando_aprobacion'", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "cerrado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "cerrar_folio",
        description: "cierra el folio",
        inputSchema: z.object({}),
        effect: "money",
        needsApproval: true,
        run: runSpy,
      }),
    );
    const provider = new FakeProvider([{ kind: "tool_calls", calls: [{ name: "cerrar_folio", input: {} }] }]);
    const runner = new AgentRunner(baseOptions({ provider, tools, gate: "propone" }));
    const result = await runner.run(ctxFor(), "cierra mi cuenta");
    expect(result.status).toBe("esperando_aprobacion");
    expect(result.pendingApprovalIds).toHaveLength(1);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("una tool con needsApproval YA aprobada (idempotencia) SI se ejecuta", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "ajustado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "ajustar_tarifa_publicada",
        description: "ajusta una tarifa ya aprobada",
        inputSchema: z.object({}),
        effect: "write",
        needsApproval: true,
        run: runSpy,
      }),
    );
    const approvalQueue = new InMemoryApprovalQueue();
    const pre = await approvalQueue.request({
      toolName: "ajustar_tarifa_publicada",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "humano-preaprobado",
      isMoney: false,
      textoMostrado: "aprobar ajuste",
    });
    await approvalQueue.decide({
      approvalId: pre.id,
      actor: "gerente-1",
      decision: "aprobar",
      textoExacto: "aprobar ajuste",
    });

    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "ajustar_tarifa_publicada", input: {} }] },
      { kind: "final", text: "tarifa ajustada" },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, approvalQueue, gate: "propone" }));
    const result = await runner.run(ctxFor(), "ajusta la tarifa");
    expect(result.status).toBe("completado");
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("loop-guard: repetir la misma tool+input corta la corrida sin re-ejecutar", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "consultado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "consultar_disponibilidad",
        description: "consulta disponibilidad",
        inputSchema: z.object({}),
        effect: "read",
        needsApproval: false,
        run: runSpy,
      }),
    );
    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "consultar_disponibilidad", input: {} }] },
      { kind: "tool_calls", calls: [{ name: "consultar_disponibilidad", input: {} }] },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, maxSteps: 10 }));
    const result = await runner.run(ctxFor(), "hay lugar?");
    expect(result.status).toBe("agotado_pasos");
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("loop-guard: en la ultima ronda sin tool terminal disponible, corta sin ejecutar ninguna mutacion", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "hecho" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "consultar_disponibilidad",
        description: "consulta disponibilidad",
        inputSchema: z.object({}),
        effect: "read",
        needsApproval: false,
        run: runSpy,
      }),
    );
    const provider = new FakeProvider([{ kind: "tool_calls", calls: [{ name: "consultar_disponibilidad", input: {} }] }]);
    const runner = new AgentRunner(baseOptions({ provider, tools, maxSteps: 1 }));
    const result = await runner.run(ctxFor(), "hay lugar?");
    expect(result.status).toBe("agotado_pasos");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("presupuesto agotado antes de la primera llamada cierra explicitamente sin llamar al proveedor", async () => {
    const completeSpy = vi.fn();
    const provider = { id: "fake", isAvailable: () => true, complete: completeSpy } as const;
    const ctx = buildToolContext(
      { orgId: "org-1", hotelId: "hotel-1", actor: { type: "staff", id: "staff-1" }, requestId: "req-1" },
      createRunBudget({ maxMs: 0 }),
    );
    const runner = new AgentRunner(baseOptions({ provider }));
    const result = await runner.run(ctx, "hola");
    expect(result.status).toBe("presupuesto_agotado");
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("una respuesta truncada se cierra como error explicito, nunca como respuesta valida", async () => {
    const provider = new FakeProvider([{ kind: "truncated", partialText: "a medi" }]);
    const runner = new AgentRunner(baseOptions({ provider }));
    const result = await runner.run(ctxFor(), "cuentame algo largo");
    expect(result.status).toBe("truncado");
  });

  it("fallback de proveedor: reintenta la misma ronda y atribuye el costo al modelo que SI respondio", async () => {
    const primary = new FakeProvider([{ kind: "transient_error" }]);
    const fallback = new FakeProvider(
      [{ kind: "final", text: "recuperado por fallback", usage: { inputTokens: 100, outputTokens: 50 } }],
      "claude-haiku-4-5",
    );
    const costLedger = new InMemoryCostLedger();
    const runner = new AgentRunner(baseOptions({ provider: primary, fallbackProvider: fallback, costLedger }));
    const result = await runner.run(ctxFor("hotel-9"), "hola");
    expect(result.status).toBe("completado");
    expect(result.finalText).toBe("recuperado por fallback");
    const detalle = costLedger.detallePorHotel("hotel-9");
    expect(detalle["claude-sonnet-5"]).toBeUndefined();
    expect(detalle["claude-haiku-4-5"]).toBeCloseTo((100 / 1_000_000) * 1 + (50 / 1_000_000) * 5, 6);
  });

  it("sin fallback disponible, un error de proveedor se cierra explicitamente", async () => {
    const provider = new FakeProvider([{ kind: "transient_error" }]);
    const runner = new AgentRunner(baseOptions({ provider }));
    const result = await runner.run(ctxFor(), "hola");
    expect(result.status).toBe("error_proveedor");
  });

  it("sin credenciales, EnvProvider produce el estado honesto 'no_configurado' (nunca finge una respuesta)", async () => {
    const provider = new EnvProvider({ env: {} });
    const runner = new AgentRunner(baseOptions({ provider }));
    const result = await runner.run(ctxFor(), "hola");
    expect(result.status).toBe("no_configurado");
    expect(result.message).toMatch(/no configurado/);
  });
});
