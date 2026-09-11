// REQ-AB-014 (P2/F, H10-010): "disparar ofertas de upsell F&B ... en momentos
// definidos (T-7, T-3, check-in), con el precio siempre proveniente del motor de
// Revenue." Trabajador POR HOTEL (mismo patrón que `ticketEscalation.ts`/
// `purgeConversations.ts`): puro respecto al reloj -- SIEMPRE recibe `now` como
// parámetro (nunca `Date.now()` interno), así una corrida real y una prueba con reloj
// simulado ejercitan exactamente la misma lógica.
//
// Composición de capas (mismo criterio documentado en
// `packages/domain-hotel/src/fnbUpsellEngine.ts`): este archivo decide QUÉ reservas y
// QUÉ plantillas activas hay para el hotel y llama a `dueUpsellTriggerMoments`
// (dominio puro) para saber CUÁNDO corresponde disparar; el precio en sí nunca pasa
// por este archivo como un valor -- la inserción real va SIEMPRE por
// `public.trigger_fnb_upsell_offer` (migración 0133), que lo lee de `menu_item.price`
// dentro de la propia base de datos. Ningún código de este archivo lee ni pasa un
// `price`/`offered_price` en ningún INSERT.
//
// Fuera de alcance de este REQ (igual que REQ-AB-001/menuQr.ts declara "fuera de
// alcance" el enrutar el pedido a POS): el envío real de la oferta al huésped por
// WhatsApp. `fnb_upsell_trigger_event` es el registro auditable de que la oferta "se
// disparó" (H10-010: "el sistema debe disparar..."); conectar ese evento a
// `POST /hoteles/:hotelId/mensajeria/enviar` (plantilla `oferta_upsell`, ya usada como
// ejemplo canónico en `tests/integration/api/mensajeria.spec.ts`) para que el huésped
// reciba el mensaje es trabajo de integración de mensajería consumiendo este mismo
// evento -- no requiere cambiar nada de este archivo cuando se construya.
import type { DbClient } from "@atiende-hoteles/db";
import { dueUpsellTriggerMoments, type UpsellTriggerMoment } from "@atiende-hoteles/domain-hotel";

export interface EvaluateFnbUpsellParams {
  hotelId: string;
  tenantId: string;
  /** Si se indica, acota la evaluación a UNA sola reserva (usado por el disparo
   *  manual/bajo demanda de `routes/upsellFnb.ts`) en vez de recorrer todas las
   *  reservas activas del hotel (lo que hace el planificador automático). */
  reservationId?: string;
}

export interface EvaluateFnbUpsellOptions {
  /** Reloj inyectable (default: la hora real) -- ver comentario de cabecera. */
  now?: () => Date;
}

export interface TriggeredUpsellOffer {
  reservationId: string;
  templateId: string;
  offerType: string;
  triggerMoment: UpsellTriggerMoment;
  eventId: string;
  /** El precio devuelto por `trigger_fnb_upsell_offer` -- SOLO para que el llamador lo
   *  reporte/loguee; nunca se calculó ni se pasó en este archivo, se lee tal cual de la
   *  respuesta de la función SQL (que a su vez lo leyó de `menu_item.price`). */
  offeredPrice: number;
  yaDisparada: boolean;
}

export interface EvaluateFnbUpsellResult {
  reservationsEvaluated: number;
  triggered: TriggeredUpsellOffer[];
}

interface ActiveReservationRow {
  id: string;
  check_in_date: string;
}

interface ActiveTemplateRow {
  id: string;
  offer_type: string;
}

/** Reservas de `hotelId` para las que puede corresponder disparar upsell F&B: debe
 *  existir el compromiso real de la estancia (`confirmada` en adelante) -- una
 *  reserva todavía `cotizada` (sin confirmar) o ya `cancelada`/`no_show` nunca recibe
 *  una oferta (no tiene sentido ofrecer una cena romántica a quien podría no llegar).
 *  `check_out`/`cerrada` también se excluyen: los 3 momentos del REQ (T-7/T-3/
 *  check-in) siempre caen ANTES o EN el check-in, nunca durante/después de la
 *  estancia. */
