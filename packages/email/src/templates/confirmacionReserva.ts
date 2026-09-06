// H12a · Plantilla "confirmacion-reserva" -- confirmación de reserva al huésped. El
// código de confirmación se muestra destacado (es lo primero que un huésped busca al
// llegar al hotel o al llamar por teléfono). `totalAmount` solo se formatea con
// `formatCurrencyMXN` cuando `moneda === "MXN"` -- otras monedas se muestran con su
// código ISO tal cual, sin inventar un formato de Intl que no fue pedido.
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import { formatCurrencyMXN, formatDateEsMx } from "../format.ts";
import type { RenderedEmail } from "../port.ts";

export interface ConfirmacionReservaData {
  nombreHuesped: string;
  nombreHotel: string;
  codigoConfirmacion: string;
  checkIn: string;
  checkOut: string;
  tipoHabitacion: string;
  totalAmount: number;
  moneda: string;
  direccionHotel?: string;
  politicaCancelacionResumen?: string;
  verUrl?: string;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas sobre tu reserva? Contacta directamente al hotel.",
];

function formatMonto(amount: number, moneda: string): string {
  return moneda === "MXN" ? formatCurrencyMXN(amount) : `${amount.toFixed(2)} ${moneda}`;
}

export function renderConfirmacionReserva(data: ConfirmacionReservaData): RenderedEmail {
  const nombreHuesped = escapeHtml(data.nombreHuesped);
  const nombreHotel = escapeHtml(data.nombreHotel);
  const codigo = escapeHtml(data.codigoConfirmacion);
  const tipoHabitacion = escapeHtml(data.tipoHabitacion);
  const checkInFmt = formatDateEsMx(data.checkIn);
  const checkOutFmt = formatDateEsMx(data.checkOut);
  const totalFmt = formatMonto(data.totalAmount, data.moneda);

  const subject = `Tu reserva en ${data.nombreHotel} está confirmada — ${data.codigoConfirmacion}`;
  const preheader = `Reserva confirmada en ${data.nombreHotel} del ${checkInFmt} al ${checkOutFmt}.`;

  const direccionRow = data.direccionHotel
    ? `<tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Dirección</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${escapeHtml(data.direccionHotel)}</td></tr>`
    : "";

  const politicaHtml = data.politicaCancelacionResumen
    ? `<p style="margin:18px 0 0 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#5b6b82;"><strong>Política de cancelación:</strong> ${escapeHtml(data.politicaCancelacionResumen)}</p>`
    : "";

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola ${nombreHuesped},</p>
    <p style="margin:0 0 20px 0;">Tu reserva en <strong>${nombreHotel}</strong> está confirmada. Aquí está el detalle:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 4px 0;border-collapse:collapse;">
      <tr><td bgcolor="#eef3f9" style="padding:18px 20px;border:1px solid #e2e8f0;border-radius:10px;">
        <p style="margin:0 0 12px 0;font-family:'Inter Tight',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;letter-spacing:0.04em;color:#5b6b82;">CÓDIGO DE CONFIRMACIÓN</p>
        <p style="margin:0 0 16px 0;font-family:'Inter Tight',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:0.02em;color:#1D4ED8;">${codigo}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Llegada</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${checkInFmt}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Salida</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${checkOutFmt}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Habitación</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${tipoHabitacion}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Total</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;font-weight:600;">${totalFmt}</td></tr>
          ${direccionRow}
        </table>
      </td></tr>
    </table>
    ${politicaHtml}
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "Tu reserva está confirmada",
    bodyHtml,
    ctaLabel: data.verUrl ? "Ver mi reserva" : undefined,
    ctaUrl: data.verUrl,
    footerLines: FOOTER,
  });

  const textParagraphs = [
    `Hola ${data.nombreHuesped},`,
    `Tu reserva en ${data.nombreHotel} está confirmada. Código de confirmación: ${data.codigoConfirmacion}`,
    `Llegada: ${checkInFmt}`,
    `Salida: ${checkOutFmt}`,
    `Habitación: ${data.tipoHabitacion}`,
    `Total: ${totalFmt}`,
  ];
  if (data.direccionHotel) textParagraphs.push(`Dirección: ${data.direccionHotel}`);
  if (data.politicaCancelacionResumen) textParagraphs.push(`Política de cancelación: ${data.politicaCancelacionResumen}`);

  const text = renderEmailText({
    headingText: "Tu reserva está confirmada",
    bodyParagraphs: textParagraphs,
    ctaLabel: data.verUrl ? "Ver mi reserva" : undefined,
    ctaUrl: data.verUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleConfirmacionReservaData(): ConfirmacionReservaData {
  return {
    nombreHuesped: "Luis Fernando Aguilar",
    nombreHotel: "Hotel Boutique Casa Mérida",
    codigoConfirmacion: "CM-48213",
    checkIn: "2026-10-14",
    checkOut: "2026-10-17",
    tipoHabitacion: "Habitación Doble Superior",
    totalAmount: 5940,
    moneda: "MXN",
    direccionHotel: "Calle 60 #480, Centro, Mérida, Yucatán",
    politicaCancelacionResumen: "Cancelación sin costo hasta 48 horas antes de la llegada.",
  };
}
