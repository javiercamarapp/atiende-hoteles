// H12a · Plantilla "invitacion-staff" -- invitación a un miembro de staff a unirse a un
// hotel con un rol específico. `rolAsignado` puede llegar como el slug interno del
// sistema (owner/gm/frontdesk/...) o ya legible -- ROLE_LABELS lo traduce cuando
// coincide con un slug conocido y si no, se muestra tal cual (siempre escapado).
import { renderEmailLayout, renderEmailText, escapeHtml } from "../layout.ts";
import type { RenderedEmail } from "../port.ts";

export interface InvitacionStaffData {
  nombreHotel: string;
  nombreQuienInvita: string;
  rolAsignado: string;
  invitationUrl: string;
  expiraDias: number;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Propietario",
  gm: "Gerente general",
  frontdesk: "Recepción",
  reservations: "Reservas",
  housekeeping: "Ama de llaves",
  maintenance: "Mantenimiento",
  fnb: "Alimentos y bebidas",
  accountant: "Contabilidad",
};

function roleLabel(rol: string): string {
  return ROLE_LABELS[rol] ?? rol;
}

const FOOTER = [
  "atiende hoteles&nbsp;&nbsp;&#183;&nbsp;&nbsp;Software de operación hotelera",
  "¿Dudas? Escríbenos a soporte@useatiende.ai",
];

export function renderInvitacionStaff(data: InvitacionStaffData): RenderedEmail {
  const nombreHotel = escapeHtml(data.nombreHotel);
  const nombreQuienInvita = escapeHtml(data.nombreQuienInvita);
  const rol = escapeHtml(roleLabel(data.rolAsignado));
  const subject = `${data.nombreQuienInvita} te invitó a ${data.nombreHotel} en atiende`;
  const preheader = `Únete al equipo de ${data.nombreHotel} en atiende hoteles como ${roleLabel(data.rolAsignado)}.`;

  const bodyHtml = `
    <p style="margin:0 0 16px 0;">Hola,</p>
    <p style="margin:0 0 16px 0;"><strong>${nombreQuienInvita}</strong> te invitó a unirte al equipo de <strong>${nombreHotel}</strong> en atiende hoteles con el rol de <strong>${rol}</strong>.</p>
    <p style="margin:0;">Da clic en el botón de abajo para aceptar la invitación y crear tu acceso.</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader,
    headingHtml: `Te invitaron a ${nombreHotel}`,
    bodyHtml,
    ctaLabel: "Aceptar invitación",
    ctaUrl: data.invitationUrl,
    noteHtml: `Esta invitación expira en ${data.expiraDias} días. Si no esperabas este correo, puedes ignorarlo.`,
    footerLines: FOOTER,
  });

  const text = renderEmailText({
    headingText: `Te invitaron a ${data.nombreHotel}`,
    bodyParagraphs: [
      `${data.nombreQuienInvita} te invitó a unirte al equipo de ${data.nombreHotel} en atiende hoteles con el rol de ${roleLabel(data.rolAsignado)}.`,
      `Esta invitación expira en ${data.expiraDias} días. Si no esperabas este correo, puedes ignorarlo.`,
    ],
    ctaLabel: "Aceptar invitación",
    ctaUrl: data.invitationUrl,
    footerLines: FOOTER,
  });

  return { subject, preheader, html, text };
}

export function sampleInvitacionStaffData(): InvitacionStaffData {
  return {
    nombreHotel: "Hotel Boutique Casa Mérida",
    nombreQuienInvita: "Mariana Cetina",
    rolAsignado: "frontdesk",
    invitationUrl: "https://app.useatiende.ai/invitacion?token=9f8e7d6c5b",
    expiraDias: 7,
  };
}