const ACTIVE_RESERVATION_STATUSES = ["confirmada", "check_in", "en_estancia"] as const;

async function loadActiveReservations(db: DbClient, hotelId: string, reservationId?: string): Promise<ActiveReservationRow[]> {
  const { rows } = await db.query<{ id: string; check_in_date: string }>(
    `select id, check_in_date::text as check_in_date
     from public.reservation
     where hotel_id = $1 and status = any($2::public.reservation_status[])
       and ($3::uuid is null or id = $3::uuid);`,
    [hotelId, ACTIVE_RESERVATION_STATUSES, reservationId ?? null],
  );
  return rows;
}

async function loadActiveTemplates(db: DbClient, hotelId: string): Promise<ActiveTemplateRow[]> {
  const { rows } = await db.query<{ id: string; offer_type: string }>(
    `select t.id, t.offer_type
     from public.fnb_upsell_offer_template t
     join public.menu_item mi on mi.id = t.menu_item_id
     where t.hotel_id = $1 and t.active and mi.active;`,
    [hotelId],
  );
  return rows;
}

async function loadAlreadyTriggeredMoments(db: DbClient, reservationId: string): Promise<UpsellTriggerMoment[]> {
  const { rows } = await db.query<{ trigger_moment: UpsellTriggerMoment }>(
    `select distinct trigger_moment from public.fnb_upsell_trigger_event where reservation_id = $1;`,
    [reservationId],
  );
  return rows.map((r) => r.trigger_moment);
}

/**
 * Evalúa TODAS las reservas activas de `hotelId` y dispara (vía
 * `trigger_fnb_upsell_offer`) una oferta por cada (reserva, plantilla activa, momento
 * vencido) que todavía no se hubiera disparado. Idempotente: correr esto dos veces
 * seguidas sobre el mismo estado nunca duplica un disparo (la función SQL detecta el
 * evento ya existente y lo devuelve tal cual, `yaDisparada: true`).
 *
 * Nota de "al menos una oferta por momento" (H10-010): si un hotel configuró varias
 * plantillas activas, CADA una se dispara por separado para el momento vencido -- el
 * REQ exige "al menos una", nunca dice "como máximo una"; un hotel real
 * razonablemente quiere ofrecer sus 3 upsells (cena/botella/desayuno) juntos en el
 * mismo T-7, no elegir uno arbitrariamente.
 */
export async function evaluateAndTriggerFnbUpsellOffers(
  db: DbClient,
  params: EvaluateFnbUpsellParams,
  opts: EvaluateFnbUpsellOptions = {},
): Promise<EvaluateFnbUpsellResult> {
  const now = (opts.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  const [reservations, templates] = await Promise.all([
    loadActiveReservations(db, params.hotelId, params.reservationId),
    loadActiveTemplates(db, params.hotelId),
  ]);

  const triggered: TriggeredUpsellOffer[] = [];
  if (templates.length === 0) {
    return { reservationsEvaluated: reservations.length, triggered };
  }

  for (const reservation of reservations) {
    const already = await loadAlreadyTriggeredMoments(db, reservation.id);
    const due = dueUpsellTriggerMoments(reservation.check_in_date, nowIso, already);
    if (due.length === 0) continue;

    for (const moment of due) {
      for (const template of templates) {
        const { rows } = await db.query<{ id: string; offered_price: string; ya_disparada: boolean }>(
          `select id, offered_price::text as offered_price, ya_disparada
           from public.trigger_fnb_upsell_offer($1, $2, $3);`,
          [reservation.id, template.id, moment],
        );
        const row = rows[0]!;
        triggered.push({
          reservationId: reservation.id,
          templateId: template.id,
          offerType: template.offer_type,
          triggerMoment: moment,
          eventId: row.id,
          offeredPrice: Number(row.offered_price),
          yaDisparada: row.ya_disparada,
        });
      }
    }
  }

  return { reservationsEvaluated: reservations.length, triggered };
}
