// REQ-RES-011 (docs/REQUISITOS.md): "El sistema debe detectar reservas/cotizaciones
// abandonadas en el motor propio y contactar al huésped dentro de ventanas definidas
// (p.ej. 10 min, 2h, 24h) ofreciendo ayuda o un incentivo no monetario." Criterio de
// aceptación literal (docs/ACEPTACION.md): "Cotización abandonada detectada por el motor
// propio dispara contacto en las ventanas configuradas (10 min, 2h, 24h) con oferta no
// monetaria; prueba de tiempo simulado confirma exactamente 3 contactos en esas
// ventanas, ninguno antes ni después."
//
// "Cotización del motor propio" = una fila de `public.reservation` en estado inicial
// `cotizada` (ADR-005, migración 0006: toda reserva nace `cotizada` y solo pasa a
// `confirmada` cuando el huésped/staff la confirma vía
// `PATCH .../reservas/:id/transicion`) que nunca avanzó de ahí -- exactamente el "carrito"
// de una reserva directa sin completar, sin necesitar una tabla de "cotización" aparte.
// Un abandono real y uno inexistente se distinguen por el propio `status`: en cuanto la
// reserva pasa a `confirmada` (o se cancela), deja de calificar para cualquier ventana
// (ver `apps/api/src/jobs/quoteAbandonment.ts`, WHERE `status = 'cotizada'`).
//
// Puro, determinístico, sin I/O (mismo principio que `tickets/slaPolicy.ts`): el reloj
// SIEMPRE se recibe como parámetro, nunca `new Date()`/`Date.now()` interno, para que la
// prueba de "tiempo simulado" del criterio de aceptación sea 100% reproducible.

/** Las 3 ventanas EXACTAS del criterio de aceptación, en minutos desde la creación de la
 *  cotización -- 10 min (reacción inmediata, todavía "tibio"), 2h (recordatorio del
 *  mismo día) y 24h (última oportunidad antes de que la cotización quede totalmente
 *  fría). Cada ventana trae su propia oferta -- "ayuda o un incentivo no monetario"
 *  (texto literal del REQ): las dos primeras ofrecen AYUDA humana (nunca dinero), la
 *  última sí ofrece un incentivo, pero explícitamente NO monetario (upgrade sujeto a
 *  disponibilidad, nunca un descuento en precio -- un descuento de precio en este punto
 *  competiría con el propio motor de Revenue, REQ-REV-*, que es quien decide precio). */
export const QUOTE_ABANDONMENT_WINDOWS = [
  {
    key: "10m",
    minutes: 10,
    etiqueta: "10 minutos",
    ofertaNoMonetaria:
      "¿Te ayudamos a terminar tu reserva? Responde este correo y un agente te asiste ahora mismo con cualquier duda de tarifa, fechas o política.",
  },
  {
    key: "2h",
    minutes: 120,
    etiqueta: "2 horas",
    ofertaNoMonetaria:
      "Tu cotización sigue disponible. Si algo te detuvo (método de pago, fechas, tipo de habitación), contáctanos y lo resolvemos contigo directamente.",
  },
  {
    key: "24h",
    minutes: 1440,
    etiqueta: "24 horas",
    ofertaNoMonetaria:
      "Última oportunidad del día: confirma hoy y te apartamos un upgrade de habitación sin costo adicional, sujeto a disponibilidad al momento del check-in.",
  },
] as const;

export type QuoteAbandonmentWindowKey = (typeof QUOTE_ABANDONMENT_WINDOWS)[number]["key"];
export type QuoteAbandonmentWindow = (typeof QUOTE_ABANDONMENT_WINDOWS)[number];

/** Resuelve la definición completa (minutos + oferta) de una ventana por su `key` --
 *  usado por el handler de outbox (`emailOutbox/buildEmailOutboxHandlers.ts`) para
 *  recuperar el texto de la oferta a partir del `window` guardado en el payload del
 *  evento, sin repetir el catálogo de ofertas en dos archivos. */
export function resolveQuoteAbandonmentWindow(key: QuoteAbandonmentWindowKey): QuoteAbandonmentWindow {
  const found = QUOTE_ABANDONMENT_WINDOWS.find((w) => w.key === key);
  if (!found) throw new Error(`ventana de abandono desconocida: ${key}`);
  return found;
}

/** Instante en que una cotización creada en `createdAt` alcanza una ventana de
 *  `windowMinutes` -- mismo patrón que `computeSlaDueAt` de `tickets/slaPolicy.ts`. */
export function computeAbandonmentContactAt(createdAt: Date, windowMinutes: number): Date {
  return new Date(createdAt.getTime() + windowMinutes * 60_000);
}

/** `true` si, al instante `now` (reloj inyectado), la cotización ya alcanzó el instante
 *  de contacto de esa ventana -- `>=` (igual que `isSlaWarningDue`): alcanzar el minuto
 *  exacto de la ventana ya debe disparar el contacto, no un instante después. */
export function isAbandonmentContactDue(now: Date, contactAt: Date): boolean {
  return now.getTime() >= contactAt.getTime();
}
