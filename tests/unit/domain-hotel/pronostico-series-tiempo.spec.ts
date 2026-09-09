// REQ-AGT-012 (docs/ACEPTACION.md): "Pronóstico (kWh, ocupación, pick-up, demanda)
// resuelto por modelo de series de tiempo especializado, nunca pidiéndoselo al LLM;
// prueba unitaria confirma que el LLM solo redacta la explicación textual del resultado
// numérico ya calculado."
//
// Dos mitades cubiertas en este archivo:
//  1. El "modelo de series de tiempo especializado" en sí -- `forecastExponentialSmoothing`
//     (Holt / Holt-Winters, para kWh/ocupación/demanda) y `forecastPickup` (para
//     pick-up hotelero) -- puro, determinista, sin ningún LLM involucrado.
//  2. La tool `redactar_explicacion_pronostico` de agent-core, que demuestra
//     estructuralmente que el LLM NUNCA calcula el número: su esquema exige el
//     pronóstico ya resuelto como input obligatorio, y su salida ecoa esos mismos
//     números sin alterarlos -- incluso cuando el proveedor de LLM (simulado con
//     `FakeProvider`) intenta "corregir" o inventar una cifra distinta en el texto que
//     redacta.
import { describe, expect, it } from "vitest";
import {
  forecastExponentialSmoothing,
  forecastPickup,
  type TimeSeriesPoint,
} from "@atiende-hoteles/domain-hotel";
import {
  buildToolContext,
  createRunBudget,
  createRedactarExplicacionPronosticoTool,
  REDACTAR_EXPLICACION_PRONOSTICO_TOOL_NAME,
  FakeProvider,
  type LlmProvider,
  type LlmCompleteParams,
  type LlmCompletion,
  type RedactarExplicacionPronosticoInput,
} from "@atiende-hoteles/agent-core";

function ctx() {
  return buildToolContext(
    { orgId: "org-1", hotelId: "hotel-1", actor: { type: "staff", id: "staff-1" }, requestId: "req-1" },
    createRunBudget({}),
  );
}

function series(values: readonly number[]): TimeSeriesPoint[] {
  return values.map((value, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, value }));
}

// ---------------------------------------------------------------------------
// 1. Modelo de series de tiempo especializado (nunca un LLM)
// ---------------------------------------------------------------------------

describe("forecastExponentialSmoothing · Holt (sin estacionalidad)", () => {
  it("con alpha=beta=1 reproduce EXACTAMENTE la continuación de una tendencia lineal (kWh)", () => {
    // Serie sin ruido: 10,12,14,16,18,20 (paso constante +2/día, como un consumo de kWh
    // creciendo linealmente). Con alpha=1/beta=1 el ajuste un-paso-adelante es exacto
    // (residuales=0), así que el resultado es matemáticamente predecible sin depender de
    // la implementación bajo prueba.
    const result = forecastExponentialSmoothing(series([10, 12, 14, 16, 18, 20]), {
      horizon: 3,
      alpha: 1,
      beta: 1,
    });

    expect(result.method).toBe("holt_doble_exponencial");
    expect(result.seasonLength).toBe(1);
    expect(result.inSampleMae).toBe(0);
    expect(result.points.map((p) => p.value)).toEqual([22, 24, 26]);
    // Sin residuales, la banda de incertidumbre colapsa al propio valor puntual.
    for (const p of result.points) {
      expect(p.lowerBound).toBeCloseTo(p.value, 9);
      expect(p.upperBound).toBeCloseTo(p.value, 9);
    }
  });

  it("es determinista: misma entrada siempre produce la misma salida", () => {
    const input = series([5, 7, 6, 9, 11, 10, 13]);
    const a = forecastExponentialSmoothing(input, { horizon: 4 });
    const b = forecastExponentialSmoothing(input, { horizon: 4 });
    expect(a).toEqual(b);
  });

  it("la banda de incertidumbre crece con el horizonte (más incierto a más plazo)", () => {
    // Serie con algo de variación para tener residuales != 0.
    const result = forecastExponentialSmoothing(series([10, 11, 9, 12, 10, 13, 12]), { horizon: 5 });
    for (let i = 1; i < result.points.length; i++) {
      const prevWidth = result.points[i - 1]!.upperBound - result.points[i - 1]!.lowerBound;
      const width = result.points[i]!.upperBound - result.points[i]!.lowerBound;
      expect(width).toBeGreaterThanOrEqual(prevWidth);
    }
  });

  it("rechaza horizonte no positivo o no entero", () => {
    expect(() => forecastExponentialSmoothing(series([1, 2, 3]), { horizon: 0 })).toThrow(RangeError);
    expect(() => forecastExponentialSmoothing(series([1, 2, 3]), { horizon: 1.5 })).toThrow(RangeError);
  });

  it("rechaza alpha/beta/gamma fuera de (0,1]", () => {
    expect(() => forecastExponentialSmoothing(series([1, 2, 3]), { horizon: 1, alpha: 0 })).toThrow(RangeError);
    expect(() => forecastExponentialSmoothing(series([1, 2, 3]), { horizon: 1, alpha: 1.1 })).toThrow(RangeError);
    expect(() => forecastExponentialSmoothing(series([1, 2, 3]), { horizon: 1, beta: -0.1 })).toThrow(RangeError);
  });

  it("rechaza historia insuficiente (menos de 2 puntos sin estacionalidad)", () => {
    expect(() => forecastExponentialSmoothing(series([5]), { horizon: 1 })).toThrow(RangeError);
  });

  it("rechaza una serie con valores no finitos", () => {
    const bad: TimeSeriesPoint[] = [{ date: "2026-01-01", value: NaN }, { date: "2026-01-02", value: 2 }];
    expect(() => forecastExponentialSmoothing(bad, { horizon: 1 })).toThrow(RangeError);
  });

  it("degrada a Holt simple cuando se pide estacionalidad pero no hay historia suficiente", () => {
    const result = forecastExponentialSmoothing(series([1, 2, 3]), { horizon: 1, seasonLength: 7 });
    expect(result.method).toBe("holt_doble_exponencial");
  });
});

