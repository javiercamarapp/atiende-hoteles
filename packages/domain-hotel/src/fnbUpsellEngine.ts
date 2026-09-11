/**
 * REQ-AB-014 (P2/F, fuente H10-010): "El sistema debe disparar ofertas de upsell F&B
 * (cena romántica, botella, desayuno en cama) en momentos definidos (T-7, T-3,
 * check-in), con el precio siempre proveniente del motor de Revenue."
 *
 * Módulo de dominio PURO (mismo principio que `fnbAllergyGuard.ts`/`quote.ts`): ninguna
 * función de aquí toca I/O -- `apps/api/src/jobs/fnbUpsellScheduler.ts` es quien lee
 * reservas/plantillas de la base y decide cuándo llamar estas funciones; la inserción
 * real del evento disparado vive en la función SQL
 * `public.trigger_fnb_upsell_offer` (migración 0133), que es la que de verdad hace
 * cumplir "el precio siempre proveniente del motor de Revenue" a nivel de base de
 * datos (ver comentario extenso ahí) -- este módulo solo decide CUÁNDO corresponde
 * disparar, nunca calcula ni acepta un precio.
 *
 * "el precio siempre proveniente del motor de Revenue": en este repo el precio nunca
 * "inventado" de un platillo/paquete de F&B es `menu_item.price` (REQ-AB-001,
 * migración 0132) -- el catálogo real gestionado exclusivamente por los roles
 * owner/gm/fnb, la misma noción de "precio real, nunca sugerido por un LLM" que
 * `rate_plan.price` para habitaciones (REQ-RES-002, ver
 * `tests/unit/domain-hotel/pricing-source.spec.ts`). Una "oferta de upsell" de este
 * módulo es una PLANTILLA que apunta a un `menu_item` real -- nunca un número libre
 * capturado por un canal conversacional. `resolveOfferPrice` de abajo hace explícito
 * ese contrato: solo reconoce las columnas reales de un `menu_item` (zod `.strip()`
 * implícito), así que un campo extra como `llmSuggestedPrice` inyectado por un canal
 * de WhatsApp/voz se descarta ANTES de que el precio llegue a cualquier lado --
 * verificado en `tests/unit/domain-hotel/fnb-upsell-engine.spec.ts`, mismo patrón que
 * `tests/unit/domain-hotel/pricing-source.spec.ts`.
 */
import { z } from "zod";

/** Catálogo cerrado de tipos de oferta -- literalmente los 3 ejemplos del REQ ("cena
 *  romántica, botella, desayuno en cama"). Un hotel puede tener varias plantillas del
 *  MISMO tipo (ej. dos opciones de "botella" a precios distintos): el tipo es solo la
 *  categoría para agrupar/presentar, nunca un identificador único de oferta. */
export const UPSELL_OFFER_TYPES = ["cena_romantica", "botella", "desayuno_en_cama"] as const;
export type UpsellOfferType = (typeof UPSELL_OFFER_TYPES)[number];

export function isUpsellOfferType(value: string): value is UpsellOfferType {
  return (UPSELL_OFFER_TYPES as readonly string[]).includes(value);
}

/** Catálogo cerrado de momentos de disparo -- literalmente "T-7, T-3, check-in" del
 *  REQ, en el orden en que ocurren para una reserva (nunca se dispara check-in antes
 *  que T-3, salvo el caso de "alcance" documentado en `dueUpsellTriggerMoments` de
 *  abajo). */
export const UPSELL_TRIGGER_MOMENTS = ["t_menos_7", "t_menos_3", "checkin"] as const;
export type UpsellTriggerMoment = (typeof UPSELL_TRIGGER_MOMENTS)[number];

export function isUpsellTriggerMoment(value: string): value is UpsellTriggerMoment {
  return (UPSELL_TRIGGER_MOMENTS as readonly string[]).includes(value);
}

export class FnbUpsellEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FnbUpsellEngineError";
  }
}

// Umbral en DÍAS completos hasta el check-in a partir del cual cada momento ya está
// "vencido" (es decir, corresponde dispararlo). `checkin` usa 0: el propio día de
// check-in (o después, ej. un tick que corrió tarde) también cuenta como vencido --
// nunca se pierde el disparo por no haber corrido exactamente a medianoche.
const TRIGGER_THRESHOLD_DAYS: Readonly<Record<UpsellTriggerMoment, number>> = {
  t_menos_7: 7,
  t_menos_3: 3,
  checkin: 0,
};

/** Mismo criterio EXACTO que `hoursBetween` de `cancellationPolicy.ts`: una fecha
 *  calendario (`YYYY-MM-DD`) se interpreta como medianoche UTC de ese día -- "el día
 *  de check-in" es el mismo concepto en todo el dominio, nunca reinterpretado aquí. */
