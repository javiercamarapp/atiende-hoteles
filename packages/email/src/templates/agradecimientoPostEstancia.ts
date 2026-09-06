// H12a · Plantilla "agradecimiento-poststay" -- correo post-estancia. MARCA.md §1: pedir
// una reseña sincera, nunca pedir explícitamente "5 estrellas" ni condicionar nada a
// cambio de la reseña (eso es manipulación de reputación, no lo hacemos).
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import type { RenderedEmail } from "../port.ts";

export interface AgradecimientoPostEstanciaData {
  nombreHuesped: string;
  nombreHotel: string;
  reviewUrl: string;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas? Escríbenos a soporte@useatiende.ai",
];

export function renderAgradecimientoPostEstancia(data: AgradecimientoPostEstanciaData): RenderedEmail {
  const nombreHuesped = escapeHtml(data.nombreHuesped);
  const nombreHotel = escapeHtml(data.nombreHotel);
  const subject = `Gracias por hospedarte en ${data.nombreHotel}`;
  const preheader = `Gracias por elegir ${data.nombreHotel}. Nos encantaría conocer tu opinión.`;

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola ${nombreHuesped},</p>
    <p style="margin:0 0 16px 0;">Gracias por hospedarte en <strong>${nombreHotel}</strong>. Esperamos que tu estancia haya sido cómoda.</p>
    <p style="margin:0;">Si tienes un minuto, nos ayudaría mucho que compartieras tu opinión sincera -- lo que salió bien y lo que podemos mejorar. La usamos de verdad para ajustar cosas del hotel.</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "Gracias por tu visita",
    bodyHtml,
    ctaLabel: "Dejar una reseña",
    ctaUrl: data.reviewUrl,
    footerLines: FOOTER,
  });

  const text = renderEmailText({
    headingText: "Gracias por tu visita",
    bodyParagraphs: [
      `Hola ${data.nombreHuesped},`,
      `Gracias por hospedarte en ${data.nombreHotel}. Esperamos que tu estancia haya sido cómoda.`,
      "Si tienes un minuto, nos ayudaría mucho que compartieras tu opinión sincera -- lo que salió bien y lo que podemos mejorar.",
    ],
    ctaLabel: "Dejar una reseña",
    ctaUrl: data.reviewUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleAgradecimientoPostEstanciaData(): AgradecimientoPostEstanciaData {
  return {
    nombreHuesped: "Luis Fernando Aguilar",
    nombreHotel: "Hotel Boutique Casa Mérida",
    reviewUrl: "https://app.useatiende.ai/resenas/nueva?reserva=CM-48213",
  };
}
