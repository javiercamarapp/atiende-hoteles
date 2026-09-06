// H12a · Plantilla "recordatorio-prellegada" -- recordatorio enviado el día antes del
// check-in. Objetivo práctico: que el huésped llegue sabiendo hora y dirección exactas
// (reduce llamadas de "¿a qué hora puedo llegar?" y llegadas fuera de horario).
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import { formatDateEsMx } from "../format.ts";
import type { RenderedEmail } from "../port.ts";

export interface RecordatorioPrellegadaData {
  nombreHuesped: string;
  nombreHotel: string;
  checkIn: string;
  horaCheckIn: string;
  direccionHotel: string;
  telefonoHotel?: string;
  codigoConfirmacion: string;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas sobre tu llegada? Contacta directamente al hotel.",
];

export function renderRecordatorioPrellegada(data: RecordatorioPrellegadaData): RenderedEmail {
  const nombreHuesped = escapeHtml(data.nombreHuesped);
  const nombreHotel = escapeHtml(data.nombreHotel);
  const direccion = escapeHtml(data.direccionHotel);
  const horaCheckIn = escapeHtml(data.horaCheckIn);
  const codigo = escapeHtml(data.codigoConfirmacion);
  const checkInFmt = formatDateEsMx(data.checkIn);

  const subject = `Te esperamos mañana en ${data.nombreHotel}`;
  const preheader = `Tu llegada a ${data.nombreHotel} es el ${checkInFmt} a partir de las ${data.horaCheckIn}.`;

  const telefonoRow = data.telefonoHotel
    ? `<tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Teléfono</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${escapeHtml(data.telefonoHotel)}</td></tr>`
    : "";

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola ${nombreHuesped},</p>
    <p style="margin:0 0 20px 0;">Te esperamos en <strong>${nombreHotel}</strong>. Aquí está el detalle de tu llegada:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 4px 0;border-collapse:collapse;">
      <tr><td bgcolor="#eef3f9" style="padding:18px 20px;border:1px solid #e2e8f0;border-radius:10px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Llegada</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${checkInFmt}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Hora de check-in</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">A partir de las ${horaCheckIn}</td></tr>
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Dirección</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${direccion}</td></tr>
          ${telefonoRow}
          <tr><td style="padding:8px 0;font-size:13px;color:#5b6b82;width:130px;">Confirmación</td><td style="padding:8px 0;font-size:13px;color:#0f1b2d;">${codigo}</td></tr>
        </table>
      </td></tr>
    </table>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: "Te esperamos mañana",
    bodyHtml,
    footerLines: FOOTER,
  });

  const textParagraphs = [
    `Hola ${data.nombreHuesped},`,
    `Te esperamos en ${data.nombreHotel}. Detalle de tu llegada:`,
    `Llegada: ${checkInFmt}`,
    `Hora de check-in: a partir de las ${data.horaCheckIn}`,
    `Dirección: ${data.direccionHotel}`,
  ];
  if (data.telefonoHotel) textParagraphs.push(`Teléfono: ${data.telefonoHotel}`);
  textParagraphs.push(`Confirmación: ${data.codigoConfirmacion}`);

  const text = renderEmailText({
    headingText: "Te esperamos mañana",
    bodyParagraphs: textParagraphs,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleRecordatorioPrellegadaData(): RecordatorioPrellegadaData {
  return {
    nombreHuesped: "Luis Fernando Aguilar",
    nombreHotel: "Hotel Boutique Casa Mérida",
    checkIn: "2026-10-14",
    horaCheckIn: "15:00",
    direccionHotel: "Calle 60 #480, Centro, Mérida, Yucatán",
    telefonoHotel: "+52 999 123 4567",
    codigoConfirmacion: "CM-48213",
  };
}
