// H12a · Layout HTML compartido por TODAS las plantillas -- reproduce 1:1 el sistema
// visual de atiende-restaurantes (docs/correo-auth/magic-link.html,
// docs/correo-auth/cambio-de-correo.html, docs/correo-ventas/prospeccion.html de
// atiende-restaurantes): tabla ancho fijo 600px, fondo #f7f9fc, tarjeta blanca con
// borde #e2e8f0 y radio 16px, wordmark "atiende" en texto (nunca imagen -- Gmail
// bloquea imágenes externas por default, y no dependemos de tener ya un dominio público
// donde alojar un logo), tipografía Inter/Inter Tight con fallback de sistema, azul de
// marca #1D4ED8 para el botón de acción. HTML con estilos inline y tablas
// `role="presentation"` (compatibilidad real con Outlook/Gmail/Apple Mail -- flexbox/
// grid/CSS externo NO se renderizan de forma confiable en clientes de correo).
//
// `escapeHtml()` es OBLIGATORIO para cualquier dato que venga de un huésped/staff (p.
// ej. nombre del huésped, nota de una reserva) antes de interpolarlo en `bodyHtml` --
// las plantillas nunca deben construir HTML crudo desde un campo de entrada externo sin
// pasarlo por aquí (pruebas unitarias de packages/email verifican esto).

const FONT_STACK = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const FONT_STACK_DISPLAY = "'Inter Tight',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
export const BRAND_BLUE = "#1D4ED8";
const INK = "#0f1b2d";
const MUTED = "#5b6b82";
const BORDER = "#e2e8f0";
const BG = "#f7f9fc";
const NOTE_BG = "#eef3f9";

/** Escapa los 5 caracteres HTML peligrosos -- suficiente para interpolar texto dentro
 *  de un nodo (nunca dentro de un atributo sin comillas ni de una URL). Ninguna
 *  plantilla debe usar `dangerouslySetInnerHTML`-equivalente con datos externos. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Preheader oculto (el texto de vista previa que Gmail/Outlook muestran junto al
 *  asunto en la bandeja) -- se rellena con caracteres invisibles para evitar que el
 *  cliente de correo use el primer texto visible del cuerpo como vista previa. */
function hiddenPreheader(text: string): string {
  const filler = "&nbsp;&zwnj;".repeat(40);
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(text)}${filler}</div>`;
}

export interface EmailLayoutOptions {
  title: string;
  preheader: string;
  /** HTML del título dentro de la tarjeta (H1) -- ya debe venir escapado si contiene
   *  datos externos; casi siempre es texto de copy fijo, no un dato de usuario. */
  headingHtml: string;
  /** HTML del cuerpo (párrafos, listas, tablas de detalle) -- YA renderizado por la
   *  plantilla, que es responsable de haber llamado `escapeHtml()` sobre cualquier dato
   *  externo antes de interpolarlo aquí. */
  bodyHtml: string;
  ctaLabel?: string;
  ctaUrl?: string;
  /** Bloque gris de nota/advertencia bajo el CTA (p. ej. "si no fuiste tú, ignora este
   *  correo"). */
  noteHtml?: string;
  /** Enlace de baja (REQ-LAUNCH: obligatorio en correo de marketing/prospección,
   *  opcional en transaccional). */
  unsubscribeUrl?: string;
  footerLines: string[];
  kicker?: string;
}

export function renderEmailLayout(opts: EmailLayoutOptions): string {
  const cta =
    opts.ctaLabel && opts.ctaUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 4px 0;">
        <tr><td bgcolor="${BRAND_BLUE}" style="border-radius:999px;">
          <a href="${opts.ctaUrl}" style="display:inline-block;padding:13px 26px;font-family:${FONT_STACK};font-size:14px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(opts.ctaLabel)}</a>
        </td></tr>
      </table>
      <p style="margin:24px 0 0 0;font-family:${FONT_STACK};font-size:11.5px;line-height:18px;color:${MUTED};">¿El botón no abre? Copia esta liga en tu navegador:<br>
        <span style="word-break:break-all;">${opts.ctaUrl}</span></p>`
      : "";

  const note = opts.noteHtml
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:26px 0 0 0;border-collapse:collapse;">
        <tr><td bgcolor="${NOTE_BG}" style="padding:15px 18px;border:1px solid ${BORDER};border-radius:10px;font-family:${FONT_STACK};font-size:12px;line-height:19px;color:${MUTED};">${opts.noteHtml}</td></tr>
      </table>`
    : "";

  const kicker = opts.kicker
    ? `<p style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND_BLUE};">${escapeHtml(opts.kicker)}</p>`
    : "";

  const unsubscribe = opts.unsubscribeUrl
    ? `<p style="margin:6px 0 0 0;font-family:${FONT_STACK};font-size:11px;line-height:18px;color:${MUTED};"><a href="${opts.unsubscribeUrl}" style="color:${MUTED};text-decoration:underline;">Dejar de recibir este tipo de correo</a></p>`
    : "";

  const footerLines = opts.footerLines
    .map((line, i) => `<p style="margin:0 0 ${i === 0 ? 7 : 5}px 0;font-family:${FONT_STACK};font-size:11px;line-height:18px;${i === 0 ? "font-weight:600;letter-spacing:0.08em;text-transform:uppercase;" : ""}color:${MUTED};">${line}</p>`)
    .join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BG};">
