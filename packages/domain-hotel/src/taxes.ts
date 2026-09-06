// H4 · REQ-REV-001: IVA/ISH son PARÁMETROS por hotel (packages/db `hotel_tax_config`),
// nunca una tasa fiscal fija "de verdad" en código — este módulo solo aplica lo que le
// pasan, nunca decide ni asume una tasa por su cuenta. Ningún LLM invoca esta función
// con un monto propio: siempre recibe `netAmount` ya calculado desde tarifas reales.
import { roundCurrency } from "./money.ts";

export interface TaxConfig {
  /** 0..1 (ej. 0.16 = 16%). Configurado por hotel, ver `hotel_tax_config.iva_rate`. */
  ivaRate: number;
  /** 0..1 (ej. 0.03 = 3%). Configurado por hotel, ver `hotel_tax_config.ish_rate`. */
  ishRate: number;
}

export interface TaxBreakdown {
  netAmount: number;
  ivaAmount: number;
  ishAmount: number;
  totalAmount: number;
}

export function assertValidTaxConfig(config: TaxConfig): void {
  if (!(config.ivaRate >= 0) || !(config.ishRate >= 0)) {
    throw new RangeError("Las tasas de IVA/ISH deben ser números no negativos.");
  }
}

/** Único punto del sistema donde neto + IVA + ISH se combinan en un total. Determinista:
 *  misma entrada siempre produce la misma salida, sin aleatoriedad ni juicio de un LLM. */
export function applyTaxes(netAmount: number, config: TaxConfig): TaxBreakdown {
  assertValidTaxConfig(config);
  const net = roundCurrency(netAmount);
  const ivaAmount = roundCurrency(net * config.ivaRate);
  const ishAmount = roundCurrency(net * config.ishRate);
  const totalAmount = roundCurrency(net + ivaAmount + ishAmount);
  return { netAmount: net, ivaAmount, ishAmount, totalAmount };
}
