// REQ-AB-011 (docs/REQUISITOS.md/docs/ACEPTACION.md): "bitácoras digitales
// automatizadas de temperatura/recepción/limpieza conforme a NOM-251, disponibles
// para auditoría COFEPRIS (verificado: exportación con campos exigidos por la
// norma)." Unit puro (sin BD) de `packages/domain-hotel/src/bitacorasNom251.ts`:
// (1) evaluación de rango de temperatura, (2) validación de payload por tipo
// (incluido el caso negativo: recepción rechazada sin motivo, o aceptada con
// motivo), (3) detección de anomalía, (4) el criterio de aceptación literal --
// exportación CSV con los campos exigidos. El escenario end-to-end contra Postgres
// real (captura inalterable vía HTTP, hash encadenado, export) vive en
// tests/integration/ab/bitacoras-nom251.spec.ts.
import { describe, expect, it } from "vitest";
import {
  BITACORA_NOM251_CSV_HEADERS,
  bitacoraNom251EntradaSchema,
  buildBitacoraNom251Csv,
  detectarAnomaliaBitacora,
  evaluarLecturaTemperatura,
  recepcionPayloadSchema,
  type BitacoraNom251EntradaConMeta,
} from "@atiende-hoteles/domain-hotel";

describe("evaluarLecturaTemperatura (REQ-AB-011)", () => {
  it("refrigeración: dentro de [0,4] está en rango; fuera no", () => {
    expect(evaluarLecturaTemperatura("refrigeracion", 2).dentroDeRango).toBe(true);
    expect(evaluarLecturaTemperatura("refrigeracion", 0).dentroDeRango).toBe(true);
    expect(evaluarLecturaTemperatura("refrigeracion", 4).dentroDeRango).toBe(true);
    expect(evaluarLecturaTemperatura("refrigeracion", 8).dentroDeRango).toBe(false);
    expect(evaluarLecturaTemperatura("refrigeracion", -1).dentroDeRango).toBe(false);
  });

  it("congelación: <= -18 está en rango; más caliente no", () => {
    expect(evaluarLecturaTemperatura("congelacion", -20).dentroDeRango).toBe(true);
    expect(evaluarLecturaTemperatura("congelacion", -18).dentroDeRango).toBe(true);
    expect(evaluarLecturaTemperatura("congelacion", -10).dentroDeRango).toBe(false);
  });

  it("mantenimiento en caliente: >= 60 está en rango; más frío no", () => {
    expect(evaluarLecturaTemperatura("caliente", 65).dentroDeRango).toBe(true);
    expect(evaluarLecturaTemperatura("caliente", 60).dentroDeRango).toBe(true);
    expect(evaluarLecturaTemperatura("caliente", 45).dentroDeRango).toBe(false);
  });
});

describe("bitacoraNom251EntradaSchema: validación por tipo, caso negativo incluido", () => {
  it("acepta una entrada de temperatura válida", () => {
    const result = bitacoraNom251EntradaSchema.safeParse({
      tipo: "temperatura",
      payload: { equipo: "Refrigerador cocina 1", tipoEquipo: "refrigeracion", temperaturaC: 3 },
    });
    expect(result.success).toBe(true);
  });

  it("rechaza una entrada de temperatura con tipoEquipo inválido", () => {
    const result = bitacoraNom251EntradaSchema.safeParse({
      tipo: "temperatura",
      payload: { equipo: "X", tipoEquipo: "ambiente", temperaturaC: 20 },
    });
    expect(result.success).toBe(false);
  });

  it("recepción aceptada NO debe llevar motivoRechazo (caso negativo)", () => {
    const result = recepcionPayloadSchema.safeParse({
      proveedor: "Distribuidora del Caribe",
      producto: "Camarón congelado",
      aceptado: true,
      empaqueIntegro: true,
      motivoRechazo: "no debería poder mandarse junto con aceptado=true",
    });
    expect(result.success).toBe(false);
  });

  it("recepción rechazada EXIGE motivoRechazo (caso negativo)", () => {
    const result = recepcionPayloadSchema.safeParse({
      proveedor: "Distribuidora del Caribe",
      producto: "Camarón congelado",
      aceptado: false,
      empaqueIntegro: false,
    });
    expect(result.success).toBe(false);
  });

  it("recepción rechazada con motivo pasa", () => {
    const result = recepcionPayloadSchema.safeParse({
      proveedor: "Distribuidora del Caribe",
      producto: "Camarón congelado",
      aceptado: false,
      empaqueIntegro: false,
      motivoRechazo: "Empaque roto y cadena de frío rota",
    });
    expect(result.success).toBe(true);
  });

  it("acepta una entrada de limpieza válida", () => {
    const result = bitacoraNom251EntradaSchema.safeParse({
      tipo: "limpieza",
      payload: { area: "Cocina caliente", tipoLimpieza: "limpieza_y_desinfeccion", productoUsado: "Amonio cuaternario", concentracionPpm: 200 },
    });
    expect(result.success).toBe(true);
  });
});

