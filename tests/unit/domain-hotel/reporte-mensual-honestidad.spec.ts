// REQ-OBS-007 (P0/BP-171/H17-001): espejo puro (sin DB) de
// `packages/domain-hotel/src/pl/reporteMensualDueno.ts` -- verifica la regla de
// honestidad exacta del blueprint: "recuperado/verificado" y "estimado" SIEMPRE
// separados (nunca sumados en una sola cifra), y una declaración EN TEXTO (no solo un
// booleano interno) cuando lo verificado no alcanza la cuota de cobro del periodo. El
// caso central del criterio de aceptación (`docs/ACEPTACION.md` REQ-OBS-007) es el de
// "lo verificado < cuota → el reporte lo declara en texto, no lo oculta".
import { describe, expect, it } from "vitest";
import { buildReporteMensualDueno, type RoiEventoMensual } from "@atiende-hoteles/domain-hotel";

const PERIODO = { desde: "2026-08-01", hasta: "2026-08-31" };

describe("buildReporteMensualDueno", () => {
  it("caso central del criterio de aceptación: verificado < cuota -> el reporte lo declara EN TEXTO, no lo oculta", () => {
    const eventos: RoiEventoMensual[] = [
      { agente: "recepcion_virtual", tipoEvento: "upsell", montoEstimadoUsd: 500, montoVerificadoUsd: 120 },
      { agente: "revenue_engine", tipoEvento: "tarifa_optimizada", montoEstimadoUsd: 300, montoVerificadoUsd: null },
    ];

    const reporte = buildReporteMensualDueno({
      hotelId: "hotel-1",
      periodo: PERIODO,
      eventos,
      cuotaCobroUsd: 500,
    });

    // Los dos totales existen SEPARADOS -- nunca una sola cifra fusionada.
    expect(reporte.totalRecuperadoVerificadoUsd).toBe(120);
    expect(reporte.totalEstimadoUsd).toBe(300); // solo el evento SIN verificar
    expect(reporte.cuotaCobroUsd).toBe(500);
    expect(reporte.brechaVerificadoVsCuotaUsd).toBe(120 - 500);

    // La regla de honestidad: verificado (120) < cuota (500) -> NO se cubre.
    expect(reporte.verificadoCubreCuota).toBe(false);

    // Y lo declara explícitamente EN TEXTO -- no un booleano que la UI podría no
    // mostrar. El texto no oculta la brecha ni la disfraza con el estimado.
    expect(reporte.declaracionHonestidad).toContain("MENOR");
    expect(reporte.declaracionHonestidad).toContain("$120.00 USD");
    expect(reporte.declaracionHonestidad).toContain("$500.00 USD");
    expect(reporte.declaracionHonestidad).toContain("$380.00 USD"); // brecha sin cubrir
    // El estimado se menciona, pero NUNCA como si cubriera la cuota.
    expect(reporte.declaracionHonestidad).toContain("$300.00 USD");
    expect(reporte.declaracionHonestidad).toContain("NO se cuentan para cubrir esta cuota");
  });

  it("verificado >= cuota: declara honestamente que SÍ cubre, sin lenguaje de alerta", () => {
    const eventos: RoiEventoMensual[] = [
      { agente: "recepcion_virtual", tipoEvento: "upsell", montoEstimadoUsd: 100, montoVerificadoUsd: 800 },
    ];

    const reporte = buildReporteMensualDueno({
      hotelId: "hotel-1",
      periodo: PERIODO,
      eventos,
      cuotaCobroUsd: 500,
    });

    expect(reporte.totalRecuperadoVerificadoUsd).toBe(800);
    expect(reporte.verificadoCubreCuota).toBe(true);
    expect(reporte.declaracionHonestidad).toContain("Cubre la cuota de cobro");
    expect(reporte.declaracionHonestidad).not.toContain("MENOR");
    expect(reporte.declaracionHonestidad).not.toContain("Aviso de honestidad");
  });

  it("verificado exactamente igual a la cuota cuenta como que SÍ la cubre (brecha 0, no negativa)", () => {
    const reporte = buildReporteMensualDueno({
      hotelId: "hotel-1",
      periodo: PERIODO,
      eventos: [{ agente: "auditor_nocturno", tipoEvento: "ahorro_gasto", montoEstimadoUsd: null, montoVerificadoUsd: 500 }],
      cuotaCobroUsd: 500,
    });

    expect(reporte.brechaVerificadoVsCuotaUsd).toBe(0);
    expect(reporte.verificadoCubreCuota).toBe(true);
  });

  it("sin ningún evento de ROI en el periodo pero con cuota > 0: no fabrica cobertura, declara la brecha completa", () => {
    const reporte = buildReporteMensualDueno({
      hotelId: "hotel-1",
      periodo: PERIODO,
      eventos: [],
      cuotaCobroUsd: 300,
    });

    expect(reporte.eventosSinDatos).toBe(true);
    expect(reporte.totalRecuperadoVerificadoUsd).toBe(0);
    expect(reporte.totalEstimadoUsd).toBe(0);
    expect(reporte.verificadoCubreCuota).toBe(false);
    expect(reporte.declaracionHonestidad).toContain("$0.00 USD");
    expect(reporte.declaracionHonestidad).toContain("$300.00 USD");
    // Sin eventos estimados que mencionar -- no se inventa una frase sobre estimado.
    expect(reporte.declaracionHonestidad).not.toContain("ESTIMADOS");
  });

  it("un evento ya verificado no duplica su monto como estimado, aunque también traiga montoEstimadoUsd", () => {
    const reporte = buildReporteMensualDueno({
      hotelId: "hotel-1",
      periodo: PERIODO,
      eventos: [
        { agente: "revenue_engine", tipoEvento: "tarifa_optimizada", montoEstimadoUsd: 900, montoVerificadoUsd: 900 },
      ],
      cuotaCobroUsd: 100,
    });

    expect(reporte.totalRecuperadoVerificadoUsd).toBe(900);
    // El estimado del MISMO evento ya verificado no se vuelve a sumar aparte.
    expect(reporte.totalEstimadoUsd).toBe(0);
  });

  it("varios eventos mezclados: suma correctamente cada total sin mezclarlos entre sí", () => {
    const eventos: RoiEventoMensual[] = [
      { agente: "a", tipoEvento: "x", montoEstimadoUsd: null, montoVerificadoUsd: 100 },
      { agente: "b", tipoEvento: "y", montoEstimadoUsd: null, montoVerificadoUsd: 50 },
      { agente: "c", tipoEvento: "z", montoEstimadoUsd: 40, montoVerificadoUsd: null },
      { agente: "d", tipoEvento: "w", montoEstimadoUsd: 60, montoVerificadoUsd: null },
    ];

    const reporte = buildReporteMensualDueno({
      hotelId: "hotel-1",
      periodo: PERIODO,
      eventos,
      cuotaCobroUsd: 100,
    });

    expect(reporte.totalRecuperadoVerificadoUsd).toBe(150);
    expect(reporte.totalEstimadoUsd).toBe(100);
    expect(reporte.verificadoCubreCuota).toBe(true);
  });

  it("rechaza una cuota de cobro negativa en vez de reportar una brecha sin sentido", () => {
    expect(() =>
      buildReporteMensualDueno({
        hotelId: "hotel-1",
        periodo: PERIODO,
        eventos: [],
        cuotaCobroUsd: -1,
      }),
    ).toThrow(/cuota_invalida/);
  });

  it("rechaza una cuota de cobro no finita (NaN/Infinity)", () => {
    expect(() =>
      buildReporteMensualDueno({
        hotelId: "hotel-1",
        periodo: PERIODO,
        eventos: [],
        cuotaCobroUsd: Number.NaN,
      }),
    ).toThrow(/cuota_invalida/);
  });

  it("cuota de cobro en 0 siempre se cubre (no hay honestidad que declarar como incumplida)", () => {
    const reporte = buildReporteMensualDueno({
      hotelId: "hotel-1",
      periodo: PERIODO,
      eventos: [],
      cuotaCobroUsd: 0,
    });

    expect(reporte.verificadoCubreCuota).toBe(true);
    expect(reporte.declaracionHonestidad).toContain("Cubre la cuota de cobro");
  });

  it("propaga hotelId y periodo de entrada en el resultado, para trazabilidad", () => {
    const reporte = buildReporteMensualDueno({
      hotelId: "hotel-42",
      periodo: PERIODO,
      eventos: [],
      cuotaCobroUsd: 0,
    });

    expect(reporte.hotelId).toBe("hotel-42");
    expect(reporte.periodo).toEqual(PERIODO);
  });
});
