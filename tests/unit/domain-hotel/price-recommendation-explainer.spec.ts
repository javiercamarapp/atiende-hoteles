// REQ-REV-005 (P1/F, fuentes BP-003/H02-002): "el agente de revenue debe poder explicar
// en lenguaje natural, en español, por qué recomienda un precio (pick-up, compset,
// evento, tipo de cambio) al consultarlo el dueño." Verifica que `explainPriceRecommendation`
// sea determinista (misma entrada -> misma salida), nunca invente un factor cuando no
// se le da ninguno, y ordene los factores por magnitud de mayor a menor.
import { describe, expect, it } from "vitest";
import {
  PriceExplanationError,
  assertValidPriceRecommendationInput,
  explainPriceRecommendation,
  type PriceRecommendationInput,
} from "@atiende-hoteles/domain-hotel";

function baseInput(overrides: Partial<PriceRecommendationInput> = {}): PriceRecommendationInput {
  return {
    hotelId: "hotel-1",
    fecha: "2026-12-24",
    currentPrice: 2000,
    recommendedPrice: 2200,
    currency: "MXN",
    factors: [{ kind: "pickup", onTheBooksVsExpectedPct: 15 }],
    ...overrides,
  };
}

describe("assertValidPriceRecommendationInput", () => {
  it("acepta un input válido sin lanzar", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput())).not.toThrow();
  });

  it("rechaza hotelId vacío", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ hotelId: "" }))).toThrow(/hotel_id_faltante/);
  });

  it("rechaza fecha con formato distinto de YYYY-MM-DD", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ fecha: "24/12/2026" }))).toThrow(/fecha_invalida/);
    expect(() => assertValidPriceRecommendationInput(baseInput({ fecha: "2026-12-24T00:00:00Z" }))).toThrow(/fecha_invalida/);
  });

  it("rechaza precio actual no positivo o no finito", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ currentPrice: 0 }))).toThrow(/precio_actual_invalido/);
    expect(() => assertValidPriceRecommendationInput(baseInput({ currentPrice: -5 }))).toThrow(/precio_actual_invalido/);
    expect(() => assertValidPriceRecommendationInput(baseInput({ currentPrice: Number.NaN }))).toThrow(/precio_actual_invalido/);
  });

  it("rechaza precio recomendado negativo o no finito (0 sí es válido: cerrar la venta)", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ recommendedPrice: -1 }))).toThrow(/precio_recomendado_invalido/);
    expect(() => assertValidPriceRecommendationInput(baseInput({ recommendedPrice: Number.POSITIVE_INFINITY }))).toThrow(
      /precio_recomendado_invalido/,
    );
    expect(() => assertValidPriceRecommendationInput(baseInput({ recommendedPrice: 0 }))).not.toThrow();
  });

  it("rechaza moneda vacía", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ currency: "" }))).toThrow(/moneda_faltante/);
  });

  it("rechaza lista de factores vacía -- nunca inventa una razón genérica", () => {
    expect(() => assertValidPriceRecommendationInput(baseInput({ factors: [] }))).toThrow(PriceExplanationError);
    expect(() => assertValidPriceRecommendationInput(baseInput({ factors: [] }))).toThrow(/sin_factores/);
  });

  it("rechaza dos factores del mismo tipo (ambigüedad: cuál es el vigente)", () => {
    expect(() =>
      assertValidPriceRecommendationInput(
        baseInput({
          factors: [
            { kind: "pickup", onTheBooksVsExpectedPct: 10 },
            { kind: "pickup", onTheBooksVsExpectedPct: -5 },
          ],
        }),
      ),
    ).toThrow(/factor_duplicado/);
  });

  it("rechaza factor de evento sin nombre, con impacto inválido o magnitud no positiva", () => {
    expect(() =>
      assertValidPriceRecommendationInput(baseInput({ factors: [{ kind: "evento", nombre: "", impacto: "alza_demanda", magnitudPct: 10 }] })),
    ).toThrow(/evento_sin_nombre/);
    expect(() =>
      assertValidPriceRecommendationInput(
        baseInput({ factors: [{ kind: "evento", nombre: "Spring Break", impacto: "otra_cosa" as never, magnitudPct: 10 }] }),
      ),
    ).toThrow(/evento_impacto_invalido/);
    expect(() =>
      assertValidPriceRecommendationInput(baseInput({ factors: [{ kind: "evento", nombre: "Spring Break", impacto: "alza_demanda", magnitudPct: 0 }] })),
    ).toThrow(/evento_magnitud_invalida/);
  });

  it("rechaza factor de tipo de cambio sin moneda o con variación no finita", () => {
    expect(() =>
      assertValidPriceRecommendationInput(baseInput({ factors: [{ kind: "tipo_cambio", moneda: "", variacionPct: 3 }] })),
    ).toThrow(/tipo_cambio_sin_moneda/);
    expect(() =>
      assertValidPriceRecommendationInput(baseInput({ factors: [{ kind: "tipo_cambio", moneda: "USD", variacionPct: Number.NaN }] })),
    ).toThrow(/tipo_cambio_invalido/);
  });

  it("rechaza factor de compset con magnitud no finita", () => {
    expect(() =>
      assertValidPriceRecommendationInput(baseInput({ factors: [{ kind: "compset", ownRateVsMedianPct: Number.NaN }] })),
    ).toThrow(/compset_invalido/);
  });
});

