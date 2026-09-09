// REQ-RES-006/H01-010,H02-011 (P1/F): dispara la oferta automática de lista de espera.
// Se llama SIEMPRE justo después de liberar el inventario de una cancelación (tanto la
// cancelación de staff, routes/reservas.ts POST .../cancelar, como la pública
// verificada por código+apellido de REQ-RES-005, routes/cancelacionPublica.ts) --
// nunca antes, para no ofertar una habitación que todavía no está realmente libre.
//
// `FOR UPDATE SKIP LOCKED` sobre las filas candidatas: si dos cancelaciones
// concurrentes liberan el MISMO room_type/rango de fechas al mismo tiempo, cada
// llamada bloquea/observa un subconjunto distinto de filas en vez de arriesgarse a
// ofertarle la misma habitación a dos contactos -- la garantía FIFO real la resuelve
// `selectNextWaitlistCandidate()` (packages/domain-hotel, puro/sin I/O) sobre las filas
// que SÍ alcanzó a ver esta llamada.
import type { DbClient } from "@atiende-hoteles/db";
import { selectNextWaitlistCandidate, computeOfferExpiresAt, type WaitlistCandidate } from "@atiende-hoteles/domain-hotel";
import { quoteNetAmount } from "./quoteNetAmount.ts";

export interface WaitlistOfferParams {
  tenantId: string;
  hotelId: string;
  roomTypeId: string;
  checkInDate: string;
  checkOutDate: string;
}

export interface WaitlistOfferResult {
  offered: boolean;
  waitlistEntryId?: string;
  offerAmount?: number;
  offerExpiresAt?: string;
}

interface WaitlistEntryRow {
  id: string;
  room_type_id: string;
  check_in_date: string;
  check_out_date: string;
  status: string;
  created_at: string;
}

export async function tryOfferWaitlistSlot(db: DbClient, params: WaitlistOfferParams): Promise<WaitlistOfferResult> {
  const { tenantId, hotelId, roomTypeId, checkInDate, checkOutDate } = params;

  const { rows } = await db.query<WaitlistEntryRow>(
    `select id, room_type_id, check_in_date::text as check_in_date, check_out_date::text as check_out_date,
            status, created_at::text as created_at
     from public.hotel_waitlist_entry
     where hotel_id = $1 and room_type_id = $2 and check_in_date = $3 and check_out_date = $4
       and status = 'esperando'
     order by created_at asc, id asc
     for update skip locked;`,
    [hotelId, roomTypeId, checkInDate, checkOutDate],
  );

  const candidates: WaitlistCandidate[] = rows.map((r) => ({
    id: r.id,
    roomTypeId: r.room_type_id,
    checkInDate: r.check_in_date,
    checkOutDate: r.check_out_date,
    status: r.status as WaitlistCandidate["status"],
    createdAt: r.created_at,
  }));

  const winner = selectNextWaitlistCandidate(candidates, { roomTypeId, checkInDate, checkOutDate });
  if (!winner) return { offered: false };

  let offerAmount: number;
  try {
    // Precio DIRECTO, mismo motor que cualquier reserva directa (quoteNetAmount) — ver
    // domain-hotel/src/reservas/waitlist.ts sobre por qué esto YA satisface "sin
    // comisión".
    offerAmount = await quoteNetAmount(db, { hotelId, roomTypeId, checkInDate, checkOutDate });
  } catch {
    // Sin tarifa/cotización válida para esas fechas justo ahora (ej. min-stay/CTA/CTD
    // que ya no aplicaba cuando se creó la reserva original que se está cancelando):
    // no se puede ofertar un precio real. Se documenta como "sin oferta" en vez de
    // arriesgar revertir la cancelación completa por un problema de tarifas ajeno a
    // ella -- la fila candidata queda sin tocar (sigue 'esperando' para una futura
    // cancelación que sí pueda cotizarse).
    return { offered: false };
  }

  const offeredAt = new Date().toISOString();
  const offerExpiresAt = computeOfferExpiresAt(offeredAt);

  await db.query(
    `update public.hotel_waitlist_entry
     set status = 'ofertada', offered_at = $2, offer_expires_at = $3, offer_amount = $4, updated_at = now()
     where id = $1;`,
    [winner.id, offeredAt, offerExpiresAt, offerAmount],
  );

  // waitlist.offer_created: infraestructura para notificar al contacto (WhatsApp/email)
  // queda pendiente de credenciales de canal (mismo criterio que REQ-RES-001/H03) --
  // el outbox registra el evento real desde H4, listo para que un handler futuro lo
  // consuma sin reescribir esta función.
  await db.query(
    `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
     values ($1, $2, 'hotel_waitlist_entry', $3, 'waitlist.offer_created', $4);`,
    [
      tenantId,
      hotelId,
      winner.id,
      JSON.stringify({ roomTypeId, checkInDate, checkOutDate, offerAmount, offerExpiresAt }),
    ],
  );

  await db.query(
    "select public.record_audit_log($1, $2, 'waitlist.offer_created', 'hotel_waitlist_entry', $3, $4);",
    [tenantId, hotelId, winner.id, JSON.stringify({ offerAmount, offerExpiresAt })],
  );

  return { offered: true, waitlistEntryId: winner.id, offerAmount, offerExpiresAt };
}
