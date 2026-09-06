// REQ-RES-007/H02-010: sobreventa controlada solo dentro de reglas explícitas
// (máximo de habitaciones + umbral de ocupación). Espejo de la fórmula SQL real de
// `book_availability` (packages/db/migrations/0013_tarifas_avanzadas_y_politicas.sql) —
// ver tests/integration/reservas/overbooking-controlado.spec.ts para el caso probado
// contra Postgres real.
import { describe, expect, it } from "vitest";
import { canBook, effectiveCapacity, occupancyPct } from "@atiende-hoteles/domain-hotel";

describe("fórmula de sobreventa controlada", () => {
  it("por debajo del umbral de ocupación, la capacidad efectiva es solo el inventario base (sin bono de sobreventa)", () => {
    // 8/10 = 80% de ocupación, por debajo del umbral de 95%.
    const config = { maxOverbookRooms: 2, occupancyThresholdPct: 95 };
    expect(occupancyPct(10, 8)).toBe(80);
    expect(effectiveCapacity(10, 8, config)).toBe(10);
    // Una sola solicitud (qty=1) nunca necesita el bono aquí (todavía hay 2 libres).
    expect(canBook(10, 8, 1, config)).toBe(true);
    // Pero una solicitud de 2+ habitaciones de una vez SÍ expone la diferencia: sin
    // haber cruzado el umbral, no se concede el bono de sobreventa.
    expect(canBook(10, 8, 3, config)).toBe(false);
  });

  it("al alcanzar el umbral de ocupación, la sobreventa configurada se habilita", () => {
    const config = { maxOverbookRooms: 2, occupancyThresholdPct: 95 };
    // 10/10 = 100% >= 95%: la capacidad efectiva crece en max_overbook_rooms.
    expect(effectiveCapacity(10, 10, config)).toBe(12);
    expect(canBook(10, 10, 2, config)).toBe(true);
    expect(canBook(10, 10, 3, config)).toBe(false);
  });

  it("max_overbook_rooms = 0 reproduce el comportamiento anterior a H4 (nunca sobrevende)", () => {
    const config = { maxOverbookRooms: 0, occupancyThresholdPct: 95 };
    expect(effectiveCapacity(5, 5, config)).toBe(5);
    expect(canBook(5, 5, 1, config)).toBe(false);
  });

  it("un tipo de habitación sin inventario configurado (total=0) se trata como 100% ocupado", () => {
    expect(occupancyPct(0, 0)).toBe(100);
  });
});