describe("explainPriceRecommendation", () => {
  it("es determinista: la misma entrada produce exactamente la misma salida", () => {
    const input = baseInput();
    expect(explainPriceRecommendation(input)).toEqual(explainPriceRecommendation(input));
  });

  it("reporta direction 'sube' y el % correcto cuando el precio recomendado es mayor", () => {
    const r = explainPriceRecommendation(baseInput({ currentPrice: 2000, recommendedPrice: 2200 }));
    expect(r.direction).toBe("sube");
    expect(r.deltaPct).toBeCloseTo(10, 9);
    expect(r.headline).toContain("sube 10%");
    expect(r.headline).toContain("2026-12-24");
    expect(r.headline).toContain("2000");
    expect(r.headline).toContain("2200");
    expect(r.headline).toContain("MXN");
  });

  it("reporta direction 'baja' y el % correcto cuando el precio recomendado es menor", () => {
    const r = explainPriceRecommendation(baseInput({ currentPrice: 2000, recommendedPrice: 1800 }));
    expect(r.direction).toBe("baja");
    expect(r.deltaPct).toBeCloseTo(-10, 9);
    expect(r.headline).toContain("baja 10%");
  });

  it("reporta direction 'sin_cambio' cuando el precio recomendado es igual al actual", () => {
    const r = explainPriceRecommendation(baseInput({ currentPrice: 2000, recommendedPrice: 2000 }));
    expect(r.direction).toBe("sin_cambio");
    expect(r.deltaPct).toBe(0);
    expect(r.headline).toContain("se mantiene sin cambio");
  });

  it("no reporta 'sube'/'baja' por ruido de punto flotante en un cambio prácticamente nulo", () => {
    const r = explainPriceRecommendation(baseInput({ currentPrice: 2000, recommendedPrice: 2000 + 1e-10 }));
    expect(r.direction).toBe("sin_cambio");
  });

  it("redacta el factor de pick-up con la dirección correcta (por encima / por debajo)", () => {
    const arriba = explainPriceRecommendation(baseInput({ factors: [{ kind: "pickup", onTheBooksVsExpectedPct: 15 }] }));
    expect(arriba.factors[0]!.text).toBe(
      "El pick-up (reservas ya en libro) está 15% por encima de lo esperado por el histórico para esta fecha.",
    );

    const abajo = explainPriceRecommendation(baseInput({ factors: [{ kind: "pickup", onTheBooksVsExpectedPct: -8 }] }));
    expect(abajo.factors[0]!.text).toBe(
      "El pick-up (reservas ya en libro) está 8% por debajo de lo esperado por el histórico para esta fecha.",
    );
  });

  it("redacta el factor de compset con la dirección correcta", () => {
    const arriba = explainPriceRecommendation(baseInput({ factors: [{ kind: "compset", ownRateVsMedianPct: 12 }] }));
    expect(arriba.factors[0]!.text).toBe("La tarifa propia está 12% por encima de la mediana del compset.");

    const abajo = explainPriceRecommendation(baseInput({ factors: [{ kind: "compset", ownRateVsMedianPct: -6.4 }] }));
    expect(abajo.factors[0]!.text).toBe("La tarifa propia está 6.4% por debajo de la mediana del compset.");
  });

  it("redacta el factor de evento con el nombre y el efecto correctos", () => {
    const alza = explainPriceRecommendation(
      baseInput({ factors: [{ kind: "evento", nombre: "Spring Break", impacto: "alza_demanda", magnitudPct: 20 }] }),
    );
    expect(alza.factors[0]!.text).toBe('Hay un evento relevante ("Spring Break") que suele subir la demanda en un 20%.');

    const baja = explainPriceRecommendation(
      baseInput({ factors: [{ kind: "evento", nombre: "Alerta de huracán", impacto: "baja_demanda", magnitudPct: 30 }] }),
    );
    expect(baja.factors[0]!.text).toBe('Hay un evento relevante ("Alerta de huracán") que suele bajar la demanda en un 30%.');
  });

  it("redacta el factor de tipo de cambio con la dirección correcta", () => {
    const fuerte = explainPriceRecommendation(baseInput({ factors: [{ kind: "tipo_cambio", moneda: "USD", variacionPct: 4 }] }));
    expect(fuerte.factors[0]!.text).toBe("El USD se fortaleció 4% frente al peso en el periodo reciente.");

    const debil = explainPriceRecommendation(baseInput({ factors: [{ kind: "tipo_cambio", moneda: "USD", variacionPct: -3.2 }] }));
    expect(debil.factors[0]!.text).toBe("El USD se debilitó 3.2% frente al peso en el periodo reciente.");
  });

  it("ordena los factores de mayor a menor magnitud, sin importar el orden de entrada", () => {
    const r = explainPriceRecommendation(
      baseInput({
        factors: [
          { kind: "tipo_cambio", moneda: "USD", variacionPct: 2 },
          { kind: "evento", nombre: "Congreso médico", impacto: "alza_demanda", magnitudPct: 25 },
          { kind: "pickup", onTheBooksVsExpectedPct: -10 },
          { kind: "compset", ownRateVsMedianPct: 15 },
        ],
      }),
    );
    expect(r.factors.map((f) => f.kind)).toEqual(["evento", "compset", "pickup", "tipo_cambio"]);
  });

  it("redondea las magnitudes a 1 decimal en el texto sin alterar deltaPct", () => {
    const r = explainPriceRecommendation(
      baseInput({ currentPrice: 3, recommendedPrice: 4, factors: [{ kind: "pickup", onTheBooksVsExpectedPct: 12.3456 }] }),
    );
    expect(r.factors[0]!.text).toContain("12.3%");
    expect(r.deltaPct).toBeCloseTo(33.333333, 5);
  });

  it("fullText concatena el headline y cada texto de factor, en el mismo orden que `factors`", () => {
    const r = explainPriceRecommendation(
      baseInput({
        factors: [
          { kind: "pickup", onTheBooksVsExpectedPct: 5 },
          { kind: "evento", nombre: "Feria comercial", impacto: "alza_demanda", magnitudPct: 40 },
        ],
      }),
    );
    expect(r.fullText).toBe([r.headline, ...r.factors.map((f) => f.text)].join(" "));
    expect(r.fullText.startsWith(r.headline)).toBe(true);
  });

  it("propaga la validación de assertValidPriceRecommendationInput (no duplica reglas, reusa la misma)", () => {
    expect(() => explainPriceRecommendation(baseInput({ factors: [] }))).toThrow(/sin_factores/);
  });
});
