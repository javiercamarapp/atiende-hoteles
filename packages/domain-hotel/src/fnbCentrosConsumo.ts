// REQ-AB-007 (P2/F, H10-011/H10-012): dos reglas de negocio de F&B multi-centro.
//
//   1. Traspasos internos de inventario: un centro de consumo (restaurante, pool bar,
//      room service, minibar, eventos...) SOLO puede traspasar existencias
//      hacia/desde el almacén central del hotel -- nunca directo entre dos centros de
//      consumo (eso rompería la trazabilidad de "quién surtió a quién" que el almacén
//      central existe para dar). `planFnbInventoryTransfer` es un ESPEJO puro, sin I/O,
//      de la función SQL `fnb_registrar_traspaso` (packages/db/migrations/
//      0130_fnb_centros_consumo.sql) -- misma relación que `overbooking.ts` con
//      `book_availability()`: la autoridad final (bajo lock, con datos reales y
//      concurrencia) es la función SQL; este módulo sirve para validar rápido en la
//      capa de API antes de pagar el viaje a la base de datos, y para poder probar la
//      regla sin levantar Postgres.
//
//   2. Costo del desayuno incluido: en un hotel con desayuno incluido en la tarifa NO
//      hay venta que dispare el cargo (H10-012) -- el costo real que representa para el
//      hotel solo se puede IMPUTAR, nunca facturar. Se imputa como
//      `ocupación_proyectada × costo_teórico_por_habitación-noche`. Deliberadamente sin
//      caché/estado propio: cada llamada recibe la ocupación vigente (consultada en el
//      momento por el llamador contra `reservation`, ver
//      apps/api/src/routes/fnbCentrosConsumo.ts) y el costo configurado vigente, así
//      que "se recalcula automáticamente con cada actualización del forecast de
//      ocupación" (H10-012) se cumple por construcción: no existe un total viejo que
//      pueda quedar desactualizado, porque no se guarda ninguno.
import { roundCurrency } from "./money.ts";

export const FNB_CONSUMPTION_CENTER_TYPES = ["centro_consumo", "almacen_central"] as const;
export type FnbConsumptionCenterType = (typeof FNB_CONSUMPTION_CENTER_TYPES)[number];

export interface FnbCenterRef {
  readonly id: string;
  readonly tipo: FnbConsumptionCenterType;
}

export interface PlanFnbInventoryTransferInput {
  readonly fromCenter: FnbCenterRef;
  readonly toCenter: FnbCenterRef;
  /** Existencia actual del SKU en el centro origen, antes del traspaso. */
  readonly sourceQuantity: number;
  /** Cantidad a traspasar. Debe ser > 0. */
  readonly quantity: number;
}

export interface FnbInventoryTransferPlan {
  readonly sourceQuantityAfter: number;
  /** true cuando el origen es el almacén central (surtiendo a un centro de consumo);
   *  false cuando el destino es el almacén central (un centro de consumo devolviendo/
   *  regresando existencia). Informativo para quien reporta el traspaso. */
  readonly direction: "almacen_a_centro" | "centro_a_almacen";
}

/** Lanza `RangeError` con un código legible en el mensaje (mismo criterio que
 *  `folioEngine.computeChargeAmounts`) cuando el traspaso propuesto viola una regla de
 *  negocio; de lo contrario devuelve el plan resultante. NUNCA muta sus argumentos. */
export function planFnbInventoryTransfer(input: PlanFnbInventoryTransferInput): FnbInventoryTransferPlan {
  const { fromCenter, toCenter, sourceQuantity, quantity } = input;

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new RangeError("cantidad_invalida: la cantidad a traspasar debe ser mayor a 0.");
  }
  if (fromCenter.id === toCenter.id) {
    throw new RangeError("centro_invalido: el centro origen y destino no pueden ser el mismo.");
  }
  // La regla central del REQ: "traspasos internos de inventario HACIA/DESDE un almacén
  // central" -- un traspaso directo entre dos centros de consumo (ninguno de los dos es
  // el almacén central) no está permitido, sin importar cuánta existencia tenga el
  // origen.
  const fromIsAlmacen = fromCenter.tipo === "almacen_central";
  const toIsAlmacen = toCenter.tipo === "almacen_central";
  if (!fromIsAlmacen && !toIsAlmacen) {
    throw new RangeError(
      "traspaso_invalido: el traspaso debe involucrar al almacén central (origen o destino), nunca directo entre dos centros de consumo.",
    );
  }
  if (fromIsAlmacen && toIsAlmacen) {
    // No debería ser alcanzable (un hotel tiene un único almacén central, ver el índice
    // único parcial de la migración) pero se rechaza explícitamente en vez de asumir.
    throw new RangeError("traspaso_invalido: origen y destino no pueden ser ambos el almacén central.");
  }
  if (!Number.isFinite(sourceQuantity) || sourceQuantity < 0) {
    throw new RangeError("existencia_invalida: la existencia del origen no puede ser negativa.");
  }
  if (sourceQuantity < quantity) {
    throw new RangeError(
      `stock_insuficiente: el centro origen tiene ${sourceQuantity} y se solicitaron ${quantity}.`,
    );
  }

  return {
    sourceQuantityAfter: sourceQuantity - quantity,
    direction: fromIsAlmacen ? "almacen_a_centro" : "centro_a_almacen",
  };
}

export interface TheoreticalBreakfastCostInput {
  /** Habitaciones-noche ocupadas proyectadas para la fecha (ver
   *  `apps/api/src/routes/fnbCentrosConsumo.ts`: conteo real de `reservation` vigente
   *  para esa fecha -- nunca un número inventado). Entero no-negativo. */
  readonly occupiedRoomNights: number;
  /** Costo teórico configurado por el hotel por habitación-noche con desayuno incluido
   *  (receta estándar de consumo, H10-012). No-negativo. */
  readonly costPerRoomNight: number;
}

export interface TheoreticalBreakfastCostResult {
  readonly occupiedRoomNights: number;
  readonly costPerRoomNight: number;
  /** Costo total imputado = ocupación × costo teórico, redondeado (money.ts). Esto es
   *  un costo interno del hotel (nunca un cargo al huésped -- el desayuno ya está
   *  incluido en la tarifa, H10-012). */
  readonly imputedCost: number;
}

/** Imputa el costo del desayuno incluido para una fecha, dada su ocupación proyectada.
 *  Determinista y sin estado: llamar dos veces con la misma ocupación da el mismo
 *  resultado; llamar con una ocupación distinta (porque el forecast se movió) da un
 *  resultado distinto de inmediato -- así es como este módulo cumple "se recalcula
 *  automáticamente con cada actualización del forecast de ocupación" sin necesitar
 *  ningún mecanismo de invalidación de caché. */
export function computeTheoreticalBreakfastCost(
  input: TheoreticalBreakfastCostInput,
): TheoreticalBreakfastCostResult {
  const { occupiedRoomNights, costPerRoomNight } = input;
  if (!Number.isInteger(occupiedRoomNights) || occupiedRoomNights < 0) {
    throw new RangeError("ocupacion_invalida: occupiedRoomNights debe ser un entero no-negativo.");
  }
  if (!Number.isFinite(costPerRoomNight) || costPerRoomNight < 0) {
    throw new RangeError("costo_invalido: costPerRoomNight no puede ser negativo.");
  }
  return {
    occupiedRoomNights,
    costPerRoomNight,
    imputedCost: roundCurrency(occupiedRoomNights * costPerRoomNight),
  };
}
