// REQ-AGT-012 (LLM-004/LLM-009): "el pronóstico (kWh, ocupación, pick-up, demanda) debe
// resolverse con un modelo de series de tiempo especializado, nunca pidiéndoselo
// directamente a un LLM; el LLM solo redacta la explicación textual del resultado."
//
// Esta tool es la MITAD "LLM" de esa separación, y su esquema de entrada es justamente lo
// que impone el límite: exige `puntos` -- el pronóstico YA CALCULADO (fecha/valor,
// opcionalmente banda) -- como campo obligatorio del input. No hay ningún camino en este
// archivo para que el modelo "pida" un pronóstico: si no le dan los números ya resueltos
// (por `@atiende-hoteles/domain-hotel` `forecastExponentialSmoothing()`/`forecastPickup()`,
// fuera de esta tool), Zod rechaza la llamada antes de que `run()` se ejecute. `run()`
// nunca recalcula ni ajusta esos números -- los usa tal cual llegaron (`data.puntos` es
// literalmente `input.puntos`, nunca algo derivado del texto que devuelva el LLM) y le
// pide al proveedor ÚNICAMENTE que redacte una explicación en palabras, con una
// instrucción explícita de no inventar/corregir cifras.
import { z } from "zod";
import { defineTool, type ToolDefinition } from "../tool.ts";
import type { LlmProvider } from "../provider.ts";

export interface ForecastExplanationToolDeps {
  readonly provider: LlmProvider;
  /** Modelo a usar para la redacción -- puede (y debería) ser un modelo de bajo costo:
   *  redactar una explicación de números ya conocidos no necesita razonamiento pesado. */
  readonly modelSlug: string;
}

const forecastKindEnum = z.enum(["kwh", "ocupacion", "pickup", "demanda"]);

const forecastPointInput = z.object({
  /** Ya calculada por el motor de series de tiempo -- una fecha, un "día N" o una
   *  etiqueta equivalente; este campo es descriptivo, nunca se reinterpreta. */
  etiqueta: z.string().trim().min(1).max(40),
  valor: z.number().finite(),
  limiteInferior: z.number().finite().optional(),
  limiteSuperior: z.number().finite().optional(),
});

const redactarExplicacionPronosticoInput = z.object({
  tipoPronostico: forecastKindEnum,
  /** Unidad del valor pronosticado, p.ej. "kWh", "% ocupación", "reservas". */
  unidad: z.string().trim().min(1).max(30),
  /** Nombre del método/modelo de series de tiempo que YA produjo `puntos` -- p.ej.
   *  "holt_winters_aditivo" o "pickup_promedio_historico" (ver
   *  `@atiende-hoteles/domain-hotel` `forecastExponentialSmoothing()`/`forecastPickup()`).
   *  Puramente informativo para la redacción; esta tool no lo valida contra un catálogo
   *  fijo porque no le corresponde recalcular ni auditar el modelo, solo redactar. */
  metodoModelo: z.string().trim().min(1).max(80),
  /** Descripción humana del horizonte, p.ej. "próximos 7 días" o "llegada del 2026-09-20". */
  horizonteDescripcion: z.string().trim().min(1).max(120),
  /** El pronóstico YA CALCULADO. Obligatorio y no vacío: sin esto la tool no tiene nada
   *  que explicar (y, sobre todo, no hay forma de que termine pidiéndole el número al
   *  LLM). */
  puntos: z.array(forecastPointInput).min(1).max(60),
  /** Métrica de calidad YA CALCULADA (p.ej. "MAE histórico 3.2 kWh"), no una opinión. */
  notaCalidad: z.string().trim().max(200).optional(),
});
export type RedactarExplicacionPronosticoInput = z.infer<typeof redactarExplicacionPronosticoInput>;

export const REDACTAR_EXPLICACION_PRONOSTICO_TOOL_NAME = "redactar_explicacion_pronostico";

const MAX_EXPLANATION_WORDS = 60;
const MAX_OUTPUT_TOKENS = 220;

function buildSystemPrompt(): string {
  return (
    "Eres un redactor. Se te entrega un pronóstico que YA FUE CALCULADO por un modelo de " +
    "series de tiempo especializado -- tú NUNCA calculas, recalculas, ajustas ni corriges " +
    `ningún valor numérico. Tu única tarea es redactar, en español, una explicación breve ` +
    `(máximo ${MAX_EXPLANATION_WORDS} palabras) para el equipo del hotel. Si mencionas un ` +
    "número en tu explicación, debe ser EXACTAMENTE uno de los valores que se te dan a " +
    "continuación -- está prohibido inventar, estimar o adivinar cualquier cifra que no " +
    "aparezca ya en los datos."
  );
}

function buildUserMessage(input: RedactarExplicacionPronosticoInput): string {
  return JSON.stringify({
    tipo_pronostico: input.tipoPronostico,
    unidad: input.unidad,
    metodo_modelo_ya_aplicado: input.metodoModelo,
    horizonte: input.horizonteDescripcion,
    puntos_ya_calculados: input.puntos,
    nota_calidad: input.notaCalidad ?? null,
  });
}

/**
 * REQ-AGT-012: tool que SOLO redacta la explicación textual de un pronóstico ya resuelto
 * por un modelo de series de tiempo (`@atiende-hoteles/domain-hotel`). `effect: "read"`:
 * no persiste nada ni tiene efecto externo, solo genera texto -- GOB-026 no aplica.
 */
export function createRedactarExplicacionPronosticoTool(
  deps: ForecastExplanationToolDeps,
): ToolDefinition<RedactarExplicacionPronosticoInput> {
  return defineTool({
    name: REDACTAR_EXPLICACION_PRONOSTICO_TOOL_NAME,
    description:
      "Redacta en español una explicación breve de un pronóstico (kWh, ocupación, pick-up o demanda) que ya fue " +
      "calculado por un modelo de series de tiempo. No calcula ningún pronóstico: requiere los valores ya resueltos.",
    inputSchema: redactarExplicacionPronosticoInput,
    effect: "read",
    needsApproval: false,
    run: async (ctx, input) => {
      const completion = await deps.provider.complete({
        modelSlug: deps.modelSlug,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: buildUserMessage(input) }],
        toolNames: [],
        temperature: 0.2,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        disableParallelToolUse: true,
        effort: "low",
      });
      ctx.budget.registrarTokens(completion.usage.inputTokens, completion.usage.outputTokens);

      if (completion.truncated || !completion.text || completion.text.trim().length === 0) {
        return {
          ok: false,
          summary: "No se pudo redactar la explicación del pronóstico (respuesta del proveedor de LLM incompleta o vacía).",
        };
      }

      const explicacion = completion.text.trim();
      return {
        ok: true,
        summary: explicacion.length <= 200 ? explicacion : `${explicacion.slice(0, 197)}...`,
        // `puntos` es EXACTAMENTE `input.puntos` -- nunca algo derivado de `explicacion`.
        data: {
          tipoPronostico: input.tipoPronostico,
          metodoModelo: input.metodoModelo,
          puntos: input.puntos,
          explicacion,
          modelSlug: completion.modelSlug,
        },
      };
    },
  });
}
