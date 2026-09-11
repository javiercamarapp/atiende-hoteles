// REQ-RES-012: cotización de grupo/room block -- SLA de 15 minutos desde la solicitud
// y precio de grupo que SIEMPRE internaliza el costo de desplazamiento de ADR
// consultado al motor de Revenue (H02-015). Este archivo prueba el módulo puro; el
// contrato de aceptación LITERAL (API + embedded-postgres real) vive en
// tests/integration/grupos/cotizacion.spec.ts.
import { describe, expect, it } from "vitest";
import { computeGroupQuote, GROUP_QUOTE_SLA_MINUTES, GroupQuoteError, parseGroupQuoteInput, type GroupQuoteInput } from "@atiende-hoteles/domain-hotel";

const base: GroupQuoteInput = {
  requestedAt: "2026-01-10T09:00:00Z",
  quotedAt: "2026-01-10T09:10:00Z",
  checkInDate: "2026-03-01",
  checkOutDate: "2026-03-04", // 3 noches
  currency: "MXN",
  roomsRequested: 10,
  manualPrice: 30000,
  nightlyDisplacement: [
    { date: "2026-03-01", roomsDisplaced: 0, expectedAdr: 1200 },
    { date: "2026-03-02", roomsDisplaced: 0, expectedAdr: 1200 },
    { date: "2026-03-03", roomsDisplaced: 0, expectedAdr: 1200 },
  ],
};

describe("computeGroupQuote (REQ-RES-012)", () => {
  it("caso negativo — desplazamiento cero: el precio de grupo es EXACTAMENTE el precio manual (nunca se infla sin motivo)", () => {
    const quote = computeGroupQuote(base);
    expect(quote.displacementCost).toBe(0);
    expect(quote.groupPrice).toBe(quote.manualPrice);
    expect(quote.groupPrice).toBe(30000);
  });

  it("con desplazamiento distinto de cero, el precio de grupo NUNCA es igual al precio manual (criterio literal de ACEPTACION.md)", () => {
    const withDisplacement: GroupQuoteInput = {
      ...base,
      nightlyDisplacement: [
        { date: "2026-03-01", roomsDisplaced: 4, expectedAdr: 1200 }, // 4800
        { date: "2026-03-02", roomsDisplaced: 6, expectedAdr: 1500 }, // 9000
        { date: "2026-03-03", roomsDisplaced: 0, expectedAdr: 1200 }, // 0
      ],
    };
    const quote = computeGroupQuote(withDisplacement);
    expect(quote.displacementCost).toBe(13800);
    expect(quote.groupPrice).toBe(43800);
    expect(quote.groupPrice).not.toBe(quote.manualPrice);
  });

  it("calcula minutos de SLA y marca withinSla=true dentro de los 15 minutos", () => {
    const quote = computeGroupQuote(base);
    expect(quote.slaMinutes).toBe(10);
    expect(quote.withinSla).toBe(true);
    expect(GROUP_QUOTE_SLA_MINUTES).toBe(15);
  });

  it("marca withinSla=false pasados los 15 minutos, pero SIGUE generando la cotización (una cotización tardía no desaparece)", () => {
    const late: GroupQuoteInput = { ...base, quotedAt: "2026-01-10T09:16:00Z" };
    const quote = computeGroupQuote(late);
    expect(quote.slaMinutes).toBe(16);
    expect(quote.withinSla).toBe(false);
    expect(quote.groupPrice).toBe(30000);
  });

  it("rechaza una consulta de desplazamiento incompleta (falta una noche) — no se puede fijar precio sin consultar TODAS las noches", () => {
    const incomplete: GroupQuoteInput = {
      ...base,
      nightlyDisplacement: base.nightlyDisplacement.slice(0, 2),
    };
    expect(() => computeGroupQuote(incomplete)).toThrow(GroupQuoteError);
    try {
      computeGroupQuote(incomplete);
      expect.unreachable();
    } catch (err) {
      expect((err as GroupQuoteError).code).toBe("desplazamiento_incompleto");
    }
  });

  it("rechaza roomsDisplaced que exceda roomsRequested (dato de Revenue inconsistente)", () => {
    const invalid: GroupQuoteInput = {
      ...base,
      roomsRequested: 3,
      nightlyDisplacement: [
        { date: "2026-03-01", roomsDisplaced: 5, expectedAdr: 1200 },
        { date: "2026-03-02", roomsDisplaced: 0, expectedAdr: 1200 },
        { date: "2026-03-03", roomsDisplaced: 0, expectedAdr: 1200 },
      ],
    };
    try {
      computeGroupQuote(invalid);
      expect.unreachable();
    } catch (err) {
      expect((err as GroupQuoteError).code).toBe("desplazamiento_excede_bloque");
    }
  });

  it("rechaza quotedAt anterior a requestedAt (no se puede cotizar antes de recibir la solicitud)", () => {
    const badOrder: GroupQuoteInput = { ...base, quotedAt: "2026-01-10T08:00:00Z" };
    try {
      computeGroupQuote(badOrder);
      expect.unreachable();
    } catch (err) {
      expect((err as GroupQuoteError).code).toBe("orden_de_tiempo_invalido");
    }
  });

  it("rechaza checkOutDate <= checkInDate", () => {
    const invalid: GroupQuoteInput = { ...base, checkOutDate: base.checkInDate };
    try {
      computeGroupQuote(invalid);
      expect.unreachable();
    } catch (err) {
      expect((err as GroupQuoteError).code).toBe("estadia_invalida");
    }
  });

  it("rechaza una fila de desplazamiento duplicada para la misma fecha", () => {
    const dup: GroupQuoteInput = {
      ...base,
      nightlyDisplacement: [...base.nightlyDisplacement, { date: "2026-03-01", roomsDisplaced: 1, expectedAdr: 1200 }],
    };
    try {
      computeGroupQuote(dup);
      expect.unreachable();
    } catch (err) {
      expect((err as GroupQuoteError).code).toBe("desplazamiento_duplicado");
    }
  });

  it("parseGroupQuoteInput descarta campos no reconocidos (ej. un precio final inyectado desde el body)", () => {
    const raw = { ...base, groupPrice: 999999 };
    const parsed = parseGroupQuoteInput(raw);
    expect((parsed as unknown as Record<string, unknown>).groupPrice).toBeUndefined();
  });

  it("parseGroupQuoteInput rechaza roomsRequested no positivo", () => {
    expect(() => parseGroupQuoteInput({ ...base, roomsRequested: 0 })).toThrow();
  });
});
