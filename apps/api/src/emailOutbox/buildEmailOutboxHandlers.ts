// H12a · REQ-LAUNCH: "disparadores conectados a outbox (reserva confirmada -> correo;
// pago -> recibo; invitación -> correo)". Este módulo es NUEVO (carpeta propia, no toca
// `apps/api/src/outbox/worker.ts` ni ningún archivo de `routes/reservas.ts`/
// `routes/folios.ts`/`routes/cfdi.ts`, todos fuera de alcance de este agente) --
// construye los `OutboxHandler` (mismo tipo que ya consume `drainOutboxOnce`,
// `outbox/worker.ts`) que traducen un evento de `public.outbox` a un correo real.
//
// Estado de cada disparador (ninguno se declara "conectado" sin evidencia):
//   - `payment.recorded` -> recibo de pago: REALMENTE conectado -- ese evento YA lo
//     emite `routes/folios.ts` en cada pago registrado (ver ese archivo, no se tocó),
//     así que basta con registrar este handler para que un pago real dispare un correo
//     real la próxima vez que algo drene la tabla `outbox` (ver `runEmailOutboxWorker.ts`
//     en este mismo directorio, y `tests/integration/api/email-outbox-handlers.spec.ts`
//     que lo ejercita end-to-end contra el endpoint REAL de pagos).
//   - `reservation.confirmed` -> confirmación de reserva: PENDIENTE-COORDINACIÓN cerrada
//     por el integrador (merge H12a→main) -- `routes/reservas.ts` ahora inserta
//     `insert into public.outbox (..., 'reservation.confirmed', ...)` dentro del bloque
//     `if (body.toStatus === "confirmada")`, con `tests/integration/api/reservas-y-folios.spec.ts`
//     verificando el evento.
//   - `cfdi.emitted` -> aviso de CFDI disponible: mismo cierre -- `routes/cfdi.ts` emite
//     el evento tras timbrar (hospedaje y pago) solo cuando el timbrado insertó una fila
//     NUEVA con `status === "timbrado"` (nunca en un reintento idempotente).
//   - `reservation.abandonment_contact` (REQ-RES-011) -> contacto de cotización
//     abandonada: REALMENTE conectado -- `apps/api/src/jobs/quoteAbandonment.ts` emite
//     este evento por cada ventana (10 min/2h/24h) que una `reservation` en `cotizada`
//     alcanza sin confirmarse, con `window` en el payload para que este handler resuelva
//     la oferta no monetaria exacta de esa ventana
//     (`@atiende-hoteles/domain-hotel::resolveQuoteAbandonmentWindow`).
import type { EmailPort } from "@atiende-hoteles/email";
import {
  renderReciboPago,
  renderConfirmacionReserva,
  renderCfdiDisponible,
  renderCotizacionAbandonada,
} from "@atiende-hoteles/email";
import { resolveQuoteAbandonmentWindow, type QuoteAbandonmentWindowKey } from "@atiende-hoteles/domain-hotel";
import type { DbClient } from "@atiende-hoteles/db";
import type { OutboxHandler, OutboxRow } from "../outbox/worker.ts";

export interface EmailOutboxHandlerDeps {
  db: DbClient;
  emailPort: EmailPort;
}

interface PaymentEmailRow {
  amount: string;
  method: string;
  created_at: string;
  external_ref: string | null;
  hotel_name: string;
  guest_email: string | null;
  guest_name: string | null;
}

function paymentRecordedHandler(deps: EmailOutboxHandlerDeps): OutboxHandler {
  return async (row: OutboxRow) => {
    const { rows } = await deps.db.query<PaymentEmailRow>(
      `select p.amount, p.method, p.created_at::text as created_at, p.external_ref,
              l.name as hotel_name, g.email as guest_email, g.full_name as guest_name
       from public.payment p
       join public.folio f on f.id = p.folio_id
       join public.reservation r on r.id = f.reservation_id
       left join public.guest g on g.id = r.guest_id
       join public.location l on l.id = p.hotel_id
       where p.id = $1;`,
      [row.aggregate_id],
    );
    const payment = rows[0];
    // Sin fila (folio/reserva purgados) o sin correo del huésped en el expediente: no
    // hay a quién enviarle nada -- se trata como entregado (nada que reintentar), NUNCA
    // como fallo, para no dejar el evento reintentando indefinidamente por un dato que
    // legítimamente no existe.
    if (!payment || !payment.guest_email) return;

    const rendered = renderReciboPago({
      nombreHuesped: payment.guest_name ?? "Huésped",
      nombreHotel: payment.hotel_name,
      monto: Number(payment.amount),
      moneda: "MXN",
      metodo: payment.method,
      folioCodigo: String(row.aggregate_id).slice(0, 8).toUpperCase(),
      fechaPago: payment.created_at,
      referenciaExterna: payment.external_ref ?? undefined,
    });

    await deps.emailPort.send({
      ...rendered,
      to: { email: payment.guest_email, name: payment.guest_name ?? undefined },
      template: "recibo-pago",
      dedupeKey: `recibo-pago:${row.aggregate_id}`,
      tenantId: row.tenant_id,
      hotelId: row.hotel_id,
    });
  };
}

