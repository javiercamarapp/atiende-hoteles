// REQ-HK-003 (docs/REQUISITOS.md/docs/ACEPTACION.md): "La inspección de habitaciones
// debe asistirse por visión con un set estándar de fotos, generando aprobación o
// corrección específica en <30 s, con muestreo físico de supervisión del 20-30%
// conservando la decisión final humana." Unit puro (sin BD) de
// `packages/domain-hotel/src/housekeeping/inspeccionVision.ts`: (1) set estándar de 6
// fotos completo -> aprobada, (2) cada tipo de corrección específica por separado
// (faltante, duplicada, fecha inválida, checklist sin cubrir, tipo desconocido), (3)
// determinismo del muestreo de supervisión física y que su proporción agregada cae en
// 20-30%, (4) la guarda de decisión humana nunca deja cerrar sin nota cuando la tarea
// fue muestreada. El flujo end-to-end contra Postgres real (endpoint HTTP, <30 s medido
// de verdad, 0 cierres automáticos) vive en
// `tests/integration/housekeeping/inspeccion-vision.spec.ts`.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InspeccionVisionError,
  PHYSICAL_SUPERVISION_SAMPLE_RATE,
  PhysicalSupervisionNoteRequiredError,
  STANDARD_INSPECTION_PHOTO_TYPES,
  assertHumanClosureAllowed,
  evaluateVisionInspection,
  requiresPhysicalSupervision,
  type InspectionPhotoSubmission,
} from "@atiende-hoteles/domain-hotel";

const INICIO = "2026-09-10T08:00:00.000Z";
const AHORA = "2026-09-10T09:00:00.000Z";

function fotoCompleta(overrides: Partial<Record<(typeof STANDARD_INSPECTION_PHOTO_TYPES)[number], Partial<InspectionPhotoSubmission>>> = {}) {
  return STANDARD_INSPECTION_PHOTO_TYPES.map((tipo) => ({
    tipo,
    url: `https://evidencia.local/${tipo}-${randomUUID()}.jpg`,
    tomadaEn: "2026-09-10T08:30:00.000Z",
    ...(overrides[tipo] ?? {}),
  }));
}

describe("evaluateVisionInspection (REQ-HK-003)", () => {
  it("set estándar completo, fechas válidas, checklist cubierto -> aprobada sin ítems", () => {
    const resultado = evaluateVisionInspection({
      fotos: fotoCompleta(),
      checklist: ["cambiar toallas"],
      checklistCubierto: ["cambiar toallas"],
      limpiezaIniciadaEn: INICIO,
      ahora: AHORA,
    });
    expect(resultado.veredicto).toBe("aprobada");
    expect(resultado.items).toEqual([]);
    expect(resultado.checklistPendiente).toEqual([]);
  });

  it("falta una foto del set estándar -> corrección específica nombrando el tipo faltante", () => {
    const fotos = fotoCompleta().filter((f) => f.tipo !== "bano");
    const resultado = evaluateVisionInspection({
      fotos,
      checklist: [],
      checklistCubierto: [],
      limpiezaIniciadaEn: INICIO,
      ahora: AHORA,
    });
    expect(resultado.veredicto).toBe("correccion");
    expect(resultado.items).toContainEqual({ tipo: "bano", motivo: expect.stringContaining("falta esta foto") });
  });

  it("tipo de foto no reconocido se reporta como corrección, no se descarta en silencio", () => {
    const fotos = [...fotoCompleta(), { tipo: "pasillo", url: "https://evidencia.local/pasillo.jpg", tomadaEn: "2026-09-10T08:30:00.000Z" }];
    const resultado = evaluateVisionInspection({ fotos, checklist: [], checklistCubierto: [], limpiezaIniciadaEn: INICIO, ahora: AHORA });
    expect(resultado.veredicto).toBe("correccion");
    expect(resultado.items).toContainEqual({ tipo: "pasillo", motivo: expect.stringContaining("no reconocido") });
  });

  it("dos fotos del set comparten la misma url -> corrección (evidencia reciclada)", () => {
    const base = fotoCompleta();
    const fotos = base.map((f, i) => (i === 1 ? { ...f, url: base[0]!.url } : f));
    const resultado = evaluateVisionInspection({ fotos, checklist: [], checklistCubierto: [], limpiezaIniciadaEn: INICIO, ahora: AHORA });
    expect(resultado.veredicto).toBe("correccion");
    expect(resultado.items.some((it) => it.motivo.includes("misma imagen ya usada"))).toBe(true);
  });

  it("foto fechada antes del inicio de la limpieza -> corrección (evidencia de otra limpieza)", () => {
    const fotos = fotoCompleta({ cama: { tomadaEn: "2026-09-10T07:00:00.000Z" } });
    const resultado = evaluateVisionInspection({ fotos, checklist: [], checklistCubierto: [], limpiezaIniciadaEn: INICIO, ahora: AHORA });
    expect(resultado.veredicto).toBe("correccion");
    expect(resultado.items).toContainEqual({ tipo: "cama", motivo: expect.stringContaining("anterior al inicio") });
  });

  it("foto con fecha futura -> corrección", () => {
    const fotos = fotoCompleta({ ventanas_balcon: { tomadaEn: "2026-09-10T10:00:00.000Z" } });
    const resultado = evaluateVisionInspection({ fotos, checklist: [], checklistCubierto: [], limpiezaIniciadaEn: INICIO, ahora: AHORA });
    expect(resultado.veredicto).toBe("correccion");
    expect(resultado.items).toContainEqual({ tipo: "ventanas_balcon", motivo: expect.stringContaining("fecha futura") });
  });

  it("checklist propio del hotel sin cubrir -> corrección específica nombrando el pendiente", () => {
    const resultado = evaluateVisionInspection({
      fotos: fotoCompleta(),
      checklist: ["reponer amenities", "revisar minibar"],
      checklistCubierto: ["reponer amenities"],
      limpiezaIniciadaEn: INICIO,
      ahora: AHORA,
    });
    expect(resultado.veredicto).toBe("correccion");
    expect(resultado.checklistPendiente).toEqual(["revisar minibar"]);
    expect(resultado.items.some((it) => it.motivo.includes('"revisar minibar"'))).toBe(true);
  });

  it("checklist cubierto se compara sin distinguir acentos/mayúsculas", () => {
    const resultado = evaluateVisionInspection({
      fotos: fotoCompleta(),
      checklist: ["Cambiar Toallas"],
      checklistCubierto: ["cambiar toallas"],
      limpiezaIniciadaEn: INICIO,
      ahora: AHORA,
    });
    expect(resultado.veredicto).toBe("aprobada");
  });

  it("rechaza fechas ISO inválidas en vez de producir NaN silencioso", () => {
    expect(() =>
      evaluateVisionInspection({
        fotos: fotoCompleta(),
        checklist: [],
        checklistCubierto: [],
        limpiezaIniciadaEn: "no-es-fecha",
        ahora: AHORA,
      }),
    ).toThrow(InspeccionVisionError);
  });

  it("rechaza ahora anterior a limpiezaIniciadaEn (ventana inconsistente)", () => {
    expect(() =>
      evaluateVisionInspection({
        fotos: fotoCompleta(),
        checklist: [],
        checklistCubierto: [],
        limpiezaIniciadaEn: AHORA,
        ahora: INICIO,
      }),
    ).toThrow(InspeccionVisionError);
  });
});

