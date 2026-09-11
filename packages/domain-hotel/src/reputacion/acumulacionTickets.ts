// REQ-CRM-003 (P1/F): "El sistema debe generar automáticamente un ticket de
// mantenimiento cuando se acumulan N menciones negativas del mismo tema en una
// ventana de tiempo definida (p.ej. 3 en 14 días)."
//
// Por qué esto es un módulo separado de `clasificador.ts` (REQ-CRM-002) en vez de una
// rama más dentro de `decidirAcciones`: REQ-CRM-002 decide sus acciones SOLO con los
// datos de la reseña que se acaba de clasificar (función pura, sin I/O, ver comentario
// de archivo de `clasificador.ts`). REQ-CRM-003 en cambio necesita el HISTÓRICO de
// reseñas anteriores del mismo hotel -- eso es I/O real (una consulta a
// `guest_review`), así que no puede vivir dentro de una función pura que solo recibe
// el texto de una reseña. El patrón que sigue este archivo es el mismo que el resto
// del dominio: la política de decisión (¿cuántas menciones cuentan como "acumulación"
// dentro de la ventana? ¿ya hay un ticket que la cubra?) queda aislada aquí, PURA y
// testeable con fechas sintéticas; quien la llama (apps/api/src/routes/reputacion.ts)
// hace el I/O (consulta el histórico real, cuenta las menciones del mismo tema) y le
// pasa el resultado ya reducido a fechas.
//
// Relación con REQ-CRM-002 (evita doble ticket para el mismo tema): `TICKET_TOPICS`
// (limpieza, wifi, ruido, aire_acondicionado, alberca) YA generan un ticket en la
// PRIMERA mención negativa -- para esos temas, la acumulación de REQ-CRM-003 nunca
// llega a disparar un segundo ticket porque el caller pasa `yaExisteTicketReciente:
// true` (ya existe un ticket de la mención individual dentro de la misma ventana). La
// acumulación por N menciones aporta valor real para temas que, por sí solos, NO
// ameritan un ticket inmediato (p.ej. "personal", "seguridad", o un tema local nunca
// antes visto como "cucarachas") pero sí lo ameritan cuando el mismo tema se repite
// varias veces en poco tiempo -- un patrón, no un evento aislado.

/** Configuración del umbral de acumulación. El ejemplo literal del criterio de
 *  aceptación (docs/ACEPTACION.md, REQ-CRM-003) es "3 en 14 días" -- se usa como
 *  default hasta que exista una decisión del fundador de hacerlo configurable por
 *  hotel (no hay ningún campo de configuración por hotel para esto hoy). */
export interface AcumulacionTicketConfig {
  /** N: cuántas menciones negativas del mismo tema dentro de la ventana disparan el
   *  ticket automático (incluyendo la mención actual). */
  umbralMenciones: number;
  /** Tamaño de la ventana deslizante, en días, medida hacia atrás desde la mención
   *  actual (inclusive en ambos extremos). */
  ventanaDias: number;
}

export const ACUMULACION_TICKET_DEFAULT: AcumulacionTicketConfig = {
  umbralMenciones: 3,
  ventanaDias: 14,
};

export interface EvaluarAcumulacionTicketInput {
  /** Fecha/hora de la mención (reseña) actual que se está clasificando. */
  fechaActual: Date;
  /** Fechas de menciones PREVIAS del mismo tema, con sentimiento negativo/muy_negativo,
   *  del mismo hotel -- ya filtradas por tema y sentimiento por quien llama (la
   *  ventana de tiempo la filtra esta función, no hace falta pre-filtrarla). No debe
   *  incluir la mención actual. */
  fechasMencionesPrevias: Date[];
  /** `true` cuando ya existe un ticket de mantenimiento (de esta misma regla o de la
   *  mención individual de REQ-CRM-002) para este mismo tema dentro de la ventana --
   *  nunca se duplica un ticket que ya cubre la acumulación vigente. */
  yaExisteTicketReciente: boolean;
  config?: AcumulacionTicketConfig;
}

export interface ResultadoAcumulacionTicket {
  /** `true` solo cuando el umbral se alcanzó Y ningún ticket ya vigente lo cubre. */
  disparaTicket: boolean;
  /** Total de menciones negativas del tema dentro de la ventana, incluyendo la actual. */
  totalMenciones: number;
  umbralMenciones: number;
  ventanaDias: number;
}

/**
 * Decide si la acumulación de menciones negativas del mismo tema, dentro de la
 * ventana configurada, alcanza el umbral que dispara un ticket de mantenimiento
 * automático (REQ-CRM-003). Pura: no hace ninguna consulta, solo compara fechas ya
 * provistas por el caller.
 */
export function evaluarAcumulacionTicket(input: EvaluarAcumulacionTicketInput): ResultadoAcumulacionTicket {
  const config = input.config ?? ACUMULACION_TICKET_DEFAULT;
  const finVentanaMs = input.fechaActual.getTime();
  const inicioVentanaMs = finVentanaMs - config.ventanaDias * 24 * 60 * 60 * 1000;

  // Ventana inclusiva en ambos extremos: una mención exactamente en el borde de los N
  // días atrás todavía cuenta (mismo criterio de "ventana deslizante" que
  // REQ-HK-011/dedupe-de-tickets ya usa en este repo).
  const previasEnVentana = input.fechasMencionesPrevias.filter((f) => {
    const t = f.getTime();
    return t >= inicioVentanaMs && t <= finVentanaMs;
  }).length;

  const totalMenciones = previasEnVentana + 1; // +1: la mención actual siempre cuenta.
  const disparaTicket = !input.yaExisteTicketReciente && totalMenciones >= config.umbralMenciones;

  return {
    disparaTicket,
    totalMenciones,
    umbralMenciones: config.umbralMenciones,
    ventanaDias: config.ventanaDias,
  };
}
