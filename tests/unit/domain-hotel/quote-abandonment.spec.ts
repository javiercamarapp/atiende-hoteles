// REQ-RES-011 (docs/ACEPTACION.md): "Cotización abandonada detectada por el motor
// propio dispara contacto en las ventanas configuradas (10 min, 2h, 24h) con oferta no
// monetaria; prueba de tiempo simulado confirma exactamente 3 contactos en esas
// ventanas, ninguno antes ni después." Unit puro (sin BD, sin reloj real) de
// `packages/domain-hotel/src/reservas/quoteAbandonment.ts` -- verifica: (1) las 3
// ventanas EXACTAS del criterio (10/120/1440 minutos), (2) que cada una trae una oferta
// NO monetaria (nunca un texto que hable de descuento/precio), (3) el cómputo del
// instante de contacto y (4) la detección de "ventana alcanzada" con reloj INYECTADO,
// incluyendo el caso límite exacto. El escenario de integración real contra
// PGlite/embedded-postgres (detección + marcado + outbox end-to-end) vive en
// `tests/integration/marketing/abandono.spec.ts`.
import { describe, expect, it } from "vitest";
import {
  QUOTE_ABANDONMENT_WINDOWS,
  resolveQuoteAbandonmentWindow,
  computeAbandonmentContactAt,
  isAbandonmentContactDue,
} from "@atiende-hoteles/domain-hotel";

describe("QUOTE_ABANDONMENT_WINDOWS — catálogo del criterio de aceptación (REQ-RES-011)", () => {
  it("expone EXACTAMENTE las 3 ventanas del criterio: 10 min, 2h (120 min), 24h (1440 min)", () => {
    expect(QUOTE_ABANDONMENT_WINDOWS.map((w) => w.minutes)).toEqual([10, 120, 1440]);
    expect(QUOTE_ABANDONMENT_WINDOWS.map((w) => w.key)).toEqual(["10m", "2h", "24h"]);
  });

  it("ninguna oferta menciona descuento/precio -- el REQ exige explícitamente 'un incentivo NO monetario'", () => {
    const palabrasProhibidas = ["descuento", "%", "gratis", "rebaja", "precio menor", "más barato"];
    for (const ventana of QUOTE_ABANDONMENT_WINDOWS) {
      const textoNormalizado = ventana.ofertaNoMonetaria.toLowerCase();
      for (const palabra of palabrasProhibidas) {
        expect(textoNormalizado).not.toContain(palabra);
      }
    }
  });

  it("resolveQuoteAbandonmentWindow devuelve la definición completa por key, y lanza para una key desconocida", () => {
    expect(resolveQuoteAbandonmentWindow("2h").minutes).toBe(120);
    expect(resolveQuoteAbandonmentWindow("24h").etiqueta).toBe("24 horas");
    // @ts-expect-error -- ejercita el camino de runtime (ej. un `window` corrupto leído
    // desde un payload de outbox persistido), no solo el tipo.
    expect(() => resolveQuoteAbandonmentWindow("3d")).toThrow();
  });
});

describe("computeAbandonmentContactAt / isAbandonmentContactDue — reloj simulado (REQ-RES-011)", () => {
  const creada = new Date("2026-09-10T12:00:00.000Z");

  it("computa el instante exacto de contacto de cada ventana desde la creación", () => {
    expect(computeAbandonmentContactAt(creada, 10).toISOString()).toBe("2026-09-10T12:10:00.000Z");
    expect(computeAbandonmentContactAt(creada, 120).toISOString()).toBe("2026-09-10T14:00:00.000Z");
    expect(computeAbandonmentContactAt(creada, 1440).toISOString()).toBe("2026-09-11T12:00:00.000Z");
  });

  it("NO dispara un instante antes de alcanzar la ventana (caso negativo)", () => {
    const contactoA = computeAbandonmentContactAt(creada, 10);
    const unMsAntes = new Date(contactoA.getTime() - 1);
    expect(isAbandonmentContactDue(unMsAntes, contactoA)).toBe(false);
  });

  it("SÍ dispara exactamente al alcanzar la ventana (límite inclusive) y después", () => {
    const contactoA = computeAbandonmentContactAt(creada, 10);
    expect(isAbandonmentContactDue(contactoA, contactoA)).toBe(true);
    expect(isAbandonmentContactDue(new Date(contactoA.getTime() + 1), contactoA)).toBe(true);
  });

  it("las 3 ventanas producen 3 instantes de contacto estrictamente crecientes (nunca se solapan ni se saltan)", () => {
    const instantes = QUOTE_ABANDONMENT_WINDOWS.map((w) => computeAbandonmentContactAt(creada, w.minutes).getTime());
    expect(instantes[1]!).toBeGreaterThan(instantes[0]!);
    expect(instantes[2]!).toBeGreaterThan(instantes[1]!);
  });
});
