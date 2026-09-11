// REQ-REV-019 (P2/GOB, BP-149/H17-004/H17-005): "precio de venta con techo ≤20-30% del
// valor conservador deduplicado, descuentos por tamaño/ADR, y factor de deduplicación
// cuando ≥2 agentes con valor solapado se activan juntos (verificado con caso de
// solape sintético)" -- docs/ACEPTACION.md §3.7.
import { describe, expect, it } from "vitest";
import {
  DESCUENTO_ADR_FACTOR,
  DESCUENTO_ADR_UMBRAL_MXN,
  DESCUENTO_TAMANO_FACTOR,
  DESCUENTO_TAMANO_UMBRAL_HABITACIONES,
  FACTOR_DEDUPLICACION_DEFAULT,
  PricingTechoError,
  TECHO_FRACCION_MAXIMA,
  TECHO_FRACCION_PISO,
  calcularFraccionTecho,
  calcularPrecioTechoMxn,
  calcularValorConservadorDeduplicado,
  evaluarPrecioVentaPropuesto,
  type AgenteValorConservador,
} from "@atiende-hoteles/domain-hotel";

describe("REQ-REV-019: deduplicación de valor solapado (H17-005)", () => {
  it("sin solapamiento (agentes sin grupo), el valor conservador deduplicado es la suma simple", () => {
    const agentes: AgenteValorConservador[] = [
      { nombre: "recepcion_digital", valorConservadorMensualMxn: 10_000 },
      { nombre: "housekeeping_ia", valorConservadorMensualMxn: 5_000 },
    ];
    expect(calcularValorConservadorDeduplicado(agentes)).toBe(15_000);
  });

  it("caso de solape sintético: ≥2 agentes del mismo grupo se ajustan por el factor 0.75 (H17-005: voz+WhatsApp+directo)", () => {
    const agentes: AgenteValorConservador[] = [
      { nombre: "voz", valorConservadorMensualMxn: 10_000, grupoSolapamiento: "captura_directa" },
      { nombre: "whatsapp", valorConservadorMensualMxn: 8_000, grupoSolapamiento: "captura_directa" },
      { nombre: "directo_web", valorConservadorMensualMxn: 6_000, grupoSolapamiento: "captura_directa" },
    ];
    // Subtotal bruto del grupo: 24,000 -> deduplicado: 24,000 * 0.75 = 18,000.
    expect(calcularValorConservadorDeduplicado(agentes)).toBeCloseTo(18_000, 6);
  });

  it("un solo agente activo en un grupo NO se deduplica (hace falta que ≥2 se activen juntos)", () => {
    const agentes: AgenteValorConservador[] = [
      { nombre: "voz", valorConservadorMensualMxn: 10_000, grupoSolapamiento: "captura_directa" },
    ];
    expect(calcularValorConservadorDeduplicado(agentes)).toBe(10_000);
  });

  it("segundo caso de solape sintético: dos grupos distintos activos a la vez (RM+reputación+CRM y captura_directa) se deduplican cada uno de forma independiente", () => {
    const agentes: AgenteValorConservador[] = [
      { nombre: "voz", valorConservadorMensualMxn: 10_000, grupoSolapamiento: "captura_directa" },
      { nombre: "whatsapp", valorConservadorMensualMxn: 8_000, grupoSolapamiento: "captura_directa" },
      { nombre: "revenue_management", valorConservadorMensualMxn: 12_000, grupoSolapamiento: "tarifa_realizada" },
      { nombre: "reputacion", valorConservadorMensualMxn: 4_000, grupoSolapamiento: "tarifa_realizada" },
      { nombre: "crm_marketing", valorConservadorMensualMxn: 4_000, grupoSolapamiento: "tarifa_realizada" },
      { nombre: "back_office", valorConservadorMensualMxn: 3_000 }, // sin grupo: no se deduplica
    ];
    // captura_directa: (10,000+8,000)*0.75 = 13,500
    // tarifa_realizada: (12,000+4,000+4,000)*0.75 = 15,000
    // back_office: 3,000 (sin grupo)
    expect(calcularValorConservadorDeduplicado(agentes)).toBeCloseTo(13_500 + 15_000 + 3_000, 6);
  });

  it("acepta un factor de deduplicación distinto del default explícitamente", () => {
    const agentes: AgenteValorConservador[] = [
      { nombre: "a", valorConservadorMensualMxn: 1_000, grupoSolapamiento: "g" },
      { nombre: "b", valorConservadorMensualMxn: 1_000, grupoSolapamiento: "g" },
    ];
    expect(calcularValorConservadorDeduplicado(agentes, 0.5)).toBeCloseTo(1_000, 6);
  });

  it("FACTOR_DEDUPLICACION_DEFAULT es 0.75 (H17-005)", () => {
    expect(FACTOR_DEDUPLICACION_DEFAULT).toBe(0.75);
  });

  it("rechaza un valor conservador negativo o no finito", () => {
    const agentes: AgenteValorConservador[] = [{ nombre: "a", valorConservadorMensualMxn: -1 }];
    expect(() => calcularValorConservadorDeduplicado(agentes)).toThrow(PricingTechoError);
    expect(() =>
      calcularValorConservadorDeduplicado([{ nombre: "a", valorConservadorMensualMxn: Number.NaN }]),
    ).toThrow(PricingTechoError);
  });

  it("rechaza un agente repetido en la misma lista", () => {
    const agentes: AgenteValorConservador[] = [
      { nombre: "voz", valorConservadorMensualMxn: 1_000 },
      { nombre: "voz", valorConservadorMensualMxn: 2_000 },
    ];
    expect(() => calcularValorConservadorDeduplicado(agentes)).toThrow(/agente_duplicado/);
  });

  it("rechaza un factor de deduplicación fuera de (0, 1]", () => {
    const agentes: AgenteValorConservador[] = [{ nombre: "a", valorConservadorMensualMxn: 100 }];
    expect(() => calcularValorConservadorDeduplicado(agentes, 0)).toThrow(PricingTechoError);
    expect(() => calcularValorConservadorDeduplicado(agentes, 1.1)).toThrow(PricingTechoError);
  });
});

