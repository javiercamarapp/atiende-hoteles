// REQ-HK-007 (P2/F): cálculo diario de kg de lavandería esperados para el día siguiente y
// PAR efectivo de blancos limpios, alertando si el PAR cae bajo 1.2x la necesidad
// proyectada o si la lavandería externa retrasa la entrega. Cruce puro (sin Postgres),
// mismo criterio que tests/unit/domain-hotel/turnos-lft.spec.ts (REQ-HK-008).
import { describe, expect, it } from "vitest";
import {
  calcularLavanderiaDiaria,
  computeExpectedLaundryKg,
  evaluateLinenPar,
  type LinenKgConfig,
  type RoomTurnoverForecast,
} from "@atiende-hoteles/domain-hotel";

const KG_CONFIG: LinenKgConfig = {
  kgPerCheckoutRoom: 6,
  kgPerStayoverPartialRoom: 2,
  stayoverFullChangeRate: 0.25,
};

describe("computeExpectedLaundryKg: kg de lavandería esperados para el día siguiente", () => {
  it("solo checkouts: kg = checkoutRooms x kgPerCheckoutRoom", () => {
    const forecast: RoomTurnoverForecast = { checkoutRooms: 10, stayoverRooms: 0 };
    expect(computeExpectedLaundryKg(forecast, KG_CONFIG)).toBe(60);
  });

  it("solo stayovers: mezcla cambio completo (tasa de opt-out) y parcial", () => {
    const forecast: RoomTurnoverForecast = { checkoutRooms: 0, stayoverRooms: 20 };
    // 20 stayovers x 25% cambio completo = 5 habitaciones a 6kg = 30kg
    // 20 stayovers x 75% cambio parcial = 15 habitaciones a 2kg = 30kg
    expect(computeExpectedLaundryKg(forecast, KG_CONFIG)).toBe(60);
  });

  it("checkouts + stayovers combinados", () => {
    const forecast: RoomTurnoverForecast = { checkoutRooms: 30, stayoverRooms: 40 };
    // checkouts: 30 x 6 = 180
    // stayovers full (10 hab x 6) = 60; stayovers parcial (30 hab x 2) = 60
    expect(computeExpectedLaundryKg(forecast, KG_CONFIG)).toBe(300);
  });

  it("sin rotación (todas las habitaciones OOO o vacías): 0kg", () => {
    const forecast: RoomTurnoverForecast = { checkoutRooms: 0, stayoverRooms: 0 };
    expect(computeExpectedLaundryKg(forecast, KG_CONFIG)).toBe(0);
  });

  it("rechaza tasa de cambio completo fuera de [0,1]", () => {
    const badConfig: LinenKgConfig = { ...KG_CONFIG, stayoverFullChangeRate: 1.5 };
    expect(() => computeExpectedLaundryKg({ checkoutRooms: 1, stayoverRooms: 1 }, badConfig)).toThrow(RangeError);
  });

  it("rechaza conteo de habitaciones negativo o no entero", () => {
    expect(() => computeExpectedLaundryKg({ checkoutRooms: -1, stayoverRooms: 0 }, KG_CONFIG)).toThrow(RangeError);
    expect(() => computeExpectedLaundryKg({ checkoutRooms: 1.5, stayoverRooms: 0 }, KG_CONFIG)).toThrow(RangeError);
  });
});

