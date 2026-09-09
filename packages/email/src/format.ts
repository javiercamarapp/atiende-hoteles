// H12a · Formato compartido de moneda/fecha para plantillas transaccionales (reserva,
// pago, CFDI) -- un solo lugar (mismo principio que MARCA.md §3 "el formato vive en UN
// lugar") para que ninguna plantilla invente su propio redondeo/separador.

export function formatCurrencyMXN(amount: number): string {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(amount);
}

export function formatDateEsMx(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}