describe("REQ-REV-019: fracción techo con descuentos por tamaño/ADR (H17-004)", () => {
  it("hotel pequeño y de ADR alto: techo en el máximo de la banda, 30%", () => {
    const fraccion = calcularFraccionTecho({ numHabitaciones: 18, adrPromedioMxn: 3_500 });
    expect(fraccion).toBeCloseTo(TECHO_FRACCION_MAXIMA, 6);
  });

  it(`hotel con >${DESCUENTO_TAMANO_UMBRAL_HABITACIONES} habitaciones recibe el descuento de tamaño ×${DESCUENTO_TAMANO_FACTOR} (0.30*0.6=0.18, acotado al piso documentado de 20%)`, () => {
    // 0.30 * 0.6 = 0.18 < TECHO_FRACCION_PISO (0.20): el descuento de tamaño por sí solo
    // ya empuja la fracción por debajo del piso de la banda ≤20-30% de REQ-REV-019, así
    // que el resultado observable es el piso, no 0.18 -- se verifica primero que el
    // descuento SÍ redujo algo (fracción < máximo) y luego que el piso lo detuvo ahí.
    const fraccion = calcularFraccionTecho({ numHabitaciones: 120, adrPromedioMxn: 3_500 });
    expect(fraccion).toBeLessThan(TECHO_FRACCION_MAXIMA);
    expect(fraccion).toBeCloseTo(TECHO_FRACCION_PISO, 6);
  });

  it(`hotel con ADR <MXN ${DESCUENTO_ADR_UMBRAL_MXN} recibe el descuento de ADR ×${DESCUENTO_ADR_FACTOR}`, () => {
    const fraccion = calcularFraccionTecho({ numHabitaciones: 18, adrPromedioMxn: 2_000 });
    expect(fraccion).toBeCloseTo(TECHO_FRACCION_MAXIMA * DESCUENTO_ADR_FACTOR, 6); // 0.255
  });

  it("hotel exactamente en los umbrales (80 hab, ADR 2,500) NO recibe ningún descuento (umbrales estrictos)", () => {
    const fraccion = calcularFraccionTecho({
      numHabitaciones: DESCUENTO_TAMANO_UMBRAL_HABITACIONES,
      adrPromedioMxn: DESCUENTO_ADR_UMBRAL_MXN,
    });
    expect(fraccion).toBeCloseTo(TECHO_FRACCION_MAXIMA, 6);
  });

  it("hotel grande Y de ADR bajo: ambos descuentos se componen, pero la fracción nunca baja del piso de 20% (banda ≤20-30% de REQ-REV-019)", () => {
    const fraccion = calcularFraccionTecho({ numHabitaciones: 120, adrPromedioMxn: 2_000 });
    // 0.30 * 0.6 * 0.85 = 0.153 -> se acota al piso documentado de 20%.
    expect(fraccion).toBeCloseTo(TECHO_FRACCION_PISO, 6);
  });

  it("la fracción techo siempre cae dentro de la banda [20%, 30%] para cualquier combinación de descuentos", () => {
    for (const numHabitaciones of [1, 18, 45, 79, 80, 81, 120, 500]) {
      for (const adrPromedioMxn of [500, 1_999, 2_500, 2_501, 5_000, 20_000]) {
        const fraccion = calcularFraccionTecho({ numHabitaciones, adrPromedioMxn });
        expect(fraccion).toBeGreaterThanOrEqual(TECHO_FRACCION_PISO);
        expect(fraccion).toBeLessThanOrEqual(TECHO_FRACCION_MAXIMA);
      }
    }
  });

  it("calcularPrecioTechoMxn compone el valor conservador deduplicado con la fracción techo", () => {
    const precio = calcularPrecioTechoMxn(100_000, { numHabitaciones: 18, adrPromedioMxn: 3_500 });
    expect(precio).toBeCloseTo(30_000, 6); // 30% de 100,000
  });

  it("rechaza numHabitaciones o ADR no positivos", () => {
    expect(() => calcularFraccionTecho({ numHabitaciones: 0, adrPromedioMxn: 3_000 })).toThrow(PricingTechoError);
    expect(() => calcularFraccionTecho({ numHabitaciones: 18, adrPromedioMxn: -1 })).toThrow(PricingTechoError);
  });
});

