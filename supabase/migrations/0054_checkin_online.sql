-- ORIGEN: packages/db/migrations/0054_checkin_online.sql sha256:50814d7e64189ac7a340c431a245578e8a2fab483f2f72700f0bb5efa0ee7c6f
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-RES-016: "El check-in online (pre-llegada) debe capturar datos del huésped,
-- foto de documento con OCR, firma de registro, pago/garantía, hora de llegada
-- estimada y RFC para CFDI, mediante un WhatsApp Flow cifrado o un formulario web de
-- un solo uso — nunca por chat libre."
--
-- Alcance de este pase (documentado en docs/cierre-p0/inventario.md): se implementa
-- el formulario web de UN SOLO USO (token de un solo uso, `checkin_link`); el
-- "WhatsApp Flow cifrado" requiere credenciales reales de Meta (Flows es una
-- funcionalidad de pago del Tech Provider) y NO se simula. "Pago/garantía" requiere
-- una pasarela real (REQ-RES-003/008 ya la marcan como dependencia externa) y tampoco
-- se simula aquí -- este check-in captura datos/identidad/ETA/RFC/firma reales, sin
-- fabricar un cobro que no existe.
--
-- La identidad del documento reutiliza EXACTAMENTE `register_identity_document()`
-- (migración 0051, REQ-REC-011) -- nunca se duplica esa lógica.

create table public.checkin_link (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  -- El token se genera en CÓDIGO DE APLICACIÓN (crypto.randomBytes, mismo criterio
  -- que el cifrado de la bóveda de identidad -- nunca con gen_random_bytes(), que
  -- requeriría pgcrypto, deliberadamente no usado en este esquema, ver migración 0001).
  token text not null unique,
  status text not null default 'pendiente' check (status in ('pendiente', 'completado', 'expirado')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index checkin_link_reservation_idx on public.checkin_link (reservation_id);
-- Un solo enlace PENDIENTE a la vez por reserva -- emitir uno nuevo mientras el
-- anterior sigue pendiente debe invalidar expresamente al anterior primero (ver
-- routes/checkinOnline.ts), nunca dejar dos enlaces "vivos" simultáneos para la misma
-- reserva.
create unique index checkin_link_reservation_pendiente_idx on public.checkin_link (reservation_id) where status = 'pendiente';

alter table public.checkin_link enable row level security;
create policy "checkin_link_tenant_select" on public.checkin_link for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "checkin_link_tenant_insert" on public.checkin_link for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
-- El staff SÍ puede invalidar (expirar) manualmente un enlace pendiente -- p. ej. al
-- emitir uno nuevo, o si el huésped reporta que lo perdió (routes/checkinOnline.ts).
-- Completar el check-in en sí (pendiente -> completado) sigue siendo EXCLUSIVO de
-- `complete_checkin_public()` (SECURITY DEFINER, abajo): el huésped que lo completa
-- NUNCA tiene una sesión de staff, así que esta policy nunca le aplica a él.
create policy "checkin_link_tenant_update" on public.checkin_link for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));
grant select, insert, update on public.checkin_link to authenticated;

