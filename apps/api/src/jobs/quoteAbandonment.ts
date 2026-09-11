// REQ-RES-011: "un ticket sin cierre dentro del SLA escala automáticamente" es el
// análogo de tickets (`jobs/ticketEscalation.ts`); este archivo es el mismo patrón
// EXACTO aplicado a `public.reservation`: trabajador POR HOTEL, puro respecto al
// reloj -- SIEMPRE recibe `now` como parámetro (nunca `Date.now()` interno) y lo pasa
// como PARÁMETRO SQL en la comparación, nunca usa el `now()` de Postgres -- así, tanto
// una corrida real (reloj real inyectado por `quoteAbandonmentScheduler.ts`) como una
// prueba con "reloj simulado" (ver `tests/integration/marketing/abandono.spec.ts`)
// ejercitan EXACTAMENTE la misma consulta.
import type { DbClient } from "@atiende-hoteles/db";
import { QUOTE_ABANDONMENT_WINDOWS, type QuoteAbandonmentWindowKey } from "@atiende-hoteles/domain-hotel";

export interface DetectAbandonedQuotesParams {
  hotelId: string;
  tenantId: string;
}

export interface DetectAbandonedQuotesOptions {
  /** Reloj inyectable (default: la hora real). Nunca se lee `Date.now()` en ningún otro
   *  punto de este módulo -- toda comparación de vencimiento pasa por este valor. */
  now?: () => Date;
}

export interface AbandonedQuoteContact {
  reservationId: string;
  guestId: string | null;
  window: QuoteAbandonmentWindowKey;
}

export interface DetectAbandonedQuotesResult {
  contacted: AbandonedQuoteContact[];
}

// Nombre de columna por ventana -- whitelist FIJA (nunca derivada de entrada externa),
// las 3 únicas columnas que existen de verdad (migración 0130). Interpolar un nombre de
// columna en SQL solo es seguro cuando, como aquí, el valor viene de una constante del
// propio código -- jamás de `params`/`body` de un request.
const WINDOW_COLUMNS: Record<QuoteAbandonmentWindowKey, string> = {
  "10m": "abandonment_contacted_10m_at",
  "2h": "abandonment_contacted_2h_at",
  "24h": "abandonment_contacted_24h_at",
};

/**
 * REQ-RES-011: escanea `hotelId` en busca de cotizaciones (`reservation.status =
 * 'cotizada'`) que acaban de alcanzar alguna de las 3 ventanas de abandono (10 min, 2h,
 * 24h, `@atiende-hoteles/domain-hotel::QUOTE_ABANDONMENT_WINDOWS`) y que TODAVÍA no
 * recibieron el contacto de ESA ventana -- marca la columna correspondiente (idempotente:
 * una segunda corrida sobre la misma reserva/ventana no vuelve a tocarla, mismo criterio
 * que `notifyApproachingSlaGuestTickets`) y encola UN evento `reservation.
 * abandonment_contact` por `public.outbox` (entregado por el worker de correo YA
 * existente, `emailOutbox/buildEmailOutboxHandlers.ts` + `runEmailOutboxWorker.ts` --
 * este job nunca envía correo directo, solo decide y encola, mismo principio de capas
 * que `routes/reservas.ts` insertando `reservation.created`/`reservation.confirmed`).
 *
 * Una reserva que avanza a `confirmada`/`cancelada` antes de una ventana deja de
 * calificar para ESA ventana y para cualquier ventana posterior (el `where status =
 * 'cotizada'` de cada UPDATE la excluye) -- sin necesitar limpiar las columnas ya
 * marcadas.
 */
export async function detectAndMarkAbandonedQuotes(
  db: DbClient,
  params: DetectAbandonedQuotesParams,
  opts: DetectAbandonedQuotesOptions = {},
): Promise<DetectAbandonedQuotesResult> {
  const now = (opts.now ?? (() => new Date()))();
  const contacted: AbandonedQuoteContact[] = [];

  for (const window of QUOTE_ABANDONMENT_WINDOWS) {
    const column = WINDOW_COLUMNS[window.key];

    const { rows } = await db.query<{ id: string; guest_id: string | null }>(
      `update public.reservation
       set ${column} = $1
       where hotel_id = $2
         and status = 'cotizada'
         and ${column} is null
         and created_at + ($3 * interval '1 minute') <= $1
       returning id, guest_id;`,
      [now, params.hotelId, window.minutes],
    );

    if (rows.length === 0) continue;

    for (const r of rows) {
      contacted.push({ reservationId: r.id, guestId: r.guest_id, window: window.key });

      await db.query(
        `insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
         values ($1, $2, 'reservation', $3, 'reservation.abandonment_contact', $4);`,
        [params.tenantId, params.hotelId, r.id, JSON.stringify({ reservationId: r.id, window: window.key })],
      );
    }

    await db.query(
      "select public.record_audit_log($1, $2, 'reservation.abandono_contactado', 'reservation', null, $3);",
      [
        params.tenantId,
        params.hotelId,
        JSON.stringify({
          reservationIds: rows.map((r) => r.id),
          ventana: window.key,
          contactadoAl: now.toISOString(),
        }),
      ],
    );
  }

  return { contacted };
}
