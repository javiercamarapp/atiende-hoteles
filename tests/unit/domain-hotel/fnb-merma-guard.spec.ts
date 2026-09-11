// REQ-AB-010 (P2/F): "El sistema debe registrar merma de inventario F&B por causa
// (clima, robo, caducidad, etc.) en todos los centros de consumo." H10-015: "el 100% de
// los ajustes de merma quedan clasificados por causa en el registro de inventario".
import { describe, expect, it } from "vitest";
import {
  FNB_CENTROS_CONSUMO,
  FNB_MERMA_CAUSAS,
  FnbMermaInvalidError,
  assertValidFnbMerma,
  isFnbCentroConsumo,
  isFnbMermaCausa,
  summarizeFnbMermaByCausa,
} from "@atiende-hoteles/domain-hotel";

describe("isFnbCentroConsumo / isFnbMermaCausa", () => {
  it("acepta exactamente el set canónico de H10-011 y rechaza cualquier otro valor", () => {
    for (const centro of FNB_CENTROS_CONSUMO) expect(isFnbCentroConsumo(centro)).toBe(true);
    expect(isFnbCentroConsumo("bodega_fantasma")).toBe(false);
    expect(isFnbCentroConsumo("")).toBe(false);
  });

  it("acepta exactamente el set canónico de H10-015 y rechaza cualquier otro valor", () => {
    for (const causa of FNB_MERMA_CAUSAS) expect(isFnbMermaCausa(causa)).toBe(true);
    expect(isFnbMermaCausa("se_lo_comio_el_perro")).toBe(false);
  });
});

describe("assertValidFnbMerma", () => {
  it("acepta un registro válido por cada causa del enum canónico (una por causa, REQ-AB-010)", () => {
    for (const causa of FNB_MERMA_CAUSAS) {
      const nota = causa === "otro" ? "derrame durante limpieza profunda de la cava" : undefined;
      expect(() =>
        assertValidFnbMerma({ centroConsumo: "restaurante", causa, cantidad: 2, nota }),
      ).not.toThrow();
    }
  });

  it("acepta un registro válido en cada centro de consumo del enum canónico (H10-011)", () => {
    for (const centroConsumo of FNB_CENTROS_CONSUMO) {
      expect(() =>
        assertValidFnbMerma({ centroConsumo, causa: "caducidad", cantidad: 1, nota: null }),
      ).not.toThrow();
    }
  });

  it("rechaza un centro de consumo fuera del enum cerrado (fail-closed)", () => {
    expect(() => assertValidFnbMerma({ centroConsumo: "bodega_no_registrada", causa: "robo", cantidad: 1, nota: null })).toThrow(
      FnbMermaInvalidError,
    );
  });

  it("rechaza una causa fuera del enum cerrado -- NUNCA texto libre sin clasificar (H10-015)", () => {
    expect(() => assertValidFnbMerma({ centroConsumo: "minibar", causa: "se descompuso solo", cantidad: 1, nota: null })).toThrow(
      FnbMermaInvalidError,
    );
  });

  it("rechaza cantidad cero, negativa o no finita", () => {
    expect(() => assertValidFnbMerma({ centroConsumo: "pool_bar", causa: "clima", cantidad: 0, nota: null })).toThrow();
    expect(() => assertValidFnbMerma({ centroConsumo: "restaurante", causa: "clima", cantidad: -3, nota: null })).toThrow();
    expect(() => assertValidFnbMerma({ centroConsumo: "restaurante", causa: "clima", cantidad: Number.NaN, nota: null })).toThrow();
  });

  it('la causa "otro" SIN nota se rechaza -- una causa sin clasificar no es útil para auditoría (caso negativo central de REQ-AB-010)', () => {
    expect(() => assertValidFnbMerma({ centroConsumo: "eventos", causa: "otro", cantidad: 5, nota: null })).toThrow(
      FnbMermaInvalidError,
    );
    expect(() => assertValidFnbMerma({ centroConsumo: "eventos", causa: "otro", cantidad: 5, nota: "   " })).toThrow(
      FnbMermaInvalidError,
    );
    expect(() => assertValidFnbMerma({ centroConsumo: "eventos", causa: "otro", cantidad: 5, nota: undefined })).toThrow(
      FnbMermaInvalidError,
    );
  });

  it('la causa "otro" CON nota real se acepta', () => {
    expect(() =>
      assertValidFnbMerma({ centroConsumo: "eventos", causa: "otro", cantidad: 5, nota: "botellas rotas al montar el salón" }),
    ).not.toThrow();
  });

  it("clima y huracan son causas distintas (no se fusionan pese a ser ambas climáticas)", () => {
    expect(() => assertValidFnbMerma({ centroConsumo: "pool_bar", causa: "clima", cantidad: 3, nota: null })).not.toThrow();
    expect(() => assertValidFnbMerma({ centroConsumo: "pool_bar", causa: "huracan", cantidad: 30, nota: null })).not.toThrow();
  });
});

describe("summarizeFnbMermaByCausa", () => {
  it("agrupa por causa, sumando cantidad y contando registros -- verifica un registro por causa", () => {
    const resumen = summarizeFnbMermaByCausa([
      { causa: "clima", cantidad: 2 },
      { causa: "robo", cantidad: 1 },
      { causa: "caducidad", cantidad: 5 },
      { causa: "caducidad", cantidad: 3 },
    ]);
    // Orden estable = orden canónico de `FNB_MERMA_CAUSAS` (clima, huracan, robo,
    // caducidad, otro), no el orden de inserción -- un reporte de merma con orden
    // consistente entre corridas es más fácil de leer para el gerente.
    expect(resumen).toEqual([
      { causa: "clima", registros: 1, cantidadTotal: 2 },
      { causa: "robo", registros: 1, cantidadTotal: 1 },
      { causa: "caducidad", registros: 2, cantidadTotal: 8 },
    ]);
  });

  it("una lista vacía produce un resumen vacío, sin tronar", () => {
    expect(summarizeFnbMermaByCausa([])).toEqual([]);
  });

  it("descarta defensivamente cualquier causa fuera del enum (nunca debería ocurrir con el CHECK de BD, pero no truena)", () => {
    const resumen = summarizeFnbMermaByCausa([{ causa: "causa_invalida", cantidad: 10 }]);
    expect(resumen).toEqual([]);
  });
});
