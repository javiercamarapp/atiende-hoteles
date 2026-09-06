// H12a · Plantilla "verificacion-cuenta" -- correo de activación de cuenta al dar de
// alta un hotel nuevo (flujo de registro). Sin este correo confirmado, la cuenta queda
// en estado "pendiente de verificar" (ver dominio de auth) -- por eso el copy es
// explícito sobre que falta ESTE paso, no una bienvenida completa (esa es
// bienvenidaHotel.ts, que llega después de verificar).
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import type { RenderedEmail } from "../port.ts";

export interface VerificacionCuentaData {
  nombreHotel: string;
  nombreOwner: string;
  verificationUrl: string;
  expiraHoras: number;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas? Escríbenos a soporte@useatiende.ai",
];

export function renderVerificacionCuenta(data: VerificacionCuentaData): RenderedEmail {
  const nombreHotel = escapeHtml(data.nombreHotel);
  const nombreOwner = escapeHtml(data.nombreOwner);
  const subject = "Confirma tu correo para activar tu hotel en atiende";
  const preheader = `Falta un paso para activar ${data.nombreHotel} en atiende hoteles.`;

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola ${nombreOwner},</p>
    <p style="margin:0 0 16px 0;">Gracias por dar de alta <strong>${nombreHotel}</strong> en atiende hoteles. Antes de que puedas entrar a tu panel, necesitamos confirmar que este correo es tuyo -- es el último paso para activar la cuenta.</p>
    <p style="margin:0;">Da clic en el botón de abajo para confirmarlo.</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "Confirma tu correo para activar tu cuenta",
    bodyHtml,
    ctaLabel: "Confirmar mi correo",
    ctaUrl: data.verificationUrl,
    noteHtml: `Este enlace expira en ${data.expiraHoras} horas. Si tú no diste de alta esta cuenta, puedes ignorar este correo -- no se activará nada sin confirmarlo.`,
    footerLines: FOOTER,
  });

  const text = renderEmailText({
    headingText: "Confirma tu correo para activar tu cuenta",
    bodyParagraphs: [
      `Hola ${data.nombreOwner},`,
      `Gracias por dar de alta ${data.nombreHotel} en atiende hoteles. Antes de que puedas entrar a tu panel, necesitamos confirmar que este correo es tuyo -- es el último paso para activar la cuenta.`,
      `Este enlace expira en ${data.expiraHoras} horas. Si tú no diste de alta esta cuenta, puedes ignorar este correo -- no se activará nada sin confirmarlo.`,
    ],
    ctaLabel: "Confirmar mi correo",
    ctaUrl: data.verificationUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleVerificacionCuentaData(): VerificacionCuentaData {
  return {
    nombreHotel: "Hotel Boutique Casa Mérida",
    nombreOwner: "Mariana Cetina",
    verificationUrl: "https://app.useatiende.ai/verificar-correo?token=a1b2c3d4e5",
    expiraHoras: 24,
  };
}