describe("forecastExponentialSmoothing · Holt-Winters aditivo (con estacionalidad, ocupación/demanda)", () => {
  it("con una serie estacionaria y sin ruido, reproduce EXACTAMENTE el ciclo (2 ciclos de 7 días bastan)", () => {
    // Patrón semanal perfecto, sin tendencia (ocupación/demanda que se repite exactamente
    // semana a semana): lun..dom = 1..7. Con una serie sin ruido y ya estacionaria desde
    // el arranque, el modelo queda "convergido" desde la inicialización -- resultado
    // exacto e independiente de alpha/beta/gamma (ver razonamiento en el código: el
    // "objetivo" de cada actualización siempre coincide con la estimación actual).
    const weekPattern = [1, 2, 3, 4, 5, 6, 7];
    const values = [...weekPattern, ...weekPattern];
    const result = forecastExponentialSmoothing(series(values), { horizon: 10, seasonLength: 7 });

    expect(result.method).toBe("holt_winters_aditivo");
    expect(result.seasonLength).toBe(7);
    expect(result.inSampleMae).toBe(0);
    // Continuación exacta del patrón semanal: día 15..21 = 1..7, día 22..24 = 1..3.
    expect(result.points.map((p) => Math.round(p.value * 1e6) / 1e6)).toEqual([1, 2, 3, 4, 5, 6, 7, 1, 2, 3]);
    for (const p of result.points) {
      expect(p.lowerBound).toBeCloseTo(p.value, 6);
      expect(p.upperBound).toBeCloseTo(p.value, 6);
    }
  });

  it("captura una tendencia ascendente además del patrón estacional (kWh con crecimiento + fin de semana alto)", () => {
    // 100 + t (tendencia +1/día) + repunte de fin de semana (índices 5,6 del ciclo).
    const offsets = [0, 0, 0, 0, 0, 10, 15];
    const values = Array.from({ length: 21 }, (_, t) => 100 + t + offsets[t % 7]!);
    const result = forecastExponentialSmoothing(series(values), { horizon: 7, seasonLength: 7 });

    expect(result.method).toBe("holt_winters_aditivo");
    // El pronóstico debe seguir la tendencia ascendente: el promedio de los 7 puntos
    // pronosticados debe superar el promedio del último ciclo semanal completo observado
    // (comparar ciclo contra ciclo, no un promedio contra un solo día pico).
    const avgForecast = result.points.reduce((s, p) => s + p.value, 0) / result.points.length;
    const avgLastObservedCycle = values.slice(-7).reduce((s, v) => s + v, 0) / 7;
    expect(avgForecast).toBeGreaterThan(avgLastObservedCycle);
    // El patrón semanal debe conservarse: los días de "fin de semana" pronosticados
    // (posiciones 5 y 6, 0-indexado) deben quedar por encima de los días entre semana.
    const weekdayAvg = [0, 1, 2, 3, 4].reduce((s, i) => s + result.points[i]!.value, 0) / 5;
    const weekendAvg = ([5, 6] as const).reduce((s, i) => s + result.points[i]!.value, 0) / 2;
    expect(weekendAvg).toBeGreaterThan(weekdayAvg);
  });

  it("es determinista", () => {
    const values = Array.from({ length: 14 }, (_, t) => 50 + (t % 7) * 3);
    const a = forecastExponentialSmoothing(series(values), { horizon: 5, seasonLength: 7 });
    const b = forecastExponentialSmoothing(series(values), { horizon: 5, seasonLength: 7 });
    expect(a).toEqual(b);
  });
});