create table public.checkin_submission (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  checkin_link_id uuid not null references public.checkin_link(id) on delete cascade,
  eta_estimada timestamptz,
  rfc text,
  -- Firma de registro: se acepta y almacena tal cual (imagen vectorial/raster como
  -- data URL) -- a diferencia del documento de identidad, una firma de registro no es
  -- succeptible de la misma política de "borrar tras OCR" (no hay OCR involucrado
  -- aquí, es la firma misma la que constituye el registro legal).
  signature_data_url text not null,
  identity_ref_id uuid references public.identity_ref(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index checkin_submission_link_idx on public.checkin_submission (checkin_link_id);
create index checkin_submission_tenant_hotel_idx on public.checkin_submission (tenant_id, hotel_id);

alter table public.checkin_submission enable row level security;
create policy "checkin_submission_tenant_select" on public.checkin_submission for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
grant select on public.checkin_submission to authenticated;
-- Sin policy de insert para `authenticated`: solo `complete_checkin_public()` escribe.

-- complete_checkin_public(): único punto de escritura del check-in online. Nótese que
-- reutiliza `register_identity_document()` (0051) para el documento -- nunca duplica
-- esa lógica ni sus reglas de validación.
create or replace function public.complete_checkin_public(
  _token text,
  _full_name text,
  _email text,
  _phone text,
  _eta_estimada timestamptz,
  _rfc text,
  _signature_data_url text,
  _document_type text,
  _nationality text,
  _document_last4 text,
  _document_number_ciphertext bytea,
  _document_number_iv bytea,
  _document_number_auth_tag bytea
)
returns table (submission_id uuid, reservation_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.checkin_link;
  v_res public.reservation;
  v_identity_ref_id uuid;
  v_submission_id uuid;
begin
  select * into v_link from public.checkin_link where token = _token for update;
  if not found then
    raise exception 'checkin_link_no_encontrado: el enlace de check-in no existe' using errcode = 'P0001';
  end if;

  if v_link.status = 'completado' then
    raise exception 'checkin_link_ya_usado: este enlace de check-in ya fue utilizado (de un solo uso)'
      using errcode = 'P0001';
  end if;

  if v_link.expires_at < now() then
    update public.checkin_link set status = 'expirado' where id = v_link.id and status = 'pendiente';
    raise exception 'checkin_link_expirado: este enlace de check-in ya venció' using errcode = 'P0001';
  end if;

  if _signature_data_url is null or length(trim(_signature_data_url)) = 0 then
    raise exception 'firma_requerida: la firma de registro es obligatoria' using errcode = 'P0001';
  end if;

  select * into v_res from public.reservation where id = v_link.reservation_id;

  update public.guest
  set full_name = coalesce(nullif(trim(_full_name), ''), full_name),
      email = coalesce(nullif(trim(_email), ''), email),
      phone = coalesce(nullif(trim(_phone), ''), phone)
  where id = v_res.guest_id;

  select r.id into v_identity_ref_id
  from public.register_identity_document(
    v_link.tenant_id, v_link.hotel_id, v_res.id, _full_name, _nationality, _document_type, _document_last4,
    _document_number_ciphertext, _document_number_iv, _document_number_auth_tag, 30
  ) r;

  -- Sincroniza las columnas de `guest` que H1 (migración 0005_guest.sql) ya reservó
  -- exactamente para esto (`identity_ref`/`document_type`/`document_last4`) pero que
  -- ningún flujo llenaba todavía -- nunca se duplica el dato sensible, solo la
  -- referencia y los campos ya declarados "seguros" (mismos que expone
  -- `public.identity_ref`).
  update public.guest
  set identity_ref = v_identity_ref_id, document_type = _document_type, document_last4 = _document_last4
  where id = v_res.guest_id;

  insert into public.checkin_submission
    (tenant_id, hotel_id, reservation_id, checkin_link_id, eta_estimada, rfc, signature_data_url, identity_ref_id)
  values
    (v_link.tenant_id, v_link.hotel_id, v_res.id, v_link.id, _eta_estimada, _rfc, _signature_data_url, v_identity_ref_id)
  returning id into v_submission_id;

  -- Marca el enlace usado SOLO ahora (todo lo anterior tuvo éxito) -- de un solo uso
  -- real: un segundo intento con el MISMO token, aun con datos distintos, siempre
  -- encuentra `status = 'completado'` y es rechazado arriba.
  update public.checkin_link set status = 'completado', completed_at = now() where id = v_link.id;

  perform public.record_audit_log(v_link.tenant_id, v_link.hotel_id, 'checkin_online.completed', 'checkin_link', v_link.id,
    jsonb_build_object('reservationId', v_res.id, 'submissionId', v_submission_id));

  return query select v_submission_id, v_res.id;
end;
$$;

revoke all on function public.complete_checkin_public(text, text, text, text, timestamptz, text, text, text, text, text, bytea, bytea, bytea) from public;
grant execute on function public.complete_checkin_public(text, text, text, text, timestamptz, text, text, text, text, text, bytea, bytea, bytea) to atiende_app, authenticated;

-- get_checkin_link_public(): datos mínimos para RENDERIZAR el formulario (nombre del
-- huésped, hotel, fechas) -- SIN exponer nunca datos de otra reserva ni el propio
-- token de otro huésped. No requiere sesión de staff (el huésped nunca la tiene).
create or replace function public.get_checkin_link_public(_token text)
returns table (
  hotel_name text,
  guest_full_name text,
  check_in_date date,
  check_out_date date,
  status text,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select l.name as hotel_name, g.full_name as guest_full_name, r.check_in_date, r.check_out_date,
         cl.status, cl.expires_at
  from public.checkin_link cl
  join public.reservation r on r.id = cl.reservation_id
  join public.location l on l.id = cl.hotel_id
  left join public.guest g on g.id = r.guest_id
  where cl.token = _token;
$$;

revoke all on function public.get_checkin_link_public(text) from public;
grant execute on function public.get_checkin_link_public(text) to atiende_app, authenticated;
