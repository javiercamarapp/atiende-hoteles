// H12a · Plantilla "cambio-correo" -- confirmación de cambio de correo de la cuenta.
// A diferencia de restablecerContrasena.ts, aquí la nota de seguridad es más fuerte
// ("contacta a soporte de inmediato") porque un cambio de correo no solicitado suele ser
// señal de que alguien está intentando tomar la cuenta, no solo un error del usuario.
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import type { RenderedEmail } from "../port.ts";

export interface CambioCorreoData {
  correoAnterior: string;
  correoNuevo: string;
  confirmUrl: string;
  expiraHoras: number;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas? Escríbenos a soporte@useatiende.ai",
];

export function renderCambioCorreo(data: CambioCorreoData): RenderedEmail {
  const correoAnterior = escapeHtml(data.correoAnterior);
  const correoNuevo = escapeHtml(data.correoNuevo);
  const subject = "Confirma tu nuevo correo en atiende hoteles";
  const preheader = `Confirma el cambio de correo de tu cuenta a ${data.correoNuevo}.`;

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;">Recibimos una solicitud para cambiar el correo de tu cuenta de <strong>${correoAnterior}</strong> a <strong>${correoNuevo}</strong>.</p>
    <p style="margin:0;">Para confirmar este cambio, da clic en el botón de abajo.</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "Confirma tu nuevo correo",
    bodyHtml,
    ctaLabel: "Confirmar nuevo correo",
    ctaUrl: data.confirmUrl,
    noteHtml: `Este enlace expira en ${data.expiraHoras} horas. Si tú no pediste este cambio, contacta a soporte de inmediato -- alguien más podría estar intentando tomar el control de tu cuenta.`,
    footerLines: FOOTER,
  });

  const text = renderEmailText({
    headingText: "Confirma tu nuevo correo",
    bodyParagraphs: [
      `Recibimos una solicitud para cambiar el correo de tu cuenta de ${data.correoAnterior} a ${data.correoNuevo}.`,
      `Este enlace expira en ${data.expiraHoras} horas. Si tú no pediste este cambio, contacta a soporte de inmediato -- alguien más podría estar intentando tomar el control de tu cuenta.`,
    ],
    ctaLabel: "Confirmar nuevo correo",
    ctaUrl: data.confirmUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleCambioCorreoData(): CambioCorreoData {
  return {
    correoAnterior: "reservaciones@casamerida.mx",
    correoNuevo: "administracion@casamerida.mx",
    confirmUrl: "https://app.useatiende.ai/confirmar-correo?token=5c4b3a2d1e",
    expiraHoras: 24,
  };
}
