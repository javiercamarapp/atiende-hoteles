// REQ-AB-007 (P2/F, H10-011/H10-012): traspasos internos de inventario hacia/desde el
// almacén central, y costo teórico del desayuno incluido. Espejo puro de
// `fnb_registrar_traspaso()` (packages/db/migrations/0130_fnb_centros_consumo.sql) --
// ver tests/integration/ab/centros-consumo.spec.ts para el caso probado contra
// Postgres real (dos centros + un traspaso, criterio literal de docs/ACEPTACION.md).
import { describe, expect, it } from "vitest";
import { computeTheoreticalBreakfastCost, planFnbInventoryTransfer } from "@atiende-hoteles/domain-hotel";

const ALMACEN = { id: "almacen-1", tipo: "almacen_central" } as const;
const RESTAURANTE = { id: "centro-restaurante", tipo: "centro_consumo" } as const;
const POOL_BAR = { id: "centro-pool-bar", tipo: "centro_consumo" } as const;

describe("planFnbInventoryTransfer", () => {
  it("surte del almacén central a un centro de consumo (caso normal)", () => {
    const plan = planFnbInventoryTransfer({
      fromCenter: ALMACEN,
      toCenter: RESTAURANTE,
      sourceQuantity: 50,
      quantity: 20,
    });
    expect(plan.sourceQuantityAfter).toBe(30);
    expect(plan.direction).toBe("almacen_a_centro");
  });

  it("un centro de consumo puede regresar existencia al almacén central", () => {
    const plan = planFnbInventoryTransfer({
      fromCenter: RESTAURANTE,
      toCenter: ALMACEN,
      sourceQuantity: 10,
      quantity: 4,
    });
    expect(plan.sourceQuantityAfter).toBe(6);
    expect(plan.direction).toBe("centro_a_almacen");
  });

  it("rechaza un traspaso DIRECTO entre dos centros de consumo (debe involucrar al almacén central)", () => {
    expect(() =>
      planFnbInventoryTransfer({ fromCenter: RESTAURANTE, toCenter: POOL_BAR, sourceQuantity: 10, quantity: 5 }),
    ).toThrow(/traspaso_invalido/);
  });

  it("rechaza traspasar más de lo que hay en el origen (stock insuficiente)", () => {
    expect(() =>
      planFnbInventoryTransfer({ fromCenter: ALMACEN, toCenter: RESTAURANTE, sourceQuantity: 5, quantity: 6 }),
    ).toThrow(/stock_insuficiente/);
  });

  it("rechaza cantidad cero o negativa", () => {
    expect(() =>
      planFnbInventoryTransfer({ fromCenter: ALMACEN, toCenter: RESTAURANTE, sourceQuantity: 10, quantity: 0 }),
    ).toThrow(/cantidad_invalida/);
    expect(() =>
      planFnbInventoryTransfer({ fromCenter: ALMACEN, toCenter: RESTAURANTE, sourceQuantity: 10, quantity: -3 }),
    ).toThrow(/cantidad_invalida/);
  });

  it("rechaza origen y destino iguales", () => {
    expect(() =>
      planFnbInventoryTransfer({ fromCenter: RESTAURANTE, toCenter: RESTAURANTE, sourceQuantity: 10, quantity: 1 }),
    ).toThrow(/centro_invalido/);
  });

  it("rechaza almacén central contra almacén central", () => {
    const otroAlmacen = { id: "almacen-2", tipo: "almacen_central" } as const;
    expect(() =>
      planFnbInventoryTransfer({ fromCenter: ALMACEN, toCenter: otroAlmacen, sourceQuantity: 10, quantity: 1 }),
    ).toThrow(/traspaso_invalido/);
  });
});

describe("computeTheoreticalBreakfastCost", () => {
  it("imputa ocupación × costo teórico por habitación-noche", () => {
    const result = computeTheoreticalBreakfastCost({ occupiedRoomNights: 40, costPerRoomNight: 65.5 });
    expect(result.imputedCost).toBe(2620);
  });

  it("se recalcula de inmediato ante un cambio en la ocupación proyectada (sin caché)", () => {
    const antes = computeTheoreticalBreakfastCost({ occupiedRoomNights: 40, costPerRoomNight: 65.5 });
    const despues = computeTheoreticalBreakfastCost({ occupiedRoomNights: 55, costPerRoomNight: 65.5 });
    expect(despues.imputedCost).toBeGreaterThan(antes.imputedCost);
    expect(despues.imputedCost).toBe(3602.5);
  });

  it("ocupación cero imputa costo cero, nunca un número inventado", () => {
    expect(computeTheoreticalBreakfastCost({ occupiedRoomNights: 0, costPerRoomNight: 65.5 }).imputedCost).toBe(0);
  });

  it("rechaza ocupación negativa o no entera", () => {
    expect(() => computeTheoreticalBreakfastCost({ occupiedRoomNights: -1, costPerRoomNight: 10 })).toThrow(
      /ocupacion_invalida/,
    );
    expect(() => computeTheoreticalBreakfastCost({ occupiedRoomNights: 1.5, costPerRoomNight: 10 })).toThrow(
      /ocupacion_invalida/,
    );
  });

  it("rechaza costo por habitación-noche negativo", () => {
    expect(() => computeTheoreticalBreakfastCost({ occupiedRoomNights: 10, costPerRoomNight: -1 })).toThrow(
      /costo_invalido/,
    );
  });
});
