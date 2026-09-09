// REQ-AGT-004: `disable_parallel_tool_use` debe estar activo en TODA transaccion de
// dinero, y ninguna tool de precio/tarifa/impuesto/disponibilidad/horario debe resolver
// su valor por generacion libre del LLM -- siempre delega a un motor determinista.
//
// El mecanismo de nucleo YA existe y ya tiene prueba: `runner.ts` pasa
// `disableParallelToolUse: true` de forma INCONDICIONAL en cada llamada al proveedor
// (mas estricto que "solo en dinero"), mas un guardarrail de refuerzo que bloquea la
// ronda entera ("paralelismo_dinero_bloqueado") si, pese a todo, el modelo propone mas de
// una tool `effect="money"` en la misma respuesta -- ver
// `tests/unit/agent-core/runner.spec.ts` ("el proveedor SIEMPRE recibe
// disableParallelToolUse:true" / "nunca ejecuta ninguna tool si el modelo propone MAS DE
// UNA tool effect='money'"). Esta suite, con el nombre y ubicacion que exige
// docs/ACEPTACION.md#REQ-AGT-004, cubre la mitad que faltaba: la PROVENIENCIA del valor
// en el dominio exacto que el requisito nombra (precio/tarifa/impuesto/disponibilidad/
// horario), no solo el bloqueo generico de paralelismo.
//
// Hoy ningun agente del catalogo (`packages/agent-core/src/agents.ts`) registra una tool
// de este dominio: la cotizacion (`computeQuote`/`applyTaxes`) vive solo detras de
// `apps/api/src/routes/quotes.ts`, invocada directo por la API -- el modelo nunca la ve
// como tool. Esta suite construye, con `defineTool()` REAL (no un mock del framework),
// tools de precio/tarifa (`cotizar_estancia`, que envuelve `computeQuote`/`applyTaxes` de
// `@atiende-hoteles/domain-hotel`, incluyendo horario/estadia via CTA/CTD/minStay) y de
// disponibilidad (`consultar_disponibilidad_habitaciones`, que envuelve
// `effectiveCapacity`/`canBook`), corridas por el `AgentRunner` REAL contra un
// `FakeProvider` que actua como un LLM adversarial intentando inyectar su propio precio,
// impuesto o veredicto de disponibilidad. Fija la garantia que `tool.ts`/`runner.ts` ya
// ofrecen para el dia en que una tool asi se registre de verdad, usando SIEMPRE las
// funciones deterministas reales del motor, nunca una version de prueba de ellas.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentRunner,
  DEFAULT_PRICING,
  FakeProvider,
  InMemoryApprovalQueue,
  ToolRegistry,
  buildToolContext,
  createRunBudget,
  defineTool,
  type AgentRunnerOptions,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "@atiende-hoteles/agent-core";
import {
  QuoteError,
  applyTaxes,
  canBook,
  computeQuote,
  effectiveCapacity,
  parseQuoteInput,
  type OverbookingConfig,
} from "@atiende-hoteles/domain-hotel";

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

// Espejo MINIMO del esquema real de domain-hotel (quote.ts `nightlyRateSchema`/
// `taxConfigSchema`): solo columnas reales de rate_plan/hotel_tax_config. No declara
// NINGUN campo de "precio final"/"total"/"disponible" que un LLM pudiera intentar fijar
// directamente -- cualquier campo extra que el modelo cuele (`llmSuggestedPrice`,
// `totalOverride`, `disponible`, `horarioForzado`...) no esta en este esquema, asi que
// Zod lo descarta (`.strip()` implicito de `z.object`) ANTES de que `runner.ts` calcule
// el hash de aprobacion o de que `run()` reciba el input -- el mismo mecanismo que
// `tests/unit/domain-hotel/pricing-source.spec.ts` ya prueba a nivel de motor, aqui
// verificado en el punto de entrada real por el que un canal conversacional (WhatsApp/
// voz) invocaria la tool.
const nightlyRateInput = z.object({
  date: z.string(),
  price: z.number().nonnegative(),
  minStay: z.number().int().positive().default(1),
  closedToArrival: z.boolean().default(false),
  closedToDeparture: z.boolean().default(false),
});
const cotizarEstanciaInput = z.object({
  checkInDate: z.string(),
  checkOutDate: z.string(),
  nightlyRates: z.array(nightlyRateInput).min(1),
  taxConfig: z.object({ ivaRate: z.number().min(0), ishRate: z.number().min(0) }),
});

