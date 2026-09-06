// H12a · Plantilla "recibo-pago" -- recibo de un pago recibido (no es CFDI -- ver
// cfdiDisponible.ts para la factura fiscal, que es un correo separado porque el
// timbrado puede tardar o requerir datos fiscales adicionales del huésped).
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import { formatCurrencyMXN, formatDateEsMx } from "../format.ts";
import type { RenderedEmail } from "../port.ts";

export interface ReciboPagoData {
  nombreHuesped: string;
  nombreHotel: string;
  monto: number;
  moneda: string;
  metodo: string;
  folioCodigo: string;
  fechaPago: string;
  referenciaExterna?: string;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas sobre este pago? Contacta directamente al hotel.",
];

function formatMonto(amount: number, moneda: string): string {
  return moneda === "MXN" ? formatCurrencyMXN(amount) : `${amount.toFixed(2)} ${moneda}`;
}

export function renderReciboPago(data: ReciboPagoData): RenderedEmail {
  const nombreHuesped = escapeHtml(data.nombreHuesped);
  const nombreHotel = escapeHtml(data.nombreHotel);
  const metodo = escapeHtml(data.metodo);
  const folio = escapeHtml(data.folioCodigo);
  const montoFmt = formatMonto(data.monto, data.moneda);
  const fechaFmt = formatDateEsMx(data.fechaPago);

  const subject = `Recibo de tu pago en ${data.nombreHotel}`;
  const preheader = `Confirmamos tu pago de ${montoFmt} en ${data.nombreHotel}.`;

  const referenciaRow = data.referenciaExterna
    ? `<tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Referencia</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${escapeHtml(data.referenciaExterna)}</td></tr>`
    : "";

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola ${nombreHuesped},</p>
    <p style="margin:0 0 20px 0;">Confirmamos que recibimos tu pago en <strong>${nombreHotel}</strong>. Este es tu recibo:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0;border-collapse:collapse;">
      <tr><td bgcolor="#eef3f9" style="padding:18px 20px;border:1px solid #e2e8f0;border-radius:10px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Monto</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;font-weight:600;">${montoFmt}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Método de pago</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${metodo}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Folio</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${folio}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Fecha</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${fechaFmt}</td></tr>
          ${referenciaRow}
        </table>
      </td></tr>
    </table>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "Recibo de tu pago",
    bodyHtml,
    footerLines: FOOTER,
  });

  const textParagraphs = [
    `Hola ${data.nombreHuesped},`,
    `Confirmamos que recibimos tu pago en ${data.nombreHotel}. Recibo:`,
    `Monto: ${montoFmt}`,
    `Método de pago: ${data.metodo}`,
    `Folio: ${data.folioCodigo}`,
    `Fecha: ${fechaFmt}`,
  ];
  if (data.referenciaExterna) textParagraphs.push(`Referencia: ${data.referenciaExterna}`);

  const text = renderEmailText({
    headingText: "Recibo de tu pago",
    bodyParagraphs: textParagraphs,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleReciboPagoData(): ReciboPagoData {
  return {
    nombreHuesped: "Luis Fernando Aguilar",
    nombreHotel: "Hotel Boutique Casa Mérida",
    monto: 5940,
    moneda: "MXN",
    metodo: "Tarjeta de crédito terminada en 4321",
    folioCodigo: "F-2026-00981",
    fechaPago: "2026-10-14",
    referenciaExterna: "auth_9k2m1x",
  };
}
