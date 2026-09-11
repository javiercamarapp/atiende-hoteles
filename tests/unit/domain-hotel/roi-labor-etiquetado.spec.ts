// REQ-HK-022 (P1/GOB, BP-076): espejo puro (sin DB) de
// `packages/domain-hotel/src/roi/roiLaborEtiquetado.ts` -- el ahorro de labor de
// housekeeping/mantenimiento reportado como ROI solo se marca "verificado" si hay
// evidencia registrada de que la plantilla se variabilizó (eventuales, descansos
// móviles); de lo contrario el reporte debe etiquetarlo explícitamente como "no
// verificado". El criterio de aceptación (`docs/ACEPTACION.md` REQ-HK-022) exige
// verificar "revisando el TEXTO del reporte generado en ambos escenarios" -- por eso
// cada caso central inspecciona `etiquetaTexto`, no solo el booleano `verificado`.
import { describe, expect, it } from "vitest";
import {
  buildReporteAhorroLaborHousekeeping,
  evaluarVariabilizacionPlantilla,
  type PlantillaVariabilizacionEvidence,
} from "@atiende-hoteles/domain-hotel";

const PERIODO = { desde: "2026-08-01", hasta: "2026-08-31" };

describe("buildReporteAhorroLaborHousekeeping", () => {
  it("caso central 1 (escenario NO verificado): plantilla fija (0 eventuales, 0 descansos móviles) -> el reporte etiqueta el ahorro EXPLÍCITAMENTE como 'no verificado' en el texto", () => {
    const evidencia: PlantillaVariabilizacionEvidence = {
      eventualesRegistrados: 0,
      descansosMovilesRegistrados: 0,
    };

    const reporte = buildReporteAhorroLaborHousekeeping({
      hotelId: "hotel-1",
      periodo: PERIODO,
      ahorroReportadoUsd: 4200,
      evidenciaVariabilizacion: evidencia,
    });

    expect(reporte.verificado).toBe(false);
    // La regla no es un booleano oculto: el TEXTO debe decir explícitamente "no
    // verificado" -- literal, insensible a mayúsculas.
    expect(reporte.etiquetaTexto.toLowerCase()).toContain("no verificado");
    expect(reporte.etiquetaTexto).toContain("$4200.00 USD");
    expect(reporte.etiquetaTexto).toContain("NO se variabilizó");
    expect(reporte.etiquetaTexto).toContain("NO VERIFICADO");
  });

  it("caso central 2 (escenario verificado): plantilla variabilizada con eventuales Y descansos móviles -> el reporte etiqueta el ahorro como verificado en el texto", () => {
    const evidencia: PlantillaVariabilizacionEvidence = {
      eventualesRegistrados: 3,
      descansosMovilesRegistrados: 5,
    };

    const reporte = buildReporteAhorroLaborHousekeeping({
      hotelId: "hotel-1",
      periodo: PERIODO,
      ahorroReportadoUsd: 4200,
      evidenciaVariabilizacion: evidencia,
    });

    expect(reporte.verificado).toBe(true);
    expect(reporte.etiquetaTexto).toContain("VERIFICADO");
    expect(reporte.etiquetaTexto).not.toContain("no verificado");
    expect(reporte.etiquetaTexto).not.toContain("NO VERIFICADO");
    expect(reporte.etiquetaTexto).toContain("3 eventual(es)");
    expect(reporte.etiquetaTexto).toContain("5 descanso(s) móvil(es)");
  });

  it("solo eventuales registrados (sin descansos móviles) ya basta para considerar la plantilla variabilizada", () => {
    const reporte = buildReporteAhorroLaborHousekeeping({
      hotelId: "hotel-1",
      periodo: PERIODO,
      ahorroReportadoUsd: 1000,
      evidenciaVariabilizacion: { eventualesRegistrados: 1, descansosMovilesRegistrados: 0 },
    });

    expect(reporte.verificado).toBe(true);
    expect(reporte.etiquetaTexto).toContain("VERIFICADO");
  });

  it("solo descansos móviles registrados (sin eventuales) ya basta para considerar la plantilla variabilizada", () => {
    const reporte = buildReporteAhorroLaborHousekeeping({
      hotelId: "hotel-1",
      periodo: PERIODO,
      ahorroReportadoUsd: 1000,
      evidenciaVariabilizacion: { eventualesRegistrados: 0, descansosMovilesRegistrados: 2 },
    });

    expect(reporte.verificado).toBe(true);
    expect(reporte.etiquetaTexto).toContain("VERIFICADO");
  });

  it("ahorro reportado en $0 sin variabilización también se etiqueta explícitamente como no verificado (no se omite la fila)", () => {
    const reporte = buildReporteAhorroLaborHousekeeping({
      hotelId: "hotel-1",
      periodo: PERIODO,
      ahorroReportadoUsd: 0,
      evidenciaVariabilizacion: { eventualesRegistrados: 0, descansosMovilesRegistrados: 0 },
    });

    expect(reporte.verificado).toBe(false);
    expect(reporte.etiquetaTexto.toLowerCase()).toContain("no verificado");
    expect(reporte.etiquetaTexto).toContain("$0.00 USD");
  });

  it("propaga hotelId, periodo, ahorroReportadoUsd y la evidencia de entrada en el resultado, para trazabilidad", () => {
    const evidencia: PlantillaVariabilizacionEvidence = { eventualesRegistrados: 2, descansosMovilesRegistrados: 0 };
    const reporte = buildReporteAhorroLaborHousekeeping({
      hotelId: "hotel-42",
      periodo: PERIODO,
      ahorroReportadoUsd: 999.5,
      evidenciaVariabilizacion: evidencia,
    });

    expect(reporte.hotelId).toBe("hotel-42");
    expect(reporte.periodo).toEqual(PERIODO);
    expect(reporte.ahorroReportadoUsd).toBe(999.5);
    expect(reporte.evidenciaVariabilizacion).toEqual(evidencia);
  });

  it("rechaza un ahorro reportado negativo en vez de fabricar una etiqueta sobre un monto sin sentido", () => {
    expect(() =>
      buildReporteAhorroLaborHousekeeping({
        hotelId: "hotel-1",
        periodo: PERIODO,
        ahorroReportadoUsd: -1,
        evidenciaVariabilizacion: { eventualesRegistrados: 0, descansosMovilesRegistrados: 0 },
      }),
    ).toThrow(/ahorro_invalido/);
  });

  it("rechaza un ahorro reportado no finito (NaN/Infinity)", () => {
    expect(() =>
      buildReporteAhorroLaborHousekeeping({
        hotelId: "hotel-1",
        periodo: PERIODO,
        ahorroReportadoUsd: Number.POSITIVE_INFINITY,
        evidenciaVariabilizacion: { eventualesRegistrados: 0, descansosMovilesRegistrados: 0 },
      }),
    ).toThrow(/ahorro_invalido/);
  });

  it("rechaza conteos de evidencia negativos en vez de tratarlos como cero silenciosamente", () => {
    expect(() =>
      buildReporteAhorroLaborHousekeeping({
        hotelId: "hotel-1",
        periodo: PERIODO,
        ahorroReportadoUsd: 100,
        evidenciaVariabilizacion: { eventualesRegistrados: -1, descansosMovilesRegistrados: 0 },
      }),
    ).toThrow(/evidencia_invalida/);

    expect(() =>
      buildReporteAhorroLaborHousekeeping({
        hotelId: "hotel-1",
        periodo: PERIODO,
        ahorroReportadoUsd: 100,
        evidenciaVariabilizacion: { eventualesRegistrados: 0, descansosMovilesRegistrados: -1 },
      }),
    ).toThrow(/evidencia_invalida/);
  });
});

describe("evaluarVariabilizacionPlantilla", () => {
  it("false cuando ambos conteos son 0 (plantilla fija)", () => {
    expect(evaluarVariabilizacionPlantilla({ eventualesRegistrados: 0, descansosMovilesRegistrados: 0 })).toBe(false);
  });

  it("true cuando al menos uno de los dos conteos es > 0", () => {
    expect(evaluarVariabilizacionPlantilla({ eventualesRegistrados: 1, descansosMovilesRegistrados: 0 })).toBe(true);
    expect(evaluarVariabilizacionPlantilla({ eventualesRegistrados: 0, descansosMovilesRegistrados: 1 })).toBe(true);
    expect(evaluarVariabilizacionPlantilla({ eventualesRegistrados: 4, descansosMovilesRegistrados: 4 })).toBe(true);
  });

  it("rechaza conteos no finitos", () => {
    expect(() =>
      evaluarVariabilizacionPlantilla({ eventualesRegistrados: Number.NaN, descansosMovilesRegistrados: 0 }),
    ).toThrow(/evidencia_invalida/);
  });
});