describe("evaluateLinenPar: alerta cuando el PAR cae bajo 1.2x la necesidad proyectada", () => {
  it("dataset JUSTO ENCIMA del umbral (1.2x + un poco): sin alerta de PAR bajo", () => {
    const result = evaluateLinenPar({ necesidadProyectadaKg: 100, parEfectivoKg: 120.01 });
    expect(result.umbralMinimoKg).toBe(120);
    expect(result.parBajoUmbral).toBe(false);
    expect(result.alerta).toBe(false);
    expect(result.motivos).toEqual([]);
  });

  it("dataset EXACTAMENTE en el umbral (1.2x): no alerta -- 'cae bajo' es estrictamente menor", () => {
    const result = evaluateLinenPar({ necesidadProyectadaKg: 100, parEfectivoKg: 120 });
    expect(result.parBajoUmbral).toBe(false);
    expect(result.alerta).toBe(false);
  });

  it("dataset JUSTO DEBAJO del umbral (1.2x - un poco): alerta de PAR bajo", () => {
    const result = evaluateLinenPar({ necesidadProyectadaKg: 100, parEfectivoKg: 119.99 });
    expect(result.parBajoUmbral).toBe(true);
    expect(result.alerta).toBe(true);
    expect(result.motivos).toEqual(["par_bajo_umbral"]);
  });

  it("respeta un umbralParMinimo distinto al default cuando se pasa explícito", () => {
    const result = evaluateLinenPar({ necesidadProyectadaKg: 100, parEfectivoKg: 130, umbralParMinimo: 1.5 });
    expect(result.umbralMinimoKg).toBe(150);
    expect(result.parBajoUmbral).toBe(true);
  });

  it("entrega externa AÚN NO recibida y YA pasó la fecha prometida: alerta por retraso", () => {
    const result = evaluateLinenPar({
      necesidadProyectadaKg: 100,
      parEfectivoKg: 200, // PAR de sobra -- el único motivo debe ser el retraso
      entregaExterna: {
        fechaPrometida: "2026-09-09T18:00:00.000Z",
        fechaRecibida: null,
        ahora: "2026-09-10T07:00:00.000Z",
      },
    });
    expect(result.entregaRetrasada).toBe(true);
    expect(result.alerta).toBe(true);
    expect(result.motivos).toEqual(["entrega_lavanderia_retrasada"]);
  });

  it("entrega externa recibida ANTES de la fecha prometida: sin alerta de retraso", () => {
    const result = evaluateLinenPar({
      necesidadProyectadaKg: 100,
      parEfectivoKg: 200,
      entregaExterna: {
        fechaPrometida: "2026-09-10T18:00:00.000Z",
        fechaRecibida: "2026-09-10T16:00:00.000Z",
        ahora: "2026-09-10T20:00:00.000Z",
      },
    });
    expect(result.entregaRetrasada).toBe(false);
    expect(result.alerta).toBe(false);
  });

  it("entrega externa recibida DESPUÉS de la fecha prometida (llegó tarde pero ya llegó): no bloquea 'ahora'", () => {
    const result = evaluateLinenPar({
      necesidadProyectadaKg: 100,
      parEfectivoKg: 200,
      entregaExterna: {
        fechaPrometida: "2026-09-09T18:00:00.000Z",
        fechaRecibida: "2026-09-10T02:00:00.000Z", // llegó tarde, pero YA llegó
        ahora: "2026-09-10T07:00:00.000Z",
      },
    });
    expect(result.entregaRetrasada).toBe(false);
    expect(result.alerta).toBe(false);
  });

  it("ambos motivos a la vez: PAR bajo Y entrega retrasada -- se reportan los dos", () => {
    const result = evaluateLinenPar({
      necesidadProyectadaKg: 100,
      parEfectivoKg: 50,
      entregaExterna: {
        fechaPrometida: "2026-09-09T18:00:00.000Z",
        fechaRecibida: null,
        ahora: "2026-09-10T07:00:00.000Z",
      },
    });
    expect(result.alerta).toBe(true);
    expect(result.motivos).toEqual(["par_bajo_umbral", "entrega_lavanderia_retrasada"]);
  });

  it("sin lavandería externa configurada (hotel lava en sitio): nunca marca retraso", () => {
    const result = evaluateLinenPar({ necesidadProyectadaKg: 100, parEfectivoKg: 50 });
    expect(result.entregaRetrasada).toBe(false);
    expect(result.motivos).toEqual(["par_bajo_umbral"]);
  });

  it("rechaza fechas ISO inválidas en la entrega externa", () => {
    expect(() =>
      evaluateLinenPar({
        necesidadProyectadaKg: 100,
        parEfectivoKg: 100,
        entregaExterna: { fechaPrometida: "no-es-fecha", fechaRecibida: null, ahora: "2026-09-10T07:00:00.000Z" },
      }),
    ).toThrow(RangeError);
  });

  it("rechaza necesidad o PAR negativos", () => {
    expect(() => evaluateLinenPar({ necesidadProyectadaKg: -1, parEfectivoKg: 10 })).toThrow(RangeError);
    expect(() => evaluateLinenPar({ necesidadProyectadaKg: 10, parEfectivoKg: -1 })).toThrow(RangeError);
  });

  it("rechaza umbralParMinimo <= 0", () => {
    expect(() => evaluateLinenPar({ necesidadProyectadaKg: 10, parEfectivoKg: 10, umbralParMinimo: 0 })).toThrow(
      RangeError,
    );
  });
});

describe("calcularLavanderiaDiaria: punto de entrada único del cálculo diario", () => {
  it("junta kg esperados + evaluación de PAR en una sola llamada, dataset justo debajo del umbral", () => {
    const forecast: RoomTurnoverForecast = { checkoutRooms: 10, stayoverRooms: 0 }; // 60kg esperados
    const result = calcularLavanderiaDiaria({
      forecast,
      kgConfig: KG_CONFIG,
      parEfectivoKg: 71.99, // umbral = 60 x 1.2 = 72
    });
    expect(result.kgLavanderiaEsperadosManana).toBe(60);
    expect(result.umbralMinimoKg).toBe(72);
    expect(result.parBajoUmbral).toBe(true);
    expect(result.alerta).toBe(true);
  });

  it("junta kg esperados + evaluación de PAR en una sola llamada, dataset justo encima del umbral", () => {
    const forecast: RoomTurnoverForecast = { checkoutRooms: 10, stayoverRooms: 0 }; // 60kg esperados
    const result = calcularLavanderiaDiaria({
      forecast,
      kgConfig: KG_CONFIG,
      parEfectivoKg: 72.01,
    });
    expect(result.kgLavanderiaEsperadosManana).toBe(60);
    expect(result.parBajoUmbral).toBe(false);
    expect(result.alerta).toBe(false);
  });
});
