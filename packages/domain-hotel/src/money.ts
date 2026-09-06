// H4 · Redondeo monetario consistente (2 decimales, MXN/USD): centraliza el único punto
// donde el motor de cotización redondea, para que sumar N noches redondeadas por
// separado y luego redondear el total no diverja del redondeo hecho en un solo paso.
export function roundCurrency(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