describe("detectarAnomaliaBitacora", () => {
  it("temperatura fuera de rango se marca anomalía, sin bloquear el registro", () => {
    const entrada = { tipo: "temperatura", payload: { equipo: "Refrigerador 1", tipoEquipo: "refrigeracion", temperaturaC: 12 } } as const;
    expect(bitacoraNom251EntradaSchema.safeParse(entrada).success).toBe(true); // el dato fuera de rango SÍ se guarda
    const resultado = detectarAnomaliaBitacora(entrada);
    expect(resultado.anomalia).toBe(true);
    expect(resultado.motivo).toMatch(/fuera del rango/);
  });

  it("recepción aceptada no es anomalía; rechazada sí, con el motivo capturado", () => {
    expect(
      detectarAnomaliaBitacora({
        tipo: "recepcion",
        payload: { proveedor: "P", producto: "X", aceptado: true, empaqueIntegro: true },
      }).anomalia,
    ).toBe(false);
    const rechazo = detectarAnomaliaBitacora({
      tipo: "recepcion",
      payload: { proveedor: "P", producto: "X", aceptado: false, empaqueIntegro: false, motivoRechazo: "Caducado" },
    });
    expect(rechazo.anomalia).toBe(true);
    expect(rechazo.motivo).toBe("Caducado");
  });
});

describe("buildBitacoraNom251Csv: criterio de aceptación literal -- campos exigidos por la norma", () => {
  it("el CSV de temperatura lleva exactamente los encabezados esperados y los datos capturados", () => {
    const entradas: BitacoraNom251EntradaConMeta[] = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        registradoPor: "María Pérez",
        registradoEn: "2026-09-11T14:00:00.000Z",
        tipo: "temperatura",
        payload: { equipo: "Congelador barra", tipoEquipo: "congelacion", temperaturaC: -15 },
      },
    ];
    const csv = buildBitacoraNom251Csv("temperatura", entradas);
    const [header, row] = csv.trim().split("\r\n");
    expect(header).toBe(BITACORA_NOM251_CSV_HEADERS.temperatura.join(","));
    expect(row).toBe("2026-09-11T14:00:00.000Z,Congelador barra,congelacion,-15,,-18,no,María Pérez");
  });

  it("el CSV de recepción incluye proveedor/producto/lote/caducidad/motivo de rechazo", () => {
    const entradas: BitacoraNom251EntradaConMeta[] = [
      {
        id: "22222222-2222-2222-2222-222222222222",
        registradoPor: "Juan Gómez",
        registradoEn: "2026-09-11T09:00:00.000Z",
        tipo: "recepcion",
        payload: {
          proveedor: "Distribuidora del Caribe",
          producto: "Camarón",
          lote: "L-045",
          temperaturaC: 2,
          empaqueIntegro: true,
          fechaCaducidad: "2026-09-15",
          aceptado: true,
        },
      },
    ];
    const csv = buildBitacoraNom251Csv("recepcion", entradas);
    const [header, row] = csv.trim().split("\r\n");
    expect(header).toBe(BITACORA_NOM251_CSV_HEADERS.recepcion.join(","));
    expect(row).toBe("2026-09-11T09:00:00.000Z,Distribuidora del Caribe,Camarón,L-045,2,si,2026-09-15,si,,Juan Gómez");
  });

  it("el CSV de limpieza incluye área/tipo/producto/concentración", () => {
    const entradas: BitacoraNom251EntradaConMeta[] = [
      {
        id: "33333333-3333-3333-3333-333333333333",
        registradoPor: "Ana López",
        registradoEn: "2026-09-11T22:00:00.000Z",
        tipo: "limpieza",
        payload: { area: "Barra pool", tipoLimpieza: "desinfeccion", productoUsado: "Cloro", concentracionPpm: 100 },
      },
    ];
    const csv = buildBitacoraNom251Csv("limpieza", entradas);
    const [header, row] = csv.trim().split("\r\n");
    expect(header).toBe(BITACORA_NOM251_CSV_HEADERS.limpieza.join(","));
    expect(row).toBe("2026-09-11T22:00:00.000Z,Barra pool,desinfeccion,Cloro,100,Ana López");
  });

  it("filtra defensivamente cualquier entrada cuyo tipo no coincida con el export solicitado", () => {
    const entradas: BitacoraNom251EntradaConMeta[] = [
      {
        id: "44444444-4444-4444-4444-444444444444",
        registradoPor: "X",
        registradoEn: "2026-09-11T00:00:00.000Z",
        tipo: "limpieza",
        payload: { area: "A", tipoLimpieza: "limpieza", productoUsado: "Jabón" },
      },
    ];
    const csv = buildBitacoraNom251Csv("temperatura", entradas);
    expect(csv.trim().split("\r\n")).toHaveLength(1); // solo el encabezado
  });
});
