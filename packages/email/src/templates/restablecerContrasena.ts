// H12a · Plantilla "restablecer-contrasena" -- flujo estándar de recuperación de
// contraseña. Nota de seguridad explícita ("si no lo pediste, tu contraseña sigue
// siendo la misma") para evitar pánico y dejar claro que solicitar el correo NO cambia
// nada por sí solo -- el cambio real ocurre hasta que se completa el flujo en `resetUrl`.
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import type { RenderedEmail } from "../port.ts";

export interface RestablecerContrasenaData {
  email: string;
  resetUrl: string;
  expiraHoras: number;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas? Escríbenos a soporte@useatiende.ai",
];

export function renderRestablecerContrasena(data: RestablecerContrasenaData): RenderedEmail {
  const email = escapeHtml(data.email);
  const subject = "Restablece tu contraseña de atiende hoteles";
  const preheader = "Recibimos una solicitud para restablecer tu contraseña.";

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;">Recibimos una solicitud para restablecer la contraseña de la cuenta <strong>${email}</strong> en atiende hoteles.</p>
    <p style="margin:0;">Da clic en el botón de abajo para elegir una contraseña nueva.</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "Restablece tu contraseña",
    bodyHtml,
    ctaLabel: "Elegir nueva contraseña",
    ctaUrl: data.resetUrl,
    noteHtml: `Este enlace expira en ${data.expiraHoras} horas. Si no lo pediste, ignora este correo -- tu contraseña sigue siendo la misma.`,
    footerLines: FOOTER,
  });

  const text = renderEmailText({
    headingText: "Restablece tu contraseña",
    bodyParagraphs: [
      `Recibimos una solicitud para restablecer la contraseña de la cuenta ${data.email} en atiende hoteles.`,
      `Este enlace expira en ${data.expiraHoras} horas. Si no lo pediste, ignora este correo -- tu contraseña sigue siendo la misma.`,
    ],
    ctaLabel: "Elegir nueva contraseña",
    ctaUrl: data.resetUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleRestablecerContrasenaData(): RestablecerContrasenaData {
  return {
    email: "reservaciones@casamerida.mx",
    resetUrl: "https://app.useatiende.ai/restablecer?token=1a2b3c4d5e",
    expiraHoras: 2,
  };
}