${hiddenPreheader(opts.preheader)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BG};">
  <tr><td align="center" style="padding:44px 16px 36px 16px;">
    <!-- width="100%"/style width:100% + max-width:600px (no width="600" fijo): con un
    ancho HTML fijo el algoritmo de "auto table layout" propaga ese mínimo de contenido
    hacia arriba y la tabla NUNCA se encoge en pantallas angostas (detectado al revisar
    las capturas de preview.ts en 375px -- desbordaba a ~632px). Con base fluida al 100%
    y tope en max-width, se ve a 600px en desktop y se encoge de verdad en móvil. -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:600px;border-collapse:collapse;">

      <tr><td align="left" style="padding:0 0 26px 2px;">
        <span style="font-family:${FONT_STACK_DISPLAY};font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${BRAND_BLUE};">atiende</span>
        <span style="font-family:${FONT_STACK};font-size:12px;color:${MUTED};"> · hoteles</span>
      </td></tr>

      <tr><td bgcolor="#ffffff" style="padding:42px 44px 38px 44px;border:1px solid ${BORDER};border-radius:16px;">
        ${kicker}
        <h1 style="margin:0 0 18px 0;font-family:${FONT_STACK_DISPLAY};font-size:26px;line-height:34px;font-weight:600;letter-spacing:-0.02em;color:${INK};">${opts.headingHtml}</h1>
        <div style="font-family:${FONT_STACK};font-size:15px;line-height:24px;color:${MUTED};">${opts.bodyHtml}</div>
        ${cta}
        ${note}
      </td></tr>

      <tr><td align="left" style="padding:26px 6px 0 6px;">
        ${footerLines}
        ${unsubscribe}
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export interface EmailTextOptions {
  headingText: string;
  bodyParagraphs: string[];
  ctaLabel?: string;
  ctaUrl?: string;
  footerLines: string[];
}

/** Versión texto plano -- obligatoria en todo mensaje (REQ-LAUNCH): algunos clientes de
 *  correo/lectores de pantalla la prefieren, y mejora la entregabilidad (un mensaje
 *  solo-HTML puntúa peor contra filtros de spam). */
export function renderEmailText(opts: EmailTextOptions): string {
  const lines: string[] = [opts.headingText, ""];
  for (const p of opts.bodyParagraphs) lines.push(p, "");
  if (opts.ctaLabel && opts.ctaUrl) {
    lines.push(`${opts.ctaLabel}: ${opts.ctaUrl}`, "");
  }
  lines.push("---", ...opts.footerLines);
  return lines.join("\n");
}
