// H12a · Plantilla "bienvenida-hotel" -- llega DESPUÉS de verificar el correo
// (verificacionCuenta.ts), cuando la cuenta del hotel ya está activa. Tono cálido pero
// honesto (MARCA.md §1: nunca prometer resultados que el producto no entrega todavía) --
// por eso no dice "vas a vender más" ni cifras inventadas, solo indica los próximos
// pasos concretos de onboarding.
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import type { RenderedEmail } from "../port.ts";

export interface BienvenidaHotelData {
  nombreHotel: string;
  nombreOwner: string;
  panelUrl: string;
  pasosOnboarding: string[];
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas? Escríbenos a soporte@useatiende.ai",
];

export function renderBienvenidaHotel(data: BienvenidaHotelData): RenderedEmail {
  const nombreHotel = escapeHtml(data.nombreHotel);
  const nombreOwner = escapeHtml(data.nombreOwner);
  const subject = `¡Bienvenido a atiende, ${data.nombreHotel}!`;
  const preheader = `Tu cuenta de ${data.nombreHotel} ya está activa. Estos son tus próximos pasos.`;

  const pasosHtml = data.pasosOnboarding
    .map((paso) => `<p style="margin:0 0 8px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#0f1b2d;">&#8226;&nbsp; ${escapeHtml(paso)}</p>`)
    .join("\n");

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola ${nombreOwner},</p>
    <p style="margin:0 0 16px 0;">Tu cuenta de <strong>${nombreHotel}</strong> ya está activa. Todavía no hay nada configurado del lado operativo -- eso lo vamos armando juntos en los próximos días. Por ahora, estos son los pasos que te recomendamos seguir en tu panel:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 22px 0;border-collapse:collapse;">
      <tr><td bgcolor="#eef3f9" style="padding:18px 20px;border:1px solid #e2e8f0;border-radius:10px;">
        ${pasosHtml}
      </td></tr>
    </table>
    <p style="margin:0;">Cualquier duda que te salga en el camino, contáctanos -- preferimos resolver algo pequeño ahora que dejarlo pendiente.</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: `Bienvenido a atiende, ${nombreHotel}`,
    bodyHtml,
    ctaLabel: "Ir a mi panel",
    ctaUrl: data.panelUrl,
    footerLines: FOOTER,
  });

  const text = renderEmailText({
    headingText: `Bienvenido a atiende, ${data.nombreHotel}`,
    bodyParagraphs: [
      `Hola ${data.nombreOwner},`,
      `Tu cuenta de ${data.nombreHotel} ya está activa. Todavía no hay nada configurado del lado operativo -- eso lo vamos armando juntos en los próximos días. Próximos pasos:`,
      ...data.pasosOnboarding.map((p) => `- ${p}`),
      "Cualquier duda que te salga en el camino, contáctanos.",
    ],
    ctaLabel: "Ir a mi panel",
    ctaUrl: data.panelUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleBienvenidaHotelData(): BienvenidaHotelData {
  return {
    nombreHotel: "Hotel Boutique Casa Mérida",
    nombreOwner: "Mariana Cetina",
    panelUrl: "https://app.useatiende.ai/panel",
    pasosOnboarding: [
      "Configura las tarifas y tipos de habitación de tu hotel.",
      "Invita a tu equipo de recepción y reservas.",
      "Conecta tu canal de WhatsApp para recibir reservas.",
    ],
  };
}
