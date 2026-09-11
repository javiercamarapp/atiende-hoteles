-- ORIGEN: packages/db/migrations/0149_guest_ugc_submission.sql sha256:5209f9a0d1e75cd07e240d13a610e598dfbf775563070c0ec43d94df30518609
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-CRM-010 (P3/F): "El sistema debe capturar contenido generado por el huésped (UGC)
-- vía WhatsApp post-estancia con registro explícito de consentimiento de uso, y generar
-- un calendario mensual de contenido/publicaciones." (H05-005, H05-018).
--
-- `guest_ugc_submission` es la captura (una fila por foto/video/texto que el huésped
-- mandó); el consentimiento de uso vive en `consent` (`consent_kind = 'ugc'`, migración
-- 0148 -- append-only, mismo ledger que REQ-HUE-024) y esta tabla lo referencia por
-- `consent_id`: cada captura queda ligada al consentimiento otorgado o negado EN ESA
-- MISMA interacción, nunca a "el último consentimiento que sea" -- la fila nunca se
-- borra ni se sobreescribe aunque el consentimiento haya sido `granted = false` (el dato
-- se conserva para trazabilidad; lo que cambia es si puede USARSE, decidido en
-- `@atiende-hoteles/domain-hotel` `filterUsableUgc()`/`generateMonthlyContentCalendar()`
-- a partir del `granted` del consentimiento ligado).
--
-- `capture_guest_ugc()` (SECURITY DEFINER, mismo patrón que `record_consent()`) es el
-- ÚNICO camino de escritura -- exige que la reserva ya esté en post-estancia
-- (`check_out`/`cerrada`, `reservationStateMachine.ts` H4) antes de aceptar la captura:
-- "post-estancia" es parte literal del criterio de aceptación, no una preferencia de UX.
create type public.ugc_media_type as enum ('foto', 'video', 'texto');

create table public.guest_ugc_submission (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  -- Consentimiento de USO registrado en la MISMA captura -- `restrict` (nunca se borra
  -- un consentimiento ya emitido, es append-only, ver 0068) así que esta FK jamás queda
  -- huérfana.
  consent_id uuid not null references public.consent(id) on delete restrict,
  media_type public.ugc_media_type not null,
  -- Referencia al contenido (media id de WhatsApp o URL ya subida) -- este repo no
  -- descarga/realoja el binario (requeriría credenciales reales de Meta para bajar el
  -- media, fuera del alcance "ninguna dependencia" de este REQ, mismo criterio que
  -- REQ-HUE-024 con el ledger de consentimiento): guarda la referencia, no el archivo.
  media_reference text not null check (length(trim(media_reference)) > 0),
  caption text,
  created_at timestamptz not null default now()
);
create index guest_ugc_submission_tenant_hotel_idx on public.guest_ugc_submission (tenant_id, hotel_id, created_at);
create index guest_ugc_submission_guest_idx on public.guest_ugc_submission (guest_id);
create index guest_ugc_submission_consent_idx on public.guest_ugc_submission (consent_id);
-- FK compuesta (mismo criterio que 0060/0061/0064/0068): una captura de Hotel A nunca
-- puede apuntar a un guest/reserva de Hotel B.
alter table public.guest_ugc_submission
  add constraint guest_ugc_submission_guest_hotel_fk
  foreign key (hotel_id, guest_id) references public.guest (hotel_id, id) on delete cascade;
alter table public.guest_ugc_submission
  add constraint guest_ugc_submission_reservation_hotel_fk
  foreign key (hotel_id, reservation_id) references public.reservation (hotel_id, id) on delete cascade;

alter table public.guest_ugc_submission enable row level security;
create policy "guest_ugc_submission_staff_select" on public.guest_ugc_submission for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
grant select on public.guest_ugc_submission to authenticated;
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- `capture_guest_ugc()` (SECURITY DEFINER, abajo) -- append-only, igual que `consent`.

create or replace function public.capture_guest_ugc(
  _tenant_id uuid,
  _hotel_id uuid,
  _guest_id uuid,
  _reservation_id uuid,
  _media_type text,
  _media_reference text,
  _caption text,
  _aviso_version text,
  _granted boolean
)
returns public.guest_ugc_submission
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_reservation_status public.reservation_status;
  v_consent public.consent;
  v_row public.guest_ugc_submission;
begin
  v_actor := auth.uid();
  if v_actor is not null then
    if not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (capture_guest_ugc)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if not (_hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (capture_guest_ugc)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  select status into v_reservation_status
  from public.reservation
  where id = _reservation_id and hotel_id = _hotel_id and guest_id = _guest_id;

  if v_reservation_status is null then
    raise exception 'reserva_no_encontrada: la reserva % no pertenece al huesped %/hotel % (capture_guest_ugc)', _reservation_id, _guest_id, _hotel_id
      using errcode = 'P0002';
  end if;

  -- "post-estancia" (criterio de aceptación literal): solo check_out/cerrada, nunca
  -- durante la estancia ni antes de que exista la reserva.
  if v_reservation_status not in ('check_out', 'cerrada') then
    raise exception 'reserva_no_finalizada: el UGC solo se captura post-estancia (reserva %, estado actual %)', _reservation_id, v_reservation_status
      using errcode = 'P0001';
  end if;

  if _media_reference is null or length(trim(_media_reference)) = 0 then
    raise exception 'media_reference_requerida: se requiere una referencia del contenido capturado' using errcode = 'P0001';
  end if;

  -- Reutiliza el ledger de consentimiento ya existente (0068/REQ-HUE-024) -- el mismo
  -- SECURITY DEFINER que ya valida `aviso_version_requerida`.
  select * into v_consent
  from public.record_consent(_tenant_id, _hotel_id, _reservation_id, _guest_id, 'whatsapp', 'ugc', _aviso_version, _granted);

  insert into public.guest_ugc_submission
    (tenant_id, hotel_id, guest_id, reservation_id, consent_id, media_type, media_reference, caption)
  values
    (_tenant_id, _hotel_id, _guest_id, _reservation_id, v_consent.id, _media_type::public.ugc_media_type, _media_reference, _caption)
  returning * into v_row;

  perform public.record_audit_log(_tenant_id, _hotel_id, 'ugc.captured', 'guest_ugc_submission', v_row.id,
    jsonb_build_object('mediaType', _media_type, 'granted', _granted, 'reservationId', _reservation_id));

  return v_row;
end;
$$;

revoke all on function public.capture_guest_ugc(uuid, uuid, uuid, uuid, text, text, text, text, boolean) from public;
grant execute on function public.capture_guest_ugc(uuid, uuid, uuid, uuid, text, text, text, text, boolean) to atiende_app, authenticated;