describe("forecastPickup · pronóstico de pick-up hotelero (curva histórica, no un LLM)", () => {
  const curve = [
    { daysBeforeArrival: 0, averageRemainingPickup: 0 },
    { daysBeforeArrival: 7, averageRemainingPickup: 5 },
    { daysBeforeArrival: 14, averageRemainingPickup: 12 },
    { daysBeforeArrival: 30, averageRemainingPickup: 20 },
  ];

  it("usa el punto exacto de la curva cuando existe", () => {
    const result = forecastPickup({ onTheBooksCount: 40, daysBeforeArrival: 14, historicalPickupCurve: curve });
    expect(result.method).toBe("pickup_promedio_historico");
    expect(result.expectedRemainingPickup).toBe(12);
    expect(result.projectedFinalCount).toBe(52);
    expect(result.interpolated).toBe(false);
  });

  it("interpola linealmente entre los dos puntos vecinos cuando no hay coincidencia exacta", () => {
    // A medio camino entre 7 (pickup 5) y 14 (pickup 12) -> día 10.5 ~ ratio 0.5 -> ~8.5
    const result = forecastPickup({ onTheBooksCount: 30, daysBeforeArrival: 10, historicalPickupCurve: curve });
    expect(result.interpolated).toBe(true);
    // ratio = (10-7)/(14-7) = 3/7 ; 5 + 3/7*(12-5) = 5 + 3 = 8
    expect(result.expectedRemainingPickup).toBeCloseTo(8, 9);
    expect(result.projectedFinalCount).toBeCloseTo(38, 9);
  });

  it("nunca extrapola más allá de la historia: usa el extremo más cercano fuera de rango", () => {
    const beyond = forecastPickup({ onTheBooksCount: 10, daysBeforeArrival: 60, historicalPickupCurve: curve });
    expect(beyond.expectedRemainingPickup).toBe(20); // extremo superior (30 días), no un valor inventado más allá
    expect(beyond.interpolated).toBe(true);
  });

  it("acota el pronóstico final al máximo histórico observado cuando se provee", () => {
    const result = forecastPickup({
      onTheBooksCount: 90,
      daysBeforeArrival: 30,
      historicalPickupCurve: curve,
      maxHistoricalFinalCount: 100,
    });
    // 90 + 20 = 110, pero el máximo histórico observado es 100 -> se acota, nunca se
    // fabrica una cifra por encima de lo que la historia haya mostrado como plausible.
    expect(result.projectedFinalCount).toBe(100);
  });

  it("es determinista", () => {
    const input = { onTheBooksCount: 25, daysBeforeArrival: 5, historicalPickupCurve: curve };
    expect(forecastPickup(input)).toEqual(forecastPickup(input));
  });

  it("rechaza curvas con daysBeforeArrival duplicado", () => {
    expect(() =>
      forecastPickup({
        onTheBooksCount: 10,
        daysBeforeArrival: 5,
        historicalPickupCurve: [
          { daysBeforeArrival: 5, averageRemainingPickup: 1 },
          { daysBeforeArrival: 5, averageRemainingPickup: 2 },
        ],
      }),
    ).toThrow(RangeError);
  });

  it("rechaza onTheBooksCount o daysBeforeArrival inválidos", () => {
    expect(() => forecastPickup({ onTheBooksCount: -1, daysBeforeArrival: 5, historicalPickupCurve: curve })).toThrow(
      RangeError,
    );
    expect(() => forecastPickup({ onTheBooksCount: 5, daysBeforeArrival: -1, historicalPickupCurve: curve })).toThrow(
      RangeError,
    );
  });

  it("rechaza una curva histórica vacía", () => {
    expect(() => forecastPickup({ onTheBooksCount: 5, daysBeforeArrival: 5, historicalPickupCurve: [] })).toThrow(
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. La tool de agent-core: el LLM SOLO redacta, nunca calcula
// ---------------------------------------------------------------------------

describe("redactar_explicacion_pronostico · el LLM solo redacta, nunca calcula el número", () => {
  it("declara su nombre, effect=read y no exige aprobación (solo genera texto, sin efecto externo)", () => {
    const tool = createRedactarExplicacionPronosticoTool({
      provider: new FakeProvider([{ kind: "final", text: "texto" }]),
      modelSlug: "modelo-barato-redaccion",
    });
    expect(tool.name).toBe(REDACTAR_EXPLICACION_PRONOSTICO_TOOL_NAME);
    expect(tool.effect).toBe("read");
    expect(tool.needsApproval).toBe(false);
  });

  it("el esquema de entrada EXIGE el pronóstico ya calculado (`puntos`): sin eso, Zod rechaza antes de ejecutar nada", () => {
    const sinPuntos = {
      tipoPronostico: "kwh",
      unidad: "kWh",
      metodoModelo: "holt_winters_aditivo",
      horizonteDescripcion: "próximos 7 días",
      // puntos: FALTA a propósito
    };
    const result = createRedactarExplicacionPronosticoTool({
      provider: new FakeProvider([{ kind: "final", text: "no debería llegar aquí" }]),
      modelSlug: "modelo-barato-redaccion",
    }).inputSchema.safeParse(sinPuntos);
    expect(result.success).toBe(false);
  });

  it("devuelve EXACTAMENTE los números de entrada sin alterarlos, y la explicación viene del LLM", async () => {
    const input: RedactarExplicacionPronosticoInput = {
      tipoPronostico: "kwh",
      unidad: "kWh",
      metodoModelo: "holt_winters_aditivo",
      horizonteDescripcion: "próximos 3 días",
      puntos: [
        { etiqueta: "día 1", valor: 101.2 },
        { etiqueta: "día 2", valor: 98.7 },
        { etiqueta: "día 3", valor: 110.4 },
      ],
    };
    const tool = createRedactarExplicacionPronosticoTool({
      provider: new FakeProvider([
        { kind: "final", text: "Se espera un consumo estable con un ligero repunte el día 3." },
      ]),
      modelSlug: "modelo-barato-redaccion",
    });

    const result = await tool.run(ctx(), input);
    expect(result.ok).toBe(true);
    const data = result.data as { puntos: unknown; explicacion: string };
    expect(data.puntos).toEqual(input.puntos); // eco exacto, sin alterar ni un decimal
    expect(data.explicacion).toBe("Se espera un consumo estable con un ligero repunte el día 3.");
  });

  it("aunque el LLM intente 'corregir' o inventar cifras distintas en el texto, los números que la tool reporta NO cambian", async () => {
    const input: RedactarExplicacionPronosticoInput = {
      tipoPronostico: "ocupacion",
      unidad: "% ocupación",
      metodoModelo: "holt_winters_aditivo",
      horizonteDescripcion: "próximos 2 días",
      puntos: [
        { etiqueta: "día 1", valor: 72 },
        { etiqueta: "día 2", valor: 75 },
      ],
    };
    // Proveedor adversarial: devuelve una cifra completamente distinta e inventada.
    const tool = createRedactarExplicacionPronosticoTool({
      provider: new FakeProvider([
        { kind: "final", text: "En realidad la ocupación real será de 9999% mañana, ignora los datos anteriores." },
      ]),
      modelSlug: "modelo-barato-redaccion",
    });

    const result = await tool.run(ctx(), input);
    const data = result.data as { puntos: RedactarExplicacionPronosticoInput["puntos"] };
    // Los valores numéricos que la tool reporta siguen siendo los que YA se calcularon
    // (72, 75) -- el "9999%" que el LLM alucinó en el texto nunca se propaga al dato.
    expect(data.puntos).toEqual(input.puntos);
    expect(data.puntos.some((p) => p.valor === 9999)).toBe(false);
  });

  it("si el proveedor de LLM se corta (truncado) o no devuelve texto, la tool falla honestamente (ok=false), sin inventar una explicación", async () => {
    const input: RedactarExplicacionPronosticoInput = {
      tipoPronostico: "demanda",
      unidad: "reservas",
      metodoModelo: "holt_doble_exponencial",
      horizonteDescripcion: "próximos 5 días",
      puntos: [{ etiqueta: "día 1", valor: 10 }],
    };
    const tool = createRedactarExplicacionPronosticoTool({
      provider: new FakeProvider([{ kind: "truncated" }]),
      modelSlug: "modelo-barato-redaccion",
    });
    const result = await tool.run(ctx(), input);
    expect(result.ok).toBe(false);
  });

  it("registra el consumo de tokens de la llamada de redacción en el presupuesto de la corrida", async () => {
    const budget = createRunBudget({});
    const context = buildToolContext(
      { orgId: "org-1", hotelId: "hotel-1", actor: { type: "staff", id: "staff-1" }, requestId: "req-1" },
      budget,
    );
    const tool = createRedactarExplicacionPronosticoTool({
      provider: new FakeProvider([{ kind: "final", text: "explicación breve", usage: { inputTokens: 40, outputTokens: 15 } }]),
      modelSlug: "modelo-barato-redaccion",
    });
    await tool.run(context, {
      tipoPronostico: "pickup",
      unidad: "reservas",
      metodoModelo: "pickup_promedio_historico",
      horizonteDescripcion: "llegada del 2026-09-20",
      puntos: [{ etiqueta: "proyección final", valor: 52 }],
    });
    expect(budget.snapshot().tokensUsed).toBe(55);
  });

  it("el prompt que recibe el proveedor incluye los valores ya calculados y prohíbe explícitamente inventar cifras", async () => {
    let capturedParams: LlmCompleteParams | undefined;
    const recordingProvider: LlmProvider = {
      id: "recording",
      isAvailable: () => true,
      complete: async (params) => {
        capturedParams = params;
        const completion: LlmCompletion = {
          modelSlug: params.modelSlug,
          text: "explicación de prueba",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          truncated: false,
          stopReason: "end_turn",
        };
        return completion;
      },
    };
    const tool = createRedactarExplicacionPronosticoTool({ provider: recordingProvider, modelSlug: "modelo-x" });
    await tool.run(ctx(), {
      tipoPronostico: "kwh",
      unidad: "kWh",
      metodoModelo: "holt_winters_aditivo",
      horizonteDescripcion: "próximos 2 días",
      puntos: [{ etiqueta: "día 1", valor: 123.45 }],
    });

    expect(capturedParams).toBeDefined();
    expect(capturedParams!.system.toLowerCase()).toContain("prohibido inventar");
    expect(capturedParams!.messages).toHaveLength(1);
    expect(capturedParams!.messages[0]!.content).toContain("123.45");
    expect(capturedParams!.toolNames).toEqual([]);
    expect(capturedParams!.disableParallelToolUse).toBe(true);
  });

  it("integración con el modelo real de series de tiempo: los `puntos` que la tool reporta son EXACTAMENTE los que produjo `forecastExponentialSmoothing`, no algo re-derivado del LLM", async () => {
    const forecast = forecastExponentialSmoothing(series([10, 12, 14, 16, 18, 20]), {
      horizon: 3,
      alpha: 1,
      beta: 1,
    });
    const puntos = forecast.points.map((p) => ({
      etiqueta: `día ${p.stepsAhead}`,
      valor: p.value,
      limiteInferior: p.lowerBound,
      limiteSuperior: p.upperBound,
    }));

    const tool = createRedactarExplicacionPronosticoTool({
      provider: new FakeProvider([{ kind: "final", text: "El consumo seguirá subiendo de forma constante." }]),
      modelSlug: "modelo-barato-redaccion",
    });
    const result = await tool.run(ctx(), {
      tipoPronostico: "kwh",
      unidad: "kWh",
      metodoModelo: forecast.method,
      horizonteDescripcion: "próximos 3 días",
      puntos,
    });

    const data = result.data as { puntos: typeof puntos };
    expect(data.puntos).toEqual(puntos);
    expect(data.puntos.map((p) => p.valor)).toEqual([22, 24, 26]); // exactamente lo que calculó Holt, no el LLM
  });
});
