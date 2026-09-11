// REQ-CRM-010 (P3/F): capa de datos real del UGC capturado post-estancia -- inserta vía
// `capture_guest_ugc()` (SECURITY DEFINER, migración 0131, valida "post-estancia" y
// registra el consentimiento de uso en el ledger de REQ-HUE-024) y delega la decisión de
// qué está USABLE y cómo armar el calendario mensual a `@atiende-hoteles/domain-hotel`
// (mismo principio de separación que `clubSegundoViaje.ts`/`pms/taxConfig.ts`).
import type { DbClient } from "@atiende-hoteles/db";
import type { GuestUgcSubmission, UgcMediaType } from "@atiende-hoteles/domain-hotel";

export interface CaptureGuestUgcParams {
  tenantId: string;
  hotelId: string;
  guestId: string;
  reservationId: string;
  mediaType: UgcMediaType;
  mediaReference: string;
  caption: string | null;
  avisoVersion: string;
  granted: boolean;
}

interface UgcSubmissionRow {
  id: string;
  guest_id: string;
  reservation_id: string;
  media_type: string;
  media_reference: string;
  caption: string | null;
  created_at: string;
}

export async function captureGuestUgc(db: DbClient, params: CaptureGuestUgcParams): Promise<GuestUgcSubmission & { consentGranted: boolean }> {
  const { rows } = await db.query<UgcSubmissionRow>(
    `select id, guest_id, reservation_id, media_type::text as media_type, media_reference, caption,
            created_at::text as created_at
     from public.capture_guest_ugc($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
    [
      params.tenantId,
      params.hotelId,
      params.guestId,
      params.reservationId,
      params.mediaType,
      params.mediaReference,
      params.caption,
      params.avisoVersion,
      params.granted,
    ],
  );
  const row = rows[0]!;
  return {
    id: row.id,
    guestId: row.guest_id,
    reservationId: row.reservation_id,
    mediaType: row.media_type as UgcMediaType,
    mediaReference: row.media_reference,
    caption: row.caption,
    consentGranted: params.granted,
    capturedAt: row.created_at,
  };
}

/**
 * Carga todo el UGC capturado del hotel con el `granted` del consentimiento LIGADO a
 * cada captura (join a `consent` por `consent_id`, no "el consentimiento más reciente
 * del huésped" -- cada captura queda atada al consentimiento otorgado/negado en esa
 * misma interacción, ver migración 0131). Esta es la lista cruda: filtrar lo usable es
 * responsabilidad de `filterUsableUgc()`/`generateMonthlyContentCalendar()`
 * (`@atiende-hoteles/domain-hotel`), nunca de este query.
 */
export async function loadGuestUgcSubmissions(db: DbClient, hotelId: string): Promise<GuestUgcSubmission[]> {
  const { rows } = await db.query<UgcSubmissionRow & { granted: boolean }>(
    `select s.id, s.guest_id, s.reservation_id, s.media_type::text as media_type, s.media_reference, s.caption,
            s.created_at::text as created_at, c.granted
     from public.guest_ugc_submission s
     join public.consent c on c.id = s.consent_id
     where s.hotel_id = $1
     order by s.created_at asc;`,
    [hotelId],
  );
  return rows.map((row) => ({
    id: row.id,
    guestId: row.guest_id,
    reservationId: row.reservation_id,
    mediaType: row.media_type as UgcMediaType,
    mediaReference: row.media_reference,
    caption: row.caption,
    consentGranted: row.granted,
    capturedAt: row.created_at,
  }));
}
