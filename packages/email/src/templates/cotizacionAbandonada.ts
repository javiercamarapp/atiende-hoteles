// REQ-RES-011 · Plantilla "cotizacion-abandonada" -- contacto al huésped cuando una
// cotización del motor propio (`reservation.status = 'cotizada'`) sigue sin confirmarse
// al alcanzar una de las 3 ventanas de abandono (10 min, 2h, 24h,
// `@atiende-hoteles/domain-hotel::QUOTE_ABANDONMENT_WINDOWS`). `ofertaNoMonetaria` viene
// SIEMPRE de ese catálogo (nunca se redacta aquí ni en el llamador) -- el REQ es
// explícito: "ofreciendo ayuda o un incentivo NO MONETARIO", así que esta plantilla
// nunca acepta ni renderiza un descuento de precio.
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import { formatCurrencyMXN, formatDateEsMx } from "../format.ts";
import type { RenderedEmail } from "../port.ts";

export interface CotizacionAbandonadaData {
  nombreHuesped: string;
  nombreHotel: string;
  checkIn: string;
  checkOut: string;
  tipoHabitacion: string;
  totalAmount: number;
  moneda: string;
  /** Etiqueta legible de la ventana ("10 minutos"/"2 horas"/"24 horas") -- viene de
   *  `QuoteAbandonmentWindow.etiqueta`, nunca se recalcula aquí. */
  ventanaEtiqueta: string;
  /** Texto de la oferta no monetaria de ESA ventana -- viene de
   *  `QuoteAbandonmentWindow.ofertaNoMonetaria`. */
  ofertaNoMonetaria: string;
  verUrl?: string;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "Si ya no te interesa esta cotización, puedes ignorar este mensaje.",
];

function formatMonto(amount: number, moneda: string): string {
  return moneda === "MXN" ? formatCurrencyMXN(amount) : `${amount.toFixed(2)} ${moneda}`;
}

export function renderCotizacionAbandonada(data: CotizacionAbandonadaData): RenderedEmail {
  const nombreHuesped = escapeHtml(data.nombreHuesped);
  const nombreHotel = escapeHtml(data.nombreHotel);
  const tipoHabitacion = escapeHtml(data.tipoHabitacion);
  const oferta = escapeHtml(data.ofertaNoMonetaria);
  const checkInFmt = formatDateEsMx(data.checkIn);
  const checkOutFmt = formatDateEsMx(data.checkOut);
  const totalFmt = formatMonto(data.totalAmount, data.moneda);

  const subject = `¿Seguimos con tu reserva en ${data.nombreHotel}?`;
  const preheader = `Tu cotización del ${checkInFmt} al ${checkOutFmt} en ${data.nombreHotel} sigue disponible.`;

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola ${nombreHuesped},</p>
    <p style="margin:0 0 20px 0;">Notamos que tu cotización en <strong>${nombreHotel}</strong> quedó sin confirmar. Aquí está el detalle:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px 0;border-collapse:collapse;">
      <tr><td bgcolor="#eef3f9" style="padding:18px 20px;border:1px solid #e2e8f0;border-radius:10px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Llegada</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${checkInFmt}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Salida</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${checkOutFmt}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Habitación</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${tipoHabitacion}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Total estimado</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;font-weight:600;">${totalFmt}</td></tr>
        </table>
      </td></tr>
    </table>
    <p style="margin:0;">${oferta}</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "¿Seguimos con tu reserva?",
    bodyHtml,
    ctaLabel: data.verUrl ? "Retomar mi reserva" : undefined,
    ctaUrl: data.verUrl,
    footerLines: FOOTER,
  });

  const textParagraphs = [
    `Hola ${data.nombreHuesped},`,
    `Notamos que tu cotización en ${data.nombreHotel} quedó sin confirmar. Detalle:`,
    `Llegada: ${checkInFmt}`,
    `Salida: ${checkOutFmt}`,
    `Habitación: ${data.tipoHabitacion}`,
    `Total estimado: ${totalFmt}`,
    data.ofertaNoMonetaria,
  ];

  const text = renderEmailText({
    headingText: "¿Seguimos con tu reserva?",
    bodyParagraphs: textParagraphs,
    ctaLabel: data.verUrl ? "Retomar mi reserva" : undefined,
    ctaUrl: data.verUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleCotizacionAbandonadaData(): CotizacionAbandonadaData {
  return {
    nombreHuesped: "Luis Fernando Aguilar",
    nombreHotel: "Hotel Boutique Casa Mérida",
    checkIn: "2026-10-14",
    checkOut: "2026-10-17",
    tipoHabitacion: "Habitación Doble Superior",
    totalAmount: 5940,
    moneda: "MXN",
    ventanaEtiqueta: "2 horas",
    ofertaNoMonetaria:
      "Tu cotización sigue disponible. Si algo te detuvo (método de pago, fechas, tipo de habitación), contáctanos y lo resolvemos contigo directamente.",
  };
}
