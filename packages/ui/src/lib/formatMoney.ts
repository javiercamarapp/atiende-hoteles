/**
 * auditoria-2/frontend [BAJO]: ninguna pantalla usaba separador de miles -- 15
 * ocurrencias de `` `$${x.toFixed(2 o 0)}` `` concatenado a mano en
 * FolioPanel/Resumen/Reservas/BackOffice/Mantenimiento, sin ningún punto único que
 * garantizara consistencia (un total de $12,500.00 se leía "$12500.00"). Solo
 * formatea la parte NUMÉRICA con separador de miles (`es-MX`) -- el llamador sigue
 * anteponiendo "$"/agregando "MXN" como ya hacía, para no cambiar el estilo visual
 * existente en un solo commit, solo corregir la legibilidad de montos de 5+ dígitos.
 * `packages/domain-hotel/src/money.ts` sigue siendo el único lugar que REDONDEA
 * dinero (`roundCurrency`) -- esta función nunca calcula, solo formatea un número que
 * el backend ya calculó.
 */
export function formatMoney(amount: number, decimals: 0 | 2 = 2): string {
  return amount.toLocaleString("es-MX", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