interface ReservationEmailRow {
  confirmation_code: string;
  check_in_date: string;
  check_out_date: string;
  total_amount: string;
  hotel_name: string;
  room_type_name: string | null;
  guest_email: string | null;
  guest_name: string | null;
}

function reservationConfirmedHandler(deps: EmailOutboxHandlerDeps): OutboxHandler {
  return async (row: OutboxRow) => {
    const { rows } = await deps.db.query<ReservationEmailRow>(
      `select r.confirmation_code, r.check_in_date::text, r.check_out_date::text, r.total_amount,
              l.name as hotel_name, rt.name as room_type_name, g.email as guest_email, g.full_name as guest_name
       from public.reservation r
       join public.location l on l.id = r.hotel_id
       left join public.room_type rt on rt.id = r.room_type_id
       left join public.guest g on g.id = r.guest_id
       where r.id = $1;`,
      [row.aggregate_id],
    );
    const reservation = rows[0];
    if (!reservation || !reservation.guest_email) return;

    const rendered = renderConfirmacionReserva({
      nombreHuesped: reservation.guest_name ?? "Huésped",
      nombreHotel: reservation.hotel_name,
      codigoConfirmacion: reservation.confirmation_code,
      checkIn: reservation.check_in_date,
      checkOut: reservation.check_out_date,
      tipoHabitacion: reservation.room_type_name ?? "Habitación",
      totalAmount: Number(reservation.total_amount),
      moneda: "MXN",
    });

    await deps.emailPort.send({
      ...rendered,
      to: { email: reservation.guest_email, name: reservation.guest_name ?? undefined },
      template: "confirmacion-reserva",
      dedupeKey: `confirmacion-reserva:${row.aggregate_id}`,
      tenantId: row.tenant_id,
      hotelId: row.hotel_id,
    });
  };
}

interface CfdiEmailRow {
  uuid_fiscal: string | null;
  total: string;
  hotel_name: string;
  guest_email: string | null;
  guest_name: string | null;
}

function cfdiEmittedHandler(deps: EmailOutboxHandlerDeps): OutboxHandler {
  return async (row: OutboxRow) => {
    const { rows } = await deps.db.query<CfdiEmailRow>(
      `select cf.uuid_fiscal, cf.total, l.name as hotel_name, g.email as guest_email, g.full_name as guest_name
       from public.cfdi_emision cf
       join public.folio f on f.id = cf.folio_id
       join public.reservation r on r.id = f.reservation_id
       join public.location l on l.id = cf.hotel_id
       left join public.guest g on g.id = r.guest_id
       where cf.id = $1;`,
      [row.aggregate_id],
    );
    const cfdi = rows[0];
    if (!cfdi || !cfdi.guest_email || !cfdi.uuid_fiscal) return;

    const rendered = renderCfdiDisponible({
      nombreHuesped: cfdi.guest_name ?? "Huésped",
      nombreHotel: cfdi.hotel_name,
      uuidFiscal: cfdi.uuid_fiscal,
      descargaUrl: `${process.env.FRONTEND_URL ?? ""}/cfdi/${row.aggregate_id}`,
      totalAmount: Number(cfdi.total),
      moneda: "MXN",
    });

    await deps.emailPort.send({
      ...rendered,
      to: { email: cfdi.guest_email, name: cfdi.guest_name ?? undefined },
      template: "cfdi-disponible",
      dedupeKey: `cfdi-disponible:${row.aggregate_id}`,
      tenantId: row.tenant_id,
      hotelId: row.hotel_id,
    });
  };
}

