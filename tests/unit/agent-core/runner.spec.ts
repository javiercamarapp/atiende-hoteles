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

function firstTurnCtxFor(hotelId = "hotel-1"): ToolContext {
  return buildToolContext(
    { orgId: "org-1", hotelId, actor: { type: "guest", id: "guest-1" }, requestId: "req-1", isFirstTurn: true },
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

  it("la solicitud de aprobacion expone el input REAL (monto) al aprobador, no solo el " +
    "nombre de la tool (aud-1 tool-calling.md CRITICO #2)", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "cobrado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "cobrar_folio",
        description: "cobra el folio",
        inputSchema: z.object({ montoMxn: z.number() }),
        effect: "money",
        needsApproval: true,
        run: runSpy,
      }),
    );
    const approvalQueue = new InMemoryApprovalQueue();
    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "cobrar_folio", input: { montoMxn: 12340.5 } }] },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, approvalQueue, gate: "propone" }));
    const result = await runner.run(ctxFor(), "cobra mi cuenta");
    expect(result.status).toBe("esperando_aprobacion");
    const approval = await approvalQueue.get(result.pendingApprovalIds[0]!);
    // Ni textoMostrado ni inputSummary pueden limitarse al nombre de la tool/hotel: el
    // aprobador debe poder VER el monto real que esta autorizando.
    expect(approval?.textoMostrado).toContain("12340.5");
    expect(approval?.inputSummary).toContain("12340.5");
  });

  it("T1 (auditoria-2 tool-calling CRÍTICO): el teléfono destinatario queda PARCIALMENTE visible (últimos 4 dígitos) para que el aprobador detecte un destinatario equivocado, no oculto por completo como '[TARJETA]'/'[TEL]'", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "enviado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "enviar_mensaje_whatsapp_plantilla",
        description: "envia una plantilla al huesped",
        inputSchema: z.object({
          guestPhone: z.string(),
          templateName: z.string(),
          languageCode: z.string(),
          parameters: z.array(z.string()),
        }),
        effect: "external",
        needsApproval: true,
        run: runSpy,
      }),
    );
    const approvalQueue = new InMemoryApprovalQueue();
    const provider = new FakeProvider([
      {
        kind: "tool_calls",
        calls: [
          {
            name: "enviar_mensaje_whatsapp_plantilla",
            input: {
              guestPhone: "+5215599998888",
              templateName: "confirmacion_pago",
              languageCode: "es",
              parameters: ["Maria Lopez", "$8,750.00 MXN pagado, folio F-900"],
            },
          },
        ],
      },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, approvalQueue, gate: "propone" }));
    const result = await runner.run(ctxFor(), "confirma el pago de Maria");
    expect(result.status).toBe("esperando_aprobacion");
    const approval = await approvalQueue.get(result.pendingApprovalIds[0]!);

    // NUNCA "[TARJETA]"/"[TEL]" (ciego, inútil para verificar) -- el aprobador debe
    // poder ver que el número termina en 8888.
    expect(approval?.inputSummary).not.toMatch(/\[TARJETA\]|\[TEL\]/);
    expect(approval?.inputSummary).toContain("8888");
    // Tampoco el número COMPLETO en claro -- enmascarado, no expuesto sin más.
    expect(approval?.inputSummary).not.toContain("+5215599998888");
    // El nombre del huésped (para cruzar "es Maria, ¿por qué manda a este número?")
    // sigue visible, junto con el resto del contexto de negocio.
    expect(approval?.inputSummary).toContain("Maria Lopez");
    expect(approval?.inputSummary).toContain("F-900");
  });

  it("una tool con needsApproval=true y alwaysApprove=true se ejecuta SIN pasar por la " +
    "ApprovalQueue (aud-1 agentico.md BAJO #8: alwaysApprove dejaba de ser una funcion " +
    "fantasma)", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "marcada" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "marcar_leida",
        description: "marca una notificacion como leida",
        inputSchema: z.object({}),
        effect: "write",
        needsApproval: true,
        alwaysApprove: true,
        run: runSpy,
      }),
    );
    const approvalQueue = new InMemoryApprovalQueue();
    const requestSpy = vi.spyOn(approvalQueue, "request");
    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "marcar_leida", input: {} }] },
      { kind: "final", text: "leida" },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, approvalQueue, gate: "propone" }));
    const result = await runner.run(ctxFor(), "marca como leida");
    expect(result.status).toBe("completado");
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("una tool con needsApproval ya RECHAZADA se reporta como 'accion_rechazada' " +
    "(terminal), nunca como 'esperando_aprobacion' (aud-1 tool-calling.md ALTO #4)", async () => {
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
    const approvalQueue = new InMemoryApprovalQueue();
    const pre = await approvalQueue.request({
      toolName: "cerrar_folio",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:recepcionista:staff:staff-1",
      isMoney: true,
      textoMostrado: "cerrar folio",
    });
    await approvalQueue.decide({
      approvalId: pre.id,
      actor: "gerente-1",
      decision: "rechazar",
      textoExacto: "cerrar folio",
    });

    const provider = new FakeProvider([{ kind: "tool_calls", calls: [{ name: "cerrar_folio", input: {} }] }]);
    const runner = new AgentRunner(baseOptions({ provider, tools, approvalQueue, gate: "propone" }));
    const result = await runner.run(ctxFor(), "cierra mi cuenta otra vez");
    expect(result.status).toBe("accion_rechazada");
    expect(result.pendingApprovalIds).toHaveLength(0);
    expect(result.message).toMatch(/rechaz/);
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
      // Debe coincidir con el ambito de conversacion/actor que el AgentRunner usara al
      // pedir la aprobacion (`agent:${agentName}:${ctx.actor.id}`, ver runner.ts) -- la
      // llave de idempotencia ahora incluye ese ambito (aud-1 tool-calling.md CRITICO #1).
      requestedBy: "agent:recepcionista:staff:staff-1",
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

  it("A4 (auditoria-2): una aprobacion YA EJECUTADA no vuelve a correr la tool aunque el modelo la re-proponga dentro del TTL", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "plantilla enviada" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "enviar_mensaje_whatsapp_plantilla",
        description: "envia una plantilla al huesped",
        inputSchema: z.object({}),
        effect: "external",
        needsApproval: true,
        run: runSpy,
      }),
    );
    const approvalQueue = new InMemoryApprovalQueue();
    const pre = await approvalQueue.request({
      toolName: "enviar_mensaje_whatsapp_plantilla",
      input: {},
      orgId: "org-1",
      hotelId: "hotel-1",
      requestedBy: "agent:recepcionista:staff:staff-1",
      isMoney: false,
      textoMostrado: "enviar plantilla",
    });
    await approvalQueue.decide({
      approvalId: pre.id,
      actor: "gerente-1",
      decision: "aprobar",
      textoExacto: "enviar plantilla",
    });
    // Simula que la aprobación YA se ejecutó antes (p.ej. ya la corrió
    // `decidirYEjecutarAprobacion` fuera de banda, o un turno anterior de esta misma
    // conversación) -- `request()` de todos modos reusa esta MISMA fila "aprobada"
    // (misma tool+input+hotel+ámbito dentro del TTL, comportamiento documentado e
    // intencional para no duplicar la SOLICITUD humana).
    await approvalQueue.markExecuted(pre.id);

    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "enviar_mensaje_whatsapp_plantilla", input: {} }] },
      { kind: "final", text: "listo" },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, approvalQueue, gate: "propone" }));
    const result = await runner.run(ctxFor(), "reenvía la confirmación");
    expect(result.status).toBe("completado");
    // El punto central del hallazgo: la tool NUNCA se re-ejecuta sin una decisión
    // humana nueva, aunque el runner vea "aprobada" de nuevo.
    expect(runSpy).not.toHaveBeenCalled();
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

  it("loop-guard: detecta una repeticion NO inmediata (con otra tool intercalada) dentro " +
    "de la ventana de N pasos (aud-1 tool-calling.md ALTO #2)", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "ticket creado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "crear_ticket_housekeeping",
        description: "crea un ticket de housekeeping",
        inputSchema: z.object({ habitacion: z.string(), detalle: z.string() }),
        effect: "write",
        needsApproval: false,
        run: runSpy,
      }),
    );
    tools.register(
      defineTool({
        name: "consultar_estado_habitacion",
        description: "consulta el estado de una habitacion",
        inputSchema: z.object({}),
        effect: "read",
        needsApproval: false,
        run: () => ({ ok: true, summary: "ocupada" }),
      }),
    );
    const input = { habitacion: "204", detalle: "toalla sucia" };
    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "crear_ticket_housekeeping", input }] },
      { kind: "tool_calls", calls: [{ name: "consultar_estado_habitacion", input: {} }] },
      { kind: "tool_calls", calls: [{ name: "crear_ticket_housekeeping", input }] },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, maxSteps: 10 }));
    const result = await runner.run(ctxFor(), "hay una toalla sucia en 204");
    expect(result.status).toBe("agotado_pasos");
    // Solo UN ticket, nunca dos duplicados por el mismo motivo.
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("loop-guard: la firma de repeticion usa el input ya coercionado por Zod (tipos " +
    "normalizados), no el input crudo del modelo (aud-1 agentico.md ALTO #4)", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "ticket creado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "crear_ticket_housekeeping",
        description: "crea un ticket de housekeeping",
        inputSchema: z.object({ habitacion: z.coerce.number() }),
        effect: "write",
        needsApproval: false,
        run: runSpy,
      }),
    );
    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "crear_ticket_housekeeping", input: { habitacion: 204 } }] },
      { kind: "tool_calls", calls: [{ name: "crear_ticket_housekeeping", input: { habitacion: "204" } }] },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, maxSteps: 10 }));
    const result = await runner.run(ctxFor(), "toalla sucia en 204 otra vez");
    expect(result.status).toBe("agotado_pasos");
    // {habitacion: 204} y {habitacion: "204"} coercionan al MISMO valor: es la misma
    // llamada, no dos llamadas distintas.
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

  it("loop-guard: en la ultima ronda CON una tool terminal disponible, la terminal SI se " +
    "ejecuta y las no-terminales de la misma ronda se omiten (aud-1 tool-calling.md " +
    "MEDIO #5: rama sin cobertura previa)", async () => {
    const terminalSpy = vi.fn(() => ({ ok: true, summary: "folio cerrado" }));
    const noTerminalSpy = vi.fn(() => ({ ok: true, summary: "no deberia correr" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "cerrar_folio_terminal",
        description: "cierra el folio (terminal, su resultado no vuelve al modelo)",
        inputSchema: z.object({}),
        effect: "write",
        needsApproval: false,
        run: terminalSpy,
      }),
    );
    tools.register(
      defineTool({
        name: "consultar_extra",
        description: "consulta algo mas",
        inputSchema: z.object({}),
        effect: "read",
        needsApproval: false,
        run: noTerminalSpy,
      }),
    );
    const provider = new FakeProvider([
      {
        kind: "tool_calls",
        calls: [
          { name: "cerrar_folio_terminal", input: {} },
          { name: "consultar_extra", input: {} },
        ],
      },
    ]);
    const runner = new AgentRunner(
      baseOptions({ provider, tools, maxSteps: 1, terminalToolNames: ["cerrar_folio_terminal"] }),
    );
    const result = await runner.run(ctxFor(), "cierra mi folio");
    // La mutacion terminal SI corrio en el limite del loop-guard...
    expect(terminalSpy).toHaveBeenCalledTimes(1);
    // ...pero la tool no-terminal de la MISMA ronda se omitio, nunca corrio "de gratis".
    expect(noTerminalSpy).not.toHaveBeenCalled();
    // Como se agoto maxSteps justo despues de ejecutar la terminal, el cierre es honesto:
    // no hay otra ronda para que el modelo confirme que termino.
    expect(result.status).toBe("agotado_pasos");
  });

  it("nunca ejecuta ninguna tool si el modelo propone MAS DE UNA tool effect='money' en la " +
    "misma ronda -- REQ-AGT-004 (aud-1 agentico.md ALTO: disable_parallel_tool_use)", async () => {
    const cobrarSpy = vi.fn(() => ({ ok: true, summary: "cobrado" }));
    const descuentoSpy = vi.fn(() => ({ ok: true, summary: "descuento aplicado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "cobrar_folio",
        description: "cobra el folio",
        inputSchema: z.object({ montoMxn: z.number() }),
        effect: "money",
        needsApproval: true,
        run: cobrarSpy,
      }),
    );
    tools.register(
      defineTool({
        name: "aplicar_descuento",
        description: "aplica un descuento",
        inputSchema: z.object({ montoMxn: z.number() }),
        effect: "money",
        needsApproval: true,
        run: descuentoSpy,
      }),
    );
    const provider = new FakeProvider([
      {
        kind: "tool_calls",
        calls: [
          { name: "cobrar_folio", input: { montoMxn: 100 } },
          { name: "aplicar_descuento", input: { montoMxn: 20 } },
        ],
      },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, gate: "propone" }));
    const result = await runner.run(ctxFor(), "cobra y aplica un descuento");
    expect(result.status).toBe("paralelismo_dinero_bloqueado");
    expect(cobrarSpy).not.toHaveBeenCalled();
    expect(descuentoSpy).not.toHaveBeenCalled();
    expect(result.pendingApprovalIds).toHaveLength(0);
  });

  it("el proveedor SIEMPRE recibe disableParallelToolUse:true (REQ-AGT-004)", async () => {
    const completeSpy = vi.fn(async () => ({
      modelSlug: "claude-sonnet-5",
      text: "listo",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      truncated: false,
      stopReason: "end_turn" as const,
    }));
    const provider = { id: "fake", isAvailable: () => true, complete: completeSpy };
    const runner = new AgentRunner(baseOptions({ provider }));
    await runner.run(ctxFor(), "hola");
    expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({ disableParallelToolUse: true }));
  });

  it("MEDIO (auditoria-2 agentico): AgentRunnerOptions.effort SÍ llega al proveedor en cada llamada (antes, LlmCompleteParams no tenía dónde recibirlo)", async () => {
    const completeSpy = vi.fn(async () => ({
      modelSlug: "claude-sonnet-5",
      text: "listo",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      truncated: false,
      stopReason: "end_turn" as const,
    }));
    const provider = { id: "fake", isAvailable: () => true, complete: completeSpy };
    const runner = new AgentRunner(baseOptions({ provider, effort: "low" }));
    await runner.run(ctxFor(), "hola");
    expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({ effort: "low" }));
  });

  it("el presupuesto se comprueba tambien DESPUES de contabilizar el costo real de la " +
    "ronda, ANTES de ejecutar cualquier tool de esa misma ronda (aud-1 agentico.md " +
    "MEDIO: antes solo se comprobaba al inicio de la ronda siguiente)", async () => {
    const runSpy = vi.fn(() => ({ ok: true, summary: "actualizado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "actualizar_estado_habitacion",
        description: "actualiza el estado de una habitacion",
        inputSchema: z.object({}),
        effect: "write",
        needsApproval: false,
        run: runSpy,
      }),
    );
    // Con DEFAULT_PRICING (claude-sonnet-5: $2/$10 por MTok), 1000+1000 tokens cuestan
    // 0.012 USD reales -- muy por encima de este techo.
    const ctx = buildToolContext(
      { orgId: "org-1", hotelId: "hotel-1", actor: { type: "staff", id: "staff-1" }, requestId: "req-1" },
      createRunBudget({ maxUsd: 0.0000001 }),
    );
    const provider = new FakeProvider([
      {
        kind: "tool_calls",
        calls: [{ name: "actualizar_estado_habitacion", input: {} }],
        usage: { inputTokens: 1000, outputTokens: 1000 },
      },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools }));
    const result = await runner.run(ctx, "actualiza la 204");
    expect(result.status).toBe("presupuesto_agotado");
    // La mutacion de ESTA ronda (la que rebaso el techo) NUNCA debe correr "gratis".
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

  it("el mensaje de 'error_proveedor' NUNCA expone detalle interno (nombre de variable de " +
    "entorno, hito H6a, etc.) al canal del humano/huesped (aud-1 tool-calling.md MEDIO #6)", async () => {
    const provider = new EnvProvider({ env: { ANTHROPIC_API_KEY: "sk-test-123" } });
    const runner = new AgentRunner(baseOptions({ provider }));
    const result = await runner.run(ctxFor(), "hola");
    expect(result.status).toBe("error_proveedor");
    expect(result.message).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(result.message).not.toMatch(/H6a/);
    expect(result.message).not.toMatch(/agent-core/);
  });

  it("sin credenciales, EnvProvider produce el estado honesto 'no_configurado' (nunca finge una respuesta)", async () => {
    const provider = new EnvProvider({ env: {} });
    const runner = new AgentRunner(baseOptions({ provider }));
    const result = await runner.run(ctxFor(), "hola");
    expect(result.status).toBe("no_configurado");
    expect(result.message).toMatch(/no configurado/);
  });

  describe("disclosure de IA (aud-1 agentico.md ALTO: REQ-HUE-006/GOB-034 -- el primer " +
    "turno de una conversacion debe revelar que quien responde es un agente de IA)", () => {
    const disclosureMessage = "Soy un asistente de inteligencia artificial de este hotel.";

    it("antepone el disclosure al mensaje de cierre cuando isFirstTurn=true", async () => {
      const runner = new AgentRunner(baseOptions({ disclosureMessage }));
      const result = await runner.run(firstTurnCtxFor(), "hola");
      expect(result.status).toBe("completado");
      expect(result.message.startsWith(disclosureMessage)).toBe(true);
    });

    it("NO antepone nada cuando isFirstTurn=false (turno de seguimiento)", async () => {
      const runner = new AgentRunner(baseOptions({ disclosureMessage }));
      const result = await runner.run(ctxFor(), "hola");
      expect(result.message).not.toContain(disclosureMessage);
    });

    it("se aplica sin importar como termine la corrida (p.ej. 'esperando_aprobacion')", async () => {
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: "cerrar_folio",
          description: "cierra el folio",
          inputSchema: z.object({}),
          effect: "money",
          needsApproval: true,
          run: () => ({ ok: true, summary: "cerrado" }),
        }),
      );
      const provider = new FakeProvider([{ kind: "tool_calls", calls: [{ name: "cerrar_folio", input: {} }] }]);
      const runner = new AgentRunner(baseOptions({ provider, tools, disclosureMessage }));
      const result = await runner.run(firstTurnCtxFor(), "cierra mi cuenta");
      expect(result.status).toBe("esperando_aprobacion");
      expect(result.message.startsWith(disclosureMessage)).toBe(true);
    });

    it("sin disclosureMessage configurado, el comportamiento no cambia (compatibilidad)", async () => {
      const runner = new AgentRunner(baseOptions({}));
      const result = await runner.run(firstTurnCtxFor(), "hola");
      expect(result.message).toBe("listo");
    });
  });

  describe("run_finished (aud-1 agentico.md ALTO: el desenlace de la corrida debe quedar " +
    "anclado en la misma traza que el resto de los pasos)", () => {
    it("se emite exactamente una vez, al final, con el status y mensaje de cierre -- caso 'completado'", async () => {
      const events: { kind: string }[] = [];
      const runner = new AgentRunner(baseOptions({ onTrace: (e) => events.push(e) }));
      const result = await runner.run(ctxFor(), "hola");
      expect(result.status).toBe("completado");
      const finished = events.filter((e) => e.kind === "run_finished");
      expect(finished).toHaveLength(1);
      expect(events.at(-1)?.kind).toBe("run_finished");
    });

    it("se emite tambien cuando la corrida cierra 'esperando_aprobacion'", async () => {
      const tools = new ToolRegistry();
      tools.register(
        defineTool({
          name: "cerrar_folio",
          description: "cierra el folio",
          inputSchema: z.object({}),
          effect: "money",
          needsApproval: true,
          run: () => ({ ok: true, summary: "cerrado" }),
        }),
      );
      const provider = new FakeProvider([{ kind: "tool_calls", calls: [{ name: "cerrar_folio", input: {} }] }]);
      const events: { kind: string }[] = [];
      const runner = new AgentRunner(baseOptions({ provider, tools, onTrace: (e) => events.push(e) }));
      const result = await runner.run(ctxFor(), "cierra mi cuenta");
      expect(result.status).toBe("esperando_aprobacion");
      expect(events.filter((e) => e.kind === "run_finished")).toHaveLength(1);
    });

    it("se emite tambien cuando el presupuesto se agota ANTES de la primera llamada al proveedor", async () => {
      const provider = { id: "fake", isAvailable: () => true, complete: async () => ({} as never) };
      const ctx = buildToolContext(
        { orgId: "org-1", hotelId: "hotel-1", actor: { type: "staff", id: "staff-1" }, requestId: "req-1" },
        createRunBudget({ maxMs: 0 }),
      );
      const events: { kind: string }[] = [];
      const runner = new AgentRunner(baseOptions({ provider, onTrace: (e) => events.push(e) }));
      const result = await runner.run(ctx, "hola");
      expect(result.status).toBe("presupuesto_agotado");
      expect(events.filter((e) => e.kind === "run_finished")).toHaveLength(1);
    });

    it("se emite tambien sin credenciales ('no_configurado')", async () => {
      const provider = new EnvProvider({ env: {} });
      const events: { kind: string }[] = [];
      const runner = new AgentRunner(baseOptions({ provider, onTrace: (e) => events.push(e) }));
      const result = await runner.run(ctxFor(), "hola");
      expect(result.status).toBe("no_configurado");
      expect(events.filter((e) => e.kind === "run_finished")).toHaveLength(1);
    });
  });
});