/** Tool de precio/tarifa/impuesto/horario: el UNICO calculo del valor final es
 * `computeQuote` (que a su vez llama a `applyTaxes`) de `@atiende-hoteles/domain-hotel` --
 * el input de esta tool ni siquiera TIENE un campo de total/precio final que `run()`
 * pudiera leer en su lugar, y `parseQuoteInput` vuelve a descartar cualquier campo no
 * reconocido como segunda capa (defensa en profundidad, igual que en produccion). Si no
 * hay tarifa real para la estadia solicitada, `computeQuote` lanza `QuoteError` y la tool
 * responde `ok:false` -- nunca inventa un precio para no dejar al modelo sin respuesta.
 */
function cotizarEstanciaTool(
  onResult: (result: ToolResult) => void = () => {},
): ToolDefinition<z.infer<typeof cotizarEstanciaInput>> {
  return defineTool({
    name: "cotizar_estancia",
    description: "Cotiza una estancia (precio/tarifa/impuesto/horario) a partir de tarifas reales del hotel en curso.",
    inputSchema: cotizarEstanciaInput,
    effect: "read",
    needsApproval: false,
    isPriceOrEmission: true,
    run: (_ctx, input) => {
      let result: ToolResult;
      try {
        const quote = computeQuote(parseQuoteInput(input));
        result = {
          ok: true,
          summary: `Cotizacion: ${quote.nights} noche(s), total $${quote.totalAmount.toFixed(2)}.`,
          data: quote,
        };
      } catch (err) {
        if (err instanceof QuoteError) {
          result = { ok: false, summary: `No se pudo cotizar: ${err.message}` };
        } else {
          throw err;
        }
      }
      onResult(result);
      return result;
    },
  });
}

const OVERBOOK_CONFIG: OverbookingConfig = { maxOverbookRooms: 2, occupancyThresholdPct: 95 };

const disponibilidadInput = z.object({
  totalRooms: z.number().int().nonnegative(),
  bookedRooms: z.number().int().nonnegative(),
  qty: z.number().int().positive(),
});

/** Tool de disponibilidad: el UNICO veredicto de "hay lugar" sale de `canBook`/
 * `effectiveCapacity` reales de `@atiende-hoteles/domain-hotel` -- el input no tiene
 * ningun campo "disponible"/"confirmado" que el modelo pudiera fijar el mismo. */
function consultarDisponibilidadTool(
  onResult: (result: ToolResult) => void = () => {},
): ToolDefinition<z.infer<typeof disponibilidadInput>> {
  return defineTool({
    name: "consultar_disponibilidad_habitaciones",
    description: "Consulta si hay disponibilidad real para una cantidad de habitaciones en el hotel en curso.",
    inputSchema: disponibilidadInput,
    effect: "read",
    needsApproval: false,
    run: (_ctx, input) => {
      const hayLugar = canBook(input.totalRooms, input.bookedRooms, input.qty, OVERBOOK_CONFIG);
      const capacidad = effectiveCapacity(input.totalRooms, input.bookedRooms, OVERBOOK_CONFIG);
      const result: ToolResult = {
        ok: hayLugar,
        summary: hayLugar
          ? `Hay disponibilidad para ${input.qty} habitacion(es).`
          : `Sin disponibilidad: capacidad efectiva ${capacidad}, ya hay ${input.bookedRooms} reservadas.`,
        data: { hayLugar, capacidadEfectiva: capacidad },
      };
      onResult(result);
      return result;
    },
  });
}

