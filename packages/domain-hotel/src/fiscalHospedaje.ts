// H5 · REQ-BO-007: cálculo determinista (nunca vía LLM) de los impuestos/retenciones
// del hotel citados por H16-009/010/011/012 -- ISH, DSA, ISN, IVA, ISR provisional,
// DIOT y retención a plataformas digitales (reforma 2026). Cada función es un cálculo
// PURO y PARAMETRIZADO: ninguna tasa/umbral vive fija en este archivo, todas llegan
// como argumento (mismo principio que taxes.ts) para que el llamador las lea de
// configuración real por hotel/estado, nunca de un valor "de verdad" hardcodeado aquí.
import { roundCurrency } from "./money.ts";

/** 1) IVA (H16-009): tasa general sobre una base gravable cualquiera. */
export function computeIva(baseAmount: number, ivaRate: number): number {
  if (baseAmount < 0) throw new RangeError("baseAmount no puede ser negativo.");
  if (!(ivaRate >= 0)) throw new RangeError("ivaRate debe ser un número no negativo.");
  return roundCurrency(baseAmount * ivaRate);
}

/** 2) ISH de Quintana Roo (H16-010): 5% sobre la contraprestación de hospedaje
 *  EXCLUYENDO alimentos -- `baseHospedajeSinAlimentos` es responsabilidad del
 *  llamador (nunca incluye A&B). La tasa es parámetro (`ishRate`), no un 5% fijo en
 *  código, porque otros estados fijan una tasa distinta. */
export function computeIsh(baseHospedajeSinAlimentos: number, ishRate: number): number {
  if (baseHospedajeSinAlimentos < 0) throw new RangeError("baseHospedajeSinAlimentos no puede ser negativo.");
  if (!(ishRate >= 0)) throw new RangeError("ishRate debe ser un número no negativo.");
  return roundCurrency(baseHospedajeSinAlimentos * ishRate);
}

/** 3) DSA (Derecho de Saneamiento Ambiental, H16-011): monto FIJO por cuarto-noche
 *  ocupado (no porcentual) -- MXN 20/cuarto-noche es el dato citado por H16, aquí
 *  llega siempre como parámetro (`perNightAmount`) porque cambia por municipio. */
export function computeDsa(roomNights: number, perNightAmount: number): number {
  if (!Number.isInteger(roomNights) || roomNights < 0) throw new RangeError("roomNights debe ser un entero no negativo.");
  if (perNightAmount < 0) throw new RangeError("perNightAmount no puede ser negativo.");
  return roundCurrency(roomNights * perNightAmount);
}

/** 4) ISN (Impuesto Sobre Nómina, H16-009): porcentaje sobre la base de nómina del
 *  periodo -- 4% es el dato citado por H16 para Quintana Roo, aquí es parámetro
 *  (`isnRate`) porque cada estado fija el suyo. */
export function computeIsn(payrollBase: number, isnRate: number): number {
  if (payrollBase < 0) throw new RangeError("payrollBase no puede ser negativo.");
  if (!(isnRate >= 0)) throw new RangeError("isnRate debe ser un número no negativo.");
  return roundCurrency(payrollBase * isnRate);
}

/** 5) ISR provisional (H16-009): aplicado sobre la base gravable del periodo con la
 *  tasa/tabla vigente que el llamador resuelva (aquí se modela como tasa efectiva ya
 *  resuelta, no la tarifa progresiva completa del SAT -- fuera de alcance de H5). */
export function computeIsrProvisional(taxableBase: number, effectiveRate: number): number {
  if (taxableBase < 0) throw new RangeError("taxableBase no puede ser negativo.");
  if (!(effectiveRate >= 0)) throw new RangeError("effectiveRate debe ser un número no negativo.");
  return roundCurrency(taxableBase * effectiveRate);
}

export interface DiotOperation {
  /** Monto pagado al proveedor en la operación, base para el IVA acreditable reportado. */
  amount: number;
}

/** 6) DIOT (Declaración Informativa de Operaciones con Terceros, H16-009): NO es una
 *  tasa, es la suma de las operaciones con proveedores/terceros del periodo que se
 *  reportan -- el "cálculo" verificable es que ninguna operación se pierda ni se
 *  duplique al sumar. */
export function computeDiotTotal(operations: DiotOperation[]): number {
  const total = operations.reduce((sum, op) => {
    if (op.amount < 0) throw new RangeError("Una operación de DIOT no puede tener monto negativo.");
    return sum + op.amount;
  }, 0);
  return roundCurrency(total);
}

export type PlatformFilerType = "PF" | "PM";

export interface RetencionPlataformasDigitalesRates {
  /** ISR: 4% o 20% para PF (según ingreso mensual acumulado), 2.5% para PM (H16-012). */
  isrRate: number;
  /** IVA: 8% o 16% para PF, 8% para PM (H16-012). */
  ivaRate: number;
}

export interface RetencionPlataformasDigitales {
  isrAmount: number;
  ivaAmount: number;
  totalRetenido: number;
}

/** 7) Retención a plataformas digitales de hospedaje (reforma 2026, H16-012): ISR +
 *  IVA retenidos por la plataforma (Airbnb/Booking/Expedia) sobre el monto pagado al
 *  hotel. Las tasas (PF: 4%/20% ISR + 8%/16% IVA; PM: 2.5% ISR + 8% IVA) son SIEMPRE
 *  parámetro -- el umbral que decide 4% vs 20% para PF depende del ingreso mensual
 *  acumulado del hotel, dato que este módulo no posee y que el llamador debe resolver
 *  antes de invocar esta función (nunca se asume aquí). */
export function computeRetencionPlataformasDigitales(
  grossAmount: number,
  filerType: PlatformFilerType,
  rates: RetencionPlataformasDigitalesRates,
): RetencionPlataformasDigitales {
  if (grossAmount < 0) throw new RangeError("grossAmount no puede ser negativo.");
  if (!(rates.isrRate >= 0) || !(rates.ivaRate >= 0)) throw new RangeError("Las tasas deben ser números no negativos.");
  const isrAmount = roundCurrency(grossAmount * rates.isrRate);
  const ivaAmount = roundCurrency(grossAmount * rates.ivaRate);
  return { isrAmount, ivaAmount, totalRetenido: roundCurrency(isrAmount + ivaAmount) };
}
