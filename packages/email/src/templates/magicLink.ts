// H12a · Plantilla "magic-link" -- acceso sin contraseña (passwordless). El enlace es
// de un solo uso y de vida corta (minutos, no horas) -- por eso el copy insiste en la
// expiración corta y en que atiende nunca pide este enlace por teléfono/WhatsApp
// (mitigación de ingeniería social, mismo principio que el correo de restablecimiento).
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import type { RenderedEmail } from "../port.ts";

export interface MagicLinkData {
  email: string;
  loginUrl: string;
  expiraMinutos: number;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas? Escríbenos a soporte@useatiende.ai",
];

export function renderMagicLink(data: MagicLinkData): RenderedEmail {
  const email = escapeHtml(data.email);
  const subject = "Tu acceso a atiende hoteles";
  const preheader = "Entra a tu panel sin contraseña -- este enlace es de un solo uso.";

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;">Solicitaste entrar a atiende hoteles con la cuenta <strong>${email}</strong>. Puedes hacerlo sin contraseña dando clic en el botón de abajo.</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "Entra sin contraseña",
    bodyHtml,
    ctaLabel: "Entrar a atiende hoteles",
    ctaUrl: data.loginUrl,
    noteHtml: `Este enlace es de un solo uso y expira en ${data.expiraMinutos} minutos. Atiende nunca te va a pedir este enlace por teléfono o WhatsApp -- si alguien te lo pide, no se lo compartas.`,
    footerLines: FOOTER,
  });

  const text = renderEmailText({
    headingText: "Entra sin contraseña",
    bodyParagraphs: [
      `Solicitaste entrar a atiende hoteles con la cuenta ${data.email}. Puedes hacerlo sin contraseña con el enlace de abajo.`,
      `Este enlace es de un solo uso y expira en ${data.expiraMinutos} minutos. Atiende nunca te va a pedir este enlace por teléfono o WhatsApp -- si alguien te lo pide, no se lo compartas.`,
    ],
    ctaLabel: "Entrar a atiende hoteles",
    ctaUrl: data.loginUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleMagicLinkData(): MagicLinkData {
  return {
    email: "reservaciones@casamerida.mx",
    loginUrl: "https://app.useatiende.ai/entrar?token=f6e5d4c3b2a1",
    expiraMinutos: 15,
  };
}