interface AbandonmentEmailRow {
  status: string;
  check_in_date: string;
  check_out_date: string;
  total_amount: string;
  hotel_name: string;
  room_type_name: string | null;
  guest_email: string | null;
  guest_name: string | null;
}

function isQuoteAbandonmentWindowKey(value: unknown): value is QuoteAbandonmentWindowKey {
  return value === "10m" || value === "2h" || value === "24h";
}

/** REQ-RES-011: traduce `reservation.abandonment_contact` (emitido por
 *  `jobs/quoteAbandonment.ts`, payload `{reservationId, window}`) a un correo real con
 *  la oferta no monetaria de la ventana correspondiente. */
function reservationAbandonmentContactHandler(deps: EmailOutboxHandlerDeps): OutboxHandler {
  return async (row: OutboxRow) => {
    const payload = row.payload as { window?: unknown } | null;
    const windowKey = payload?.window;
    // Payload sin `window` reconocible: no hay ventana de la que sacar la oferta -- se
    // trata como entregado (nunca reintenta indefinidamente por un dato que no va a
    // cambiar), mismo criterio que "sin correo del huésped" más abajo.
    if (!isQuoteAbandonmentWindowKey(windowKey)) return;

    const { rows } = await deps.db.query<AbandonmentEmailRow>(
      `select r.status::text, r.check_in_date::text, r.check_out_date::text, r.total_amount,
              l.name as hotel_name, rt.name as room_type_name, g.email as guest_email, g.full_name as guest_name
       from public.reservation r
       join public.location l on l.id = r.hotel_id
       left join public.room_type rt on rt.id = r.room_type_id
       left join public.guest g on g.id = r.guest_id
       where r.id = $1;`,
      [row.aggregate_id],
    );
    const reservation = rows[0];
    // Sin fila, sin correo del huésped en el expediente, o la reserva YA avanzó de
    // estado entre el tick que la marcó y este drenado (se confirmó/canceló mientras
    // tanto): no hay nada que enviar -- entregado, nunca fallo, mismo criterio que
    // `paymentRecordedHandler`.
    if (!reservation || !reservation.guest_email || reservation.status !== "cotizada") return;

    const ventana = resolveQuoteAbandonmentWindow(windowKey);

    const rendered = renderCotizacionAbandonada({
      nombreHuesped: reservation.guest_name ?? "Huésped",
      nombreHotel: reservation.hotel_name,
      checkIn: reservation.check_in_date,
      checkOut: reservation.check_out_date,
      tipoHabitacion: reservation.room_type_name ?? "Habitación",
      totalAmount: Number(reservation.total_amount),
      moneda: "MXN",
      ventanaEtiqueta: ventana.etiqueta,
      ofertaNoMonetaria: ventana.ofertaNoMonetaria,
    });

    await deps.emailPort.send({
      ...rendered,
      to: { email: reservation.guest_email, name: reservation.guest_name ?? undefined },
      template: "cotizacion-abandonada",
      // Clave por ventana (no solo por reserva): las 3 ventanas de la MISMA reserva son
      // 3 contactos distintos y legítimos, a diferencia del resto de plantillas donde
      // un solo evento por agregado ya es la unidad de deduplicación correcta.
      dedupeKey: `cotizacion-abandonada:${row.aggregate_id}:${windowKey}`,
      tenantId: row.tenant_id,
      hotelId: row.hotel_id,
    });
  };
}

/** Handlers de `public.outbox` -> correo, para pasar a `drainOutboxOnce({handlers})`
 *  (ver `runEmailOutboxWorker.ts`). `payment.recorded`/`reservation.confirmed`/
 *  `reservation.abandonment_contact` corresponden a `event_type` que algún código YA
 *  emite hoy (ver cabecera del archivo) -- `cfdi.emitted` queda listo para el día que
 *  `routes/cfdi.ts` empiece a emitirlo. */
export function buildEmailOutboxHandlers(deps: EmailOutboxHandlerDeps): Record<string, OutboxHandler> {
  return {
    "payment.recorded": paymentRecordedHandler(deps),
    "reservation.confirmed": reservationConfirmedHandler(deps),
    "cfdi.emitted": cfdiEmittedHandler(deps),
    "reservation.abandonment_contact": reservationAbandonmentContactHandler(deps),
  };
}
