// REQ-AGT-020: contador de costo por hotel.
import { describe, expect, it } from "vitest";
import { InMemoryCostLedger } from "@atiende-hoteles/agent-core";

describe("InMemoryCostLedger", () => {
  it("acumula costo por hotel y por modelo", () => {
    const ledger = new InMemoryCostLedger();
    ledger.registrar("hotel-1", "claude-sonnet-5", 0.01);
    ledger.registrar("hotel-1", "claude-sonnet-5", 0.02);
    ledger.registrar("hotel-1", "claude-haiku-4-5", 0.001);
    expect(ledger.totalPorHotel("hotel-1")).toBeCloseTo(0.031, 6);
    expect(ledger.detallePorHotel("hotel-1")["claude-sonnet-5"]).toBeCloseTo(0.03, 6);
  });

  it("no mezcla costo entre hoteles distintos", () => {
    const ledger = new InMemoryCostLedger();
    ledger.registrar("hotel-A", "claude-sonnet-5", 5);
    ledger.registrar("hotel-B", "claude-sonnet-5", 9);
    expect(ledger.totalPorHotel("hotel-A")).toBe(5);
    expect(ledger.totalPorHotel("hotel-B")).toBe(9);
  });

  it("un hotel sin registros tiene total 0", () => {
    const ledger = new InMemoryCostLedger();
    expect(ledger.totalPorHotel("hotel-nuevo")).toBe(0);
    expect(ledger.detallePorHotel("hotel-nuevo")).toEqual({});
  });
});
