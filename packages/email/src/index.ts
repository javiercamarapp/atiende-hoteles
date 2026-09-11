// H12a · Punto de entrada público de @atiende-hoteles/email -- re-exporta el puerto, el
// sistema visual compartido, el formato, los 3 adaptadores de envío y las 13 plantillas
// (funciones `render*`/`sample*` y sus tipos `*Data`), más el registro `TEMPLATES`.
export * from "./port.ts";
export * from "./layout.ts";
export * from "./format.ts";

export * from "./adapters/resendAdapter.ts";
export * from "./adapters/smtpAdapter.ts";
export * from "./adapters/fakeEmailAdapter.ts";

export * from "./templates/verificacionCuenta.ts";
export * from "./templates/magicLink.ts";
export * from "./templates/bienvenidaHotel.ts";
export * from "./templates/invitacionStaff.ts";
export * from "./templates/restablecerContrasena.ts";
export * from "./templates/cambioCorreo.ts";
export * from "./templates/confirmacionReserva.ts";
export * from "./templates/recordatorioPrellegada.ts";
export * from "./templates/agradecimientoPostEstancia.ts";
export * from "./templates/reciboPago.ts";
export * from "./templates/cfdiDisponible.ts";
export * from "./templates/prospeccionComercial.ts";
export * from "./templates/cotizacionAbandonada.ts";
export * from "./templates/index.ts";
