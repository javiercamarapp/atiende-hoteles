// H12a · Plantilla "prospeccion-comercial" -- correo B2B frío, estructura inspirada en
// docs/correo-ventas/prospeccion.html de atiende-restaurantes pero adaptado a hoteles
// (gancho de reservas/recepción por WhatsApp + IA). MARCA.md §1: nada de cifras de ROI
// sin fuente ("ahorra 90%") -- solo lenguaje honesto tipo "puede ayudar a reducir tiempo
// de respuesta". `unsubscribeUrl` es OBLIGATORIO aquí (REQ-LAUNCH, correo de marketing) --
// por eso este es el único template que siempre pasa `unsubscribeUrl` a la capa.
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import type { RenderedEmail } from "../port.ts";

export interface ProspeccionComercialData {
  nombreDestinatario: string;
  nombreHotel: string;
  agendarUrl: string;
  unsubscribeUrl: string;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Reservas y recepción con IA para hoteles independientes",
  "Javier Cámara &#183; ventas@useatiende.ai",
];

export function renderProspeccionComercial(data: ProspeccionComercialData): RenderedEmail {
  const nombreDestinatario = escapeHtml(data.nombreDestinatario);
  const nombreHotel = escapeHtml(data.nombreHotel);
  const subject = `Cómo ${data.nombreHotel} podría automatizar reservas y recepción con IA`;
  const preheader = `Un agente que contesta el teléfono y el WhatsApp de ${data.nombreHotel} y toma la reserva solo.`;

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola ${nombreDestinatario},</p>
    <p style="margin:0 0 16px 0;">Soy Javier, de atiende. Construimos un agente de inteligencia artificial que contesta el teléfono y el WhatsApp de un hotel, resuelve dudas de disponibilidad y tarifas, y toma la reserva completa -- sin que nadie de recepción tenga que soltar lo que está haciendo para contestar.</p>
    <p style="margin:0 0 16px 0;">Le escribo porque creo que a <strong>${nombreHotel}</strong> le puede ayudar a reducir el tiempo de respuesta a huéspedes, sobre todo en las horas donde más llamadas y mensajes llegan al mismo tiempo que la recepción está ocupada con check-in/check-out.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:22px 0 22px 0;border-collapse:collapse;">
      <tr><td bgcolor="#eef3f9" style="padding:18px 20px;border:1px solid #e2e8f0;border-radius:10px;">
        <p style="margin:0 0 8px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#0f1b2d;">&#8226;&nbsp; Contesta llamadas y WhatsApp al mismo tiempo, sin que el huésped espere.</p>
        <p style="margin:0 0 8px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#0f1b2d;">&#8226;&nbsp; La disponibilidad y la tarifa se consultan siempre desde su sistema real -- el agente nunca las inventa.</p>
        <p style="margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#0f1b2d;">&#8226;&nbsp; La reserva llega a un panel donde su equipo la ve y la confirma -- como si la hubiera tomado una persona.</p>
      </td></tr>
    </table>
    <p style="margin:0;">¿Le late que agendemos 15 minutos para mostrarle cómo suena una llamada real tomando una reserva de su propio hotel?</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "¿Cuánta reserva se les va porque nadie contestó a tiempo?",
    bodyHtml,
    ctaLabel: "Agendar 15 minutos",
    ctaUrl: data.agendarUrl,
    noteHtml: "Si prefieres, contéstame directo a este correo y ahí coordinamos.",
    unsubscribeUrl: data.unsubscribeUrl,
    footerLines: FOOTER,
  });

  const text = renderEmailText({
    headingText: "¿Cuánta reserva se les va porque nadie contestó a tiempo?",
    bodyParagraphs: [
      `Hola ${data.nombreDestinatario},`,
      "Soy Javier, de atiende. Construimos un agente de inteligencia artificial que contesta el teléfono y el WhatsApp de un hotel, resuelve dudas de disponibilidad y tarifas, y toma la reserva completa -- sin que nadie de recepción tenga que soltar lo que está haciendo para contestar.",
      `Le escribo porque creo que a ${data.nombreHotel} le puede ayudar a reducir el tiempo de respuesta a huéspedes, sobre todo en horas de alta ocupación de recepción.`,
      "¿Le late que agendemos 15 minutos para mostrarle cómo suena una llamada real tomando una reserva de su propio hotel?",
      "Si prefiere, contésteme directo a este correo y ahí coordinamos.",
      `Dejar de recibir este tipo de correo: ${data.unsubscribeUrl}`,
    ],
    ctaLabel: "Agendar 15 minutos",
    ctaUrl: data.agendarUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleProspeccionComercialData(): ProspeccionComercialData {
  return {
    nombreDestinatario: "Roberto Peón",
    nombreHotel: "Hotel Hacienda San Ignacio",
    agendarUrl: "https://cal.com/useatiende/demo-hoteles",
    unsubscribeUrl: "https://useatiende.ai/baja?correo=roberto%40haciendasanignacio.mx",
  };
}