describe("REQ-REV-019: evaluarPrecioVentaPropuesto (regla completa, caso positivo y negativo)", () => {
  const hotelAncla = { numHabitaciones: 45, adrPromedioMxn: 3_200 }; // A2 boutique beachfront (H17)

  it("caso positivo: un precio dentro del techo se permite y reporta las cifras usadas", () => {
    const agentes: AgenteValorConservador[] = [
      { nombre: "voz", valorConservadorMensualMxn: 20_000, grupoSolapamiento: "captura_directa" },
      { nombre: "whatsapp", valorConservadorMensualMxn: 15_000, grupoSolapamiento: "captura_directa" },
      { nombre: "back_office", valorConservadorMensualMxn: 5_000 },
    ];
    // valorConservadorDeduplicado = (20,000+15,000)*0.75 + 5,000 = 26,250 + 5,000 = 31,250
    // fraccionTecho(45 hab, ADR 3,200) = 0.30 (sin descuentos)
    // precioTecho = 31,250 * 0.30 = 9,375
    const evaluacion = evaluarPrecioVentaPropuesto(6_990, agentes, hotelAncla);
    expect(evaluacion.allowed).toBe(true);
    expect(evaluacion.reasons).toEqual([]);
    expect(evaluacion.valorConservadorDeduplicadoMxn).toBeCloseTo(31_250, 6);
    expect(evaluacion.fraccionTechoAplicada).toBeCloseTo(0.3, 6);
    expect(evaluacion.precioTechoMxn).toBeCloseTo(9_375, 6);
  });

  it("caso negativo: un precio que excede el techo (ignorando la deduplicación) se bloquea con la razón precio_excede_techo", () => {
    const agentes: AgenteValorConservador[] = [
      { nombre: "voz", valorConservadorMensualMxn: 20_000, grupoSolapamiento: "captura_directa" },
      { nombre: "whatsapp", valorConservadorMensualMxn: 15_000, grupoSolapamiento: "captura_directa" },
    ];
    // Un vendedor que sumara el valor BRUTO (35,000) sin deduplicar podría creer que un
    // precio de 10,000/mes cabe en 30% (10,500) -- pero el valor REAL deduplicado es
    // (35,000)*0.75 = 26,250, y 30% de eso son 7,875: 10,000 excede el techo real.
    const evaluacion = evaluarPrecioVentaPropuesto(10_000, agentes, hotelAncla);
    expect(evaluacion.allowed).toBe(false);
    expect(evaluacion.reasons).toHaveLength(1);
    expect(evaluacion.reasons[0]).toMatch(/^precio_excede_techo:/);
    expect(evaluacion.precioTechoMxn).toBeCloseTo(26_250 * 0.3, 6);
  });

  it("caso límite: un precio exactamente igual al techo se permite (frontera inclusiva)", () => {
    const agentes: AgenteValorConservador[] = [{ nombre: "solo_agente", valorConservadorMensualMxn: 40_000 }];
    const techo = calcularPrecioTechoMxn(40_000, hotelAncla); // 12,000
    const evaluacion = evaluarPrecioVentaPropuesto(techo, agentes, hotelAncla);
    expect(evaluacion.allowed).toBe(true);
  });

  it("BP-149: el plan 'Vende' (MXN 149/hab/mes, mínimo 4,490) cabe dentro del techo del hotel ancla A2 (45 hab) usado en H17", () => {
    // Valor conservador de suite reportado en docs/ARQUITECTURA.md para el hotel ancla
    // (H17, escenario conservador): MXN 355,000/mes.
    const valorConservadorSuiteAncla = 355_000;
    const precioListaVende = 149 * hotelAncla.numHabitaciones; // 6,705/mes, > mínimo 4,490
    const evaluacion = evaluarPrecioVentaPropuesto(
      precioListaVende,
      [{ nombre: "suite_h17_ancla", valorConservadorMensualMxn: valorConservadorSuiteAncla }],
      hotelAncla,
    );
    expect(evaluacion.allowed).toBe(true);
  });

  it("rechaza un precio propuesto negativo o no finito", () => {
    const agentes: AgenteValorConservador[] = [{ nombre: "a", valorConservadorMensualMxn: 1_000 }];
    expect(() => evaluarPrecioVentaPropuesto(-1, agentes, hotelAncla)).toThrow(PricingTechoError);
    expect(() => evaluarPrecioVentaPropuesto(Number.NaN, agentes, hotelAncla)).toThrow(PricingTechoError);
  });
});