export function daysUntilCheckIn(checkInDateIso: string, nowIso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkInDateIso)) {
    throw new FnbUpsellEngineError(`fecha_checkin_invalida: se esperaba YYYY-MM-DD, recibido "${checkInDateIso}"`);
  }
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(now)) {
    throw new FnbUpsellEngineError(`ahora_invalido: "${nowIso}" no es una fecha/hora válida`);
  }
  const checkIn = new Date(`${checkInDateIso}T00:00:00Z`).getTime();
  // Piso (nunca redondeado hacia arriba): "van 6.9 días" es todavía T-7 vencido (>= 7
  // días completos NO se cumplen), nunca se adelanta el disparo por redondeo.
  return Math.floor((checkIn - now) / (1000 * 60 * 60 * 24));
}

/**
 * Decide qué momentos de disparo (de los 3 del catálogo) están VENCIDOS ahora mismo
 * para una reserva y todavía NO se han disparado (`alreadyTriggered`). Nunca vuelve a
 * incluir un momento ya disparado (idempotencia a nivel de dominio -- la garantía de
 * fondo bajo concurrencia real es el índice único de
 * `fnb_upsell_trigger_event(reservation_id, template_id, trigger_moment)`, migración
 * 0133, mismo criterio que `buildLocationCode`/`menu_qr_location`).
 *
 * Si el planificador no corrió por un tiempo (o la reserva se confirmó a última hora,
 * a 2 días del check-in), más de un momento puede estar vencido a la vez -- eso es
 * correcto, no un error: de verdad ya pasaron esos umbrales, así que se disparan
 * TODOS los que falten, en el orden del catálogo (mismo criterio de "alcance" que
 * `ticketEscalationScheduler.tick` documenta para el aviso al 75%/escalación al 100%
 * del SLA).
 */
export function dueUpsellTriggerMoments(
  checkInDateIso: string,
  nowIso: string,
  alreadyTriggered: readonly UpsellTriggerMoment[] = [],
): UpsellTriggerMoment[] {
  const days = daysUntilCheckIn(checkInDateIso, nowIso);
  const already = new Set(alreadyTriggered);
  const due: UpsellTriggerMoment[] = [];
  for (const moment of UPSELL_TRIGGER_MOMENTS) {
    if (already.has(moment)) continue;
    if (days <= TRIGGER_THRESHOLD_DAYS[moment]) due.push(moment);
  }
  return due;
}

// Espejo EXACTO (y únicamente) de las columnas de `menu_item` relevantes para fijar el
// precio de una oferta de upsell (packages/db/migrations/0132_menu_qr.sql) -- mismo
// principio que `nightlyRateSchema` de `quote.ts`: cualquier propiedad fuera de esta
// lista (ej. un precio "sugerido" por el LLM de un canal conversacional, o un
// descuento inventado a mitad de conversación) se elimina silenciosamente por el
// `.strip()` implícito de zod, ANTES de que el precio llegue a ningún cálculo.
const revenuePricedCatalogRowSchema = z.object({
  menuItemId: z.string().uuid(),
  /** `menu_item.price` real, tal cual está en la base -- NUNCA un valor que un
   *  llamador pueda "ajustar" en el camino (no existe ningún parámetro de ajuste en
   *  este esquema, a propósito). */
  price: z.number().nonnegative(),
  active: z.boolean(),
});
export type RevenuePricedCatalogRow = z.infer<typeof revenuePricedCatalogRowSchema>;

/**
 * Parsea una fila candidata de catálogo real (`menu_item`) para fijar el precio de una
 * oferta de upsell -- cualquier campo ajeno a `menu_item` (ej. `llmSuggestedPrice`,
 * `descuentoNegociado`) se descarta antes de calcular nada. Lanza si la fila no viene
 * con las columnas reales esperadas (nunca "estima" un precio ante datos incompletos).
 */
export function parseRevenuePricedCatalogRow(raw: unknown): RevenuePricedCatalogRow {
  const parsed = revenuePricedCatalogRowSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FnbUpsellEngineError(`fila_de_catalogo_invalida: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

/**
 * El precio real de la oferta, dado UNICAMENTE el catálogo real ya parseado
 * (`parseRevenuePricedCatalogRow`). Rechaza un platillo/paquete inactivo -- una
 * oferta nunca se dispara con el precio de algo que el hotel ya retiró del menú
 * (mismo criterio que `menu_item_hotel_active_idx` / `resolveMenuForGuest`, que
 * también excluyen `active = false`).
 */
export function resolveOfferPrice(row: RevenuePricedCatalogRow): number {
  if (!row.active) {
    throw new FnbUpsellEngineError(
      `platillo_inactivo: el menu_item ${row.menuItemId} está inactivo -- no puede fijar el precio de una oferta de upsell`,
    );
  }
  return row.price;
}