describe("REQ-AGT-004: ninguna tool de precio/tarifa/impuesto/disponibilidad/horario resuelve el valor por generacion libre del LLM", () => {
  it("un 'LLM' que inyecta precio/total/disponibilidad directamente en el input de cotizar_estancia es ignorado: el total sale de computeQuote/applyTaxes reales, nunca del valor inyectado", async () => {
    const results: ToolResult[] = [];
    const tools = new ToolRegistry();
    tools.register(cotizarEstanciaTool((r) => results.push(r)));

    // Simula un canal conversacional cuyo "LLM" devuelve, junto con los campos reales,
    // un intento de fijar el precio/impuesto/horario/disponibilidad el mismo -- ninguno
    // de estos campos existe en `cotizarEstanciaInput`, asi que Zod los descarta antes de
    // que la tool los vea.
    const adversarialInput = {
      checkInDate: "2026-05-01",
      checkOutDate: "2026-05-02",
      nightlyRates: [{ date: "2026-05-01", price: 1500 }],
      taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
      // --- intentos de inyeccion del "LLM", ninguno declarado en el esquema ---
      llmSuggestedPrice: 1,
      totalOverride: 1,
      ivaAmount: 0,
      disponible: true,
      horarioForzado: "check-in inmediato sin validar CTA",
    };
    const provider = new FakeProvider([
      { kind: "tool_calls", calls: [{ name: "cotizar_estancia", input: adversarialInput }] },
      { kind: "final", text: "aqui esta tu cotizacion" },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools }));
    const result = await runner.run(ctxFor(), "cuanto cuesta una noche del 1 al 2 de mayo?");

    expect(result.status).toBe("completado");
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);

    // El total real que produce el motor determinista con los MISMOS datos reales
    // (sin los campos inyectados) -- la tool debe coincidir EXACTAMENTE con esto, nunca
    // con el "$1" que el LLM intento imponer.
    const totalReal = computeQuote(
      parseQuoteInput({
        checkInDate: "2026-05-01",
        checkOutDate: "2026-05-02",
        nightlyRates: [{ date: "2026-05-01", price: 1500 }],
        taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
      }),
    ).totalAmount;
    expect(totalReal).toBeGreaterThan(1500); // confirma que applyTaxes de verdad corrio

    const quoteDevuelta = results[0]!.data as ReturnType<typeof computeQuote>;
    expect(quoteDevuelta.totalAmount).toBe(totalReal);
    expect(quoteDevuelta.totalAmount).not.toBe(1); // el valor inyectado nunca sobrevive
    expect(quoteDevuelta.ivaAmount).not.toBe(0);
  });

  it("sin una tarifa real para la fecha de llegada solicitada, cotizar_estancia rechaza la cotizacion (ok:false) en vez de inventar un precio, aunque el 'LLM' insista en un total", async () => {
    const results: ToolResult[] = [];
    const tools = new ToolRegistry();
    tools.register(cotizarEstanciaTool((r) => results.push(r)));

    const provider = new FakeProvider([
      {
        kind: "tool_calls",
        calls: [
          {
            name: "cotizar_estancia",
            input: {
              checkInDate: "2026-05-01",
              checkOutDate: "2026-05-02",
              // Tarifa real, pero para una fecha DISTINTA a la de llegada solicitada:
              // no hay fila de `rate_plan` que cubra el check-in.
              nightlyRates: [{ date: "2026-06-15", price: 1500 }],
              taxConfig: { ivaRate: 0.16, ishRate: 0.03 },
              totalOverride: 999, // el "LLM" propone un total de todos modos
            },
          },
        ],
      },
      { kind: "final", text: "no se pudo cotizar" },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools }));
    const result = await runner.run(ctxFor(), "cotiza el 1 de mayo");

    expect(result.status).toBe("completado");
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.summary).toMatch(/sin_tarifa|No hay tarifa/i);
    expect(results[0]!.data).toBeUndefined(); // ningun precio, ni el "999" del LLM, se devuelve
  });

  it("un 'LLM' que asevera 'disponible: true' es ignorado: la tool de disponibilidad siempre corre canBook/effectiveCapacity reales sobre las cifras reales de ocupacion", async () => {
    const results: ToolResult[] = [];
    const tools = new ToolRegistry();
    tools.register(consultarDisponibilidadTool((r) => results.push(r)));

    // Ocupacion real: 10/10 habitaciones ya reservadas, se piden 5 mas. Con
    // OVERBOOK_CONFIG (maxOverbookRooms=2, umbral=95%) la capacidad efectiva es 12 -- 5
    // mas NO caben (10+5=15 > 12). El "LLM" intenta colar `disponible: true` de todos
    // modos; el campo ni siquiera esta en el esquema de la tool.
    const provider = new FakeProvider([
      {
        kind: "tool_calls",
        calls: [
          {
            name: "consultar_disponibilidad_habitaciones",
            input: { totalRooms: 10, bookedRooms: 10, qty: 5, disponible: true, confirmado: "si hay lugar" },
          },
        ],
      },
      { kind: "final", text: "reviso disponibilidad" },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools }));
    const result = await runner.run(ctxFor(), "tienes 5 habitaciones libres?");

    expect(result.status).toBe("completado");
    expect(results).toHaveLength(1);
    // El veredicto real (NO hay lugar) contradice al "LLM" (que aseveraba disponible:true)
    // y prevalece: la tool nunca lee ese campo porque no esta declarado en su esquema.
    expect(results[0]!.ok).toBe(false);
    expect((results[0]!.data as { hayLugar: boolean }).hayLugar).toBe(false);
    expect((results[0]!.data as { capacidadEfectiva: number }).capacidadEfectiva).toBe(
      effectiveCapacity(10, 10, OVERBOOK_CONFIG),
    );
  });

  it("dos tools de dinero del dominio de precio/tarifa (cobrar_diferencia_tarifa + aplicar_descuento_tarifa) propuestas en la MISMA ronda se bloquean por completo -- REQ-AGT-004 no distingue tools genericas de tools de precio", async () => {
    const cobrarSpy = vi.fn(() => ({ ok: true, summary: "cobrado" }));
    const descuentoSpy = vi.fn(() => ({ ok: true, summary: "descuento aplicado" }));
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "cobrar_diferencia_tarifa",
        description: "cobra la diferencia de tarifa de una reserva",
        inputSchema: z.object({ montoMxn: z.number() }),
        effect: "money",
        needsApproval: true,
        run: cobrarSpy,
      }),
    );
    tools.register(
      defineTool({
        name: "aplicar_descuento_tarifa",
        description: "aplica un descuento sobre la tarifa cotizada",
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
          { name: "cobrar_diferencia_tarifa", input: { montoMxn: 350 } },
          { name: "aplicar_descuento_tarifa", input: { montoMxn: 100 } },
        ],
      },
    ]);
    const runner = new AgentRunner(baseOptions({ provider, tools, gate: "propone" }));
    const result = await runner.run(ctxFor(), "cobra la diferencia de tarifa y aplica el descuento");

    expect(result.status).toBe("paralelismo_dinero_bloqueado");
    expect(cobrarSpy).not.toHaveBeenCalled();
    expect(descuentoSpy).not.toHaveBeenCalled();
    expect(result.pendingApprovalIds).toHaveLength(0);
  });

  it("el proveedor SIEMPRE recibe disableParallelToolUse:true en una ronda con una tool de precio/tarifa disponible", async () => {
    const completeSpy = vi.fn(async () => ({
      modelSlug: "claude-sonnet-5",
      text: "aqui esta tu cotizacion",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      truncated: false,
      stopReason: "end_turn" as const,
    }));
    const provider = { id: "fake", isAvailable: () => true, complete: completeSpy };
    const tools = new ToolRegistry();
    tools.register(cotizarEstanciaTool());
    const runner = new AgentRunner(baseOptions({ provider, tools }));
    await runner.run(ctxFor(), "cuanto cuesta una noche?");
    expect(completeSpy).toHaveBeenCalledWith(expect.objectContaining({ disableParallelToolUse: true }));
  });

  it("applyTaxes real: el impuesto siempre se calcula sobre el neto real con la tasa configurada por hotel, nunca sobre un monto que el 'LLM' proponga", () => {
    // Prueba directa del motor (sin pasar por el tool-calling) para dejar constancia,
    // dentro de esta misma suite nombrada por REQ-AGT-004, de que `applyTaxes` es una
    // funcion pura y determinista: mismos net+tasas -> mismo resultado siempre, sin
    // aleatoriedad ni "juicio" de un modelo.
    const a = applyTaxes(1500, { ivaRate: 0.16, ishRate: 0.03 });
    const b = applyTaxes(1500, { ivaRate: 0.16, ishRate: 0.03 });
    expect(a).toEqual(b);
    expect(a.totalAmount).toBe(1500 + 1500 * 0.16 + 1500 * 0.03);
  });
});
