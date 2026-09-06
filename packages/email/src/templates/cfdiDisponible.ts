// H12a · Plantilla "cfdi-disponible" -- aviso de que el CFDI (factura fiscal timbrada
// ante el SAT) ya está lista para descargar. El UUID fiscal se muestra completo porque
// es el identificador que el huésped/su contador necesita para conciliar la factura --
// nunca lo truncamos.
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import { formatCurrencyMXN } from "../format.ts";
import type { RenderedEmail } from "../port.ts";

export interface CfdiDisponibleData {
  nombreHuesped: string;
  nombreHotel: string;
  uuidFiscal: string;
  descargaUrl: string;
  totalAmount: number;
  moneda: string;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas sobre tu factura? Contacta directamente al hotel.",
];

function formatMonto(amount: number, moneda: string): string {
  return moneda === "MXN" ? formatCurrencyMXN(amount) : `${amount.toFixed(2)} ${moneda}`;
}

export function renderCfdiDisponible(data: CfdiDisponibleData): RenderedEmail {
  const nombreHuesped = escapeHtml(data.nombreHuesped);
  const nombreHotel = escapeHtml(data.nombreHotel);
  const uuid = escapeHtml(data.uuidFiscal);
  const totalFmt = formatMonto(data.totalAmount, data.moneda);

  const subject = `Tu factura (CFDI) de ${data.nombreHotel} ya está disponible`;
  const preheader = `Tu CFDI de ${data.nombreHotel} por ${totalFmt} ya está timbrado y listo.`;

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola ${nombreHuesped},</p>
    <p style="margin:0 0 20px 0;">Tu factura (CFDI) de <strong>${nombreHotel}</strong> ya fue timbrada ante el SAT y está lista para descargar.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0;border-collapse:collapse;">
      <tr><td bgcolor="#eef3f9" style="padding:18px 20px;border:1px solid #e2e8f0;border-radius:10px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Total facturado</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;font-weight:600;">${totalFmt}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">UUID fiscal</td><td style="padding:8px 0;font-size:12px;color:#0f1b2d;word-break:break-all;">${uuid}</td></tr>
        </table>
      </td></tr>
    </table>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "Tu factura ya está disponible",
    bodyHtml,
    ctaLabel: "Descargar mi factura (PDF/XML)",
    ctaUrl: data.descargaUrl,
    footerLines: FOOTER,
  });

  const text = renderEmailText({
    headingText: "Tu factura ya está disponible",
    bodyParagraphs: [
      `Hola ${data.nombreHuesped},`,
      `Tu factura (CFDI) de ${data.nombreHotel} ya fue timbrada ante el SAT y está lista para descargar.`,
      `Total facturado: ${totalFmt}`,
      `UUID fiscal: ${data.uuidFiscal}`,
    ],
    ctaLabel: "Descargar mi factura (PDF/XML)",
    ctaUrl: data.descargaUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleCfdiDisponibleData(): CfdiDisponibleData {
  return {
    nombreHuesped: "Luis Fernando Aguilar",
    nombreHotel: "Hotel Boutique Casa Mérida",
    uuidFiscal: "3F2A9C10-6B4D-4E7A-9F1C-2D8E5A0B7C34",
    descargaUrl: "https://app.useatiende.ai/facturas/F-2026-00981/descargar",
    totalAmount: 5940,
    moneda: "MXN",
  };
}
