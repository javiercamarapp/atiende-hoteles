// REQ-RES-012: seguimiento de cut-off de un room block de grupo (H05-013) -- alerta
// cuando el bloque se acerca a su fecha de cut-off sin pickup suficiente, y cuántas
// habitaciones liberar de vuelta al inventario cuando el cut-off ya pasó.
import { describe, expect, it } from "vitest";
import { assertValidPickup, daysUntilCutoff, evaluateCutoffAlert, pickupPct, roomsToRelease, RoomBlockError } from "@atiende-hoteles/domain-hotel";

describe("assertValidPickup", () => {
  it("rechaza pickup por encima de lo bloqueado (fraude/dato inconsistente)", () => {
    expect(() => assertValidPickup(10, 11)).toThrow(RoomBlockError);
    try {
      assertValidPickup(10, 11);
      expect.unreachable();
    } catch (err) {
      expect((err as RoomBlockError).code).toBe("pickup_excede_bloqueo");
    }
  });
  it("rechaza roomsBlocked no positivo o pickup negativo", () => {
    try {
      assertValidPickup(0, 0);
      expect.unreachable();
    } catch (err) {
      expect((err as RoomBlockError).code).toBe("bloque_invalido");
    }
    try {
      assertValidPickup(10, -1);
      expect.unreachable();
    } catch (err) {
      expect((err as RoomBlockError).code).toBe("pickup_invalido");
    }
  });
  it("acepta pickup igual al bloque completo", () => {
    expect(() => assertValidPickup(10, 10)).not.toThrow();
  });
});

describe("daysUntilCutoff", () => {
  it("positivo cuando el cut-off es futuro, negativo cuando ya pasó", () => {
    expect(daysUntilCutoff("2026-03-10", "2026-03-01")).toBe(9);
    expect(daysUntilCutoff("2026-03-01", "2026-03-10")).toBe(-9);
    expect(daysUntilCutoff("2026-03-01", "2026-03-01")).toBe(0);
  });
});

describe("pickupPct", () => {
  it("calcula el porcentaje real de habitaciones confirmadas", () => {
    expect(pickupPct(20, 5)).toBe(25);
    expect(pickupPct(20, 20)).toBe(100);
    expect(pickupPct(20, 0)).toBe(0);
  });
});

describe("evaluateCutoffAlert (H05-013)", () => {
  it("caso negativo — pickup suficiente: 'ninguna' alerta aunque el cut-off sea HOY", () => {
    const ev = evaluateCutoffAlert({ roomsBlocked: 20, roomsPickedUp: 18, cutoffDate: "2026-03-01", asOfDate: "2026-03-01" });
    expect(ev.alertLevel).toBe("ninguna");
    expect(ev.pickupPct).toBe(90);
  });

  it("'ninguna' cuando el cut-off está lejos, sin importar el pickup bajo", () => {
    const ev = evaluateCutoffAlert({ roomsBlocked: 20, roomsPickedUp: 2, cutoffDate: "2026-03-30", asOfDate: "2026-03-01" });
    expect(ev.alertLevel).toBe("ninguna");
    expect(ev.reason).toMatch(/fuera_de_ventana/);
  });

  it("'atencion' dentro de la ventana de 7 días con pickup insuficiente", () => {
    const ev = evaluateCutoffAlert({ roomsBlocked: 20, roomsPickedUp: 5, cutoffDate: "2026-03-06", asOfDate: "2026-03-01" });
    expect(ev.alertLevel).toBe("atencion");
    expect(ev.daysUntilCutoff).toBe(5);
  });

  it("'critica' cuando el cut-off ya pasó con pickup insuficiente", () => {
    const ev = evaluateCutoffAlert({ roomsBlocked: 20, roomsPickedUp: 5, cutoffDate: "2026-02-25", asOfDate: "2026-03-01" });
    expect(ev.alertLevel).toBe("critica");
    expect(ev.reason).toMatch(/cutoff_vencido/);
  });

  it("respeta un umbral de pickup mínimo configurado explícitamente", () => {
    const ev = evaluateCutoffAlert({
      roomsBlocked: 20,
      roomsPickedUp: 15,
      cutoffDate: "2026-03-01",
      asOfDate: "2026-03-01",
      minPickupPct: 90,
    });
    expect(ev.alertLevel).toBe("critica"); // 75% < 90% exigido
  });
});

describe("roomsToRelease", () => {
  it("libera exactamente lo no confirmado", () => {
    expect(roomsToRelease(20, 12)).toBe(8);
  });
  it("nunca libera un número negativo (pickup completo)", () => {
    expect(roomsToRelease(20, 20)).toBe(0);
  });
});
