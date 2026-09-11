// H12a · Registro central de las 13 plantillas de correo. `TEMPLATES` es el punto único
// que otros paquetes (apps/api, scripts/preview.ts) usan para resolver una plantilla por
// su slug -- el slug ES el string que se guarda en `EmailMessage.template`/
// `email_outbox.template`, así que nunca debe cambiar sin coordinar una migración de
// datos. `unknown` (no `any`) en la firma genérica de `TEMPLATES` porque cada plantilla
// tiene su propio tipo de datos concreto -- el registro solo necesita saber que
// `render`/`sample` son funciones compatibles, el llamador siempre conoce el slug
// concreto que está usando y por lo tanto el tipo real de los datos.
import type { RenderedEmail } from "../port.ts";

import { renderVerificacionCuenta, sampleVerificacionCuentaData } from "./verificacionCuenta.ts";
import { renderMagicLink, sampleMagicLinkData } from "./magicLink.ts";
import { renderBienvenidaHotel, sampleBienvenidaHotelData } from "./bienvenidaHotel.ts";
import { renderInvitacionStaff, sampleInvitacionStaffData } from "./invitacionStaff.ts";
import { renderRestablecerContrasena, sampleRestablecerContrasenaData } from "./restablecerContrasena.ts";
import { renderCambioCorreo, sampleCambioCorreoData } from "./cambioCorreo.ts";
import { renderConfirmacionReserva, sampleConfirmacionReservaData } from "./confirmacionReserva.ts";
import { renderRecordatorioPrellegada, sampleRecordatorioPrellegadaData } from "./recordatorioPrellegada.ts";
import { renderAgradecimientoPostEstancia, sampleAgradecimientoPostEstanciaData } from "./agradecimientoPostEstancia.ts";
import { renderReciboPago, sampleReciboPagoData } from "./reciboPago.ts";
import { renderCfdiDisponible, sampleCfdiDisponibleData } from "./cfdiDisponible.ts";
import { renderProspeccionComercial, sampleProspeccionComercialData } from "./prospeccionComercial.ts";
import { renderCotizacionAbandonada, sampleCotizacionAbandonadaData } from "./cotizacionAbandonada.ts";

export interface TemplateEntry {
  etiqueta: string;
  render: (data: unknown) => RenderedEmail;
  sample: () => unknown;
}

/** Envuelve un par `render`/`sample` fuertemente tipado como una entrada de `unknown`
 *  del registro -- el cast es seguro porque `render` y `sample` de una misma plantilla
 *  siempre se usan juntos (nunca se mezcla el `sample()` de una plantilla con el
 *  `render()` de otra). */
function entry<T>(etiqueta: string, render: (data: T) => RenderedEmail, sample: () => T): TemplateEntry {
  return {
    etiqueta,
    render: render as (data: unknown) => RenderedEmail,
    sample: sample as () => unknown,
  };
}

export const TEMPLATES: Record<string, TemplateEntry> = {
  "verificacion-cuenta": entry("Verificación de cuenta", renderVerificacionCuenta, sampleVerificacionCuentaData),
  "magic-link": entry("Acceso sin contraseña", renderMagicLink, sampleMagicLinkData),
  "bienvenida-hotel": entry("Bienvenida al hotel", renderBienvenidaHotel, sampleBienvenidaHotelData),
  "invitacion-staff": entry("Invitación de staff", renderInvitacionStaff, sampleInvitacionStaffData),
  "restablecer-contrasena": entry("Restablecer contraseña", renderRestablecerContrasena, sampleRestablecerContrasenaData),
  "cambio-correo": entry("Confirmación de cambio de correo", renderCambioCorreo, sampleCambioCorreoData),
  "confirmacion-reserva": entry("Confirmación de reserva", renderConfirmacionReserva, sampleConfirmacionReservaData),
  "recordatorio-prellegada": entry("Recordatorio de pre-llegada", renderRecordatorioPrellegada, sampleRecordatorioPrellegadaData),
  "agradecimiento-poststay": entry("Agradecimiento post-estancia", renderAgradecimientoPostEstancia, sampleAgradecimientoPostEstanciaData),
  "recibo-pago": entry("Recibo de pago", renderReciboPago, sampleReciboPagoData),
  "cfdi-disponible": entry("CFDI disponible", renderCfdiDisponible, sampleCfdiDisponibleData),
  "prospeccion-comercial": entry("Prospección comercial", renderProspeccionComercial, sampleProspeccionComercialData),
  "cotizacion-abandonada": entry("Cotización abandonada", renderCotizacionAbandonada, sampleCotizacionAbandonadaData),
};