describe("requiresPhysicalSupervision (BP-101: muestreo físico 20-30%)", () => {
  it("es determinístico: el mismo taskId siempre da la misma decisión", () => {
    const taskId = randomUUID();
    const primera = requiresPhysicalSupervision(taskId);
    for (let i = 0; i < 20; i++) {
      expect(requiresPhysicalSupervision(taskId)).toBe(primera);
    }
  });

  it("la proporción muestreada sobre una población grande cae en el rango 20-30% exigido", () => {
    const N = 20_000;
    let seleccionadas = 0;
    for (let i = 0; i < N; i++) {
      if (requiresPhysicalSupervision(randomUUID())) seleccionadas++;
    }
    const proporcion = seleccionadas / N;
    expect(proporcion).toBeGreaterThanOrEqual(0.2);
    expect(proporcion).toBeLessThanOrEqual(0.3);
    // La tasa objetivo declarada debe además caer dentro del mismo rango 20-30%.
    expect(PHYSICAL_SUPERVISION_SAMPLE_RATE).toBeGreaterThanOrEqual(0.2);
    expect(PHYSICAL_SUPERVISION_SAMPLE_RATE).toBeLessThanOrEqual(0.3);
  });
});

describe("assertHumanClosureAllowed (decisión final siempre humana)", () => {
  it("tarea NO muestreada: cualquier decisión humana basta, incluso sin nota", () => {
    expect(() => assertHumanClosureAllowed({ requiresPhysicalSupervision: false, nota: null })).not.toThrow();
    expect(() => assertHumanClosureAllowed({ requiresPhysicalSupervision: false, nota: undefined })).not.toThrow();
  });

  it("tarea muestreada SIN nota -> rechazada (0 cierres automáticos sin registro de supervisor)", () => {
    expect(() => assertHumanClosureAllowed({ requiresPhysicalSupervision: true, nota: null })).toThrow(PhysicalSupervisionNoteRequiredError);
    expect(() => assertHumanClosureAllowed({ requiresPhysicalSupervision: true, nota: "   " })).toThrow(PhysicalSupervisionNoteRequiredError);
  });

  it("tarea muestreada CON nota real -> permitida", () => {
    expect(() =>
      assertHumanClosureAllowed({ requiresPhysicalSupervision: true, nota: "Revisé la 204 en persona, confirmo limpieza." }),
    ).not.toThrow();
  });
});
