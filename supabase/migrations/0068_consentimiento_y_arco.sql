-- ORIGEN: packages/db/migrations/0068_consentimiento_y_arco.sql sha256:195851431d3a361d96e140da1a6ee796df4d6331a6ea83ded31b34d8cc7cc2ff
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- auditoria-2/legal:
--   [ALTO] "El check-in online captura el documento de identidad del huesped sin
--   registrar ningun consentimiento" -- ninguna columna/hash/timestamp de aceptacion.
--   [ALTO] "No existe ninguna infraestructura de opt-in/opt-out de marketing en todo el
--   esquema" -- sin tabla `consent`/`opt_in`/`opt_out`.
--   [ALTO] "No hay ningun camino operable para ejercer derechos ARCO" -- sin endpoint
--   de exportacion/borrado, sin registro auditable con SLA.
--
-- Alcance de este pase (documentado en docs/auditoria-2/correccion-A-seguridad-legal.md):
-- se construye la infraestructura de datos + las dos funciones SECURITY DEFINER minimas
-- (registrar consentimiento, exportar datos de un huesped via enlace de un solo uso,
-- crear un ticket ARCO auditado) y se cablea en el check-in online (unico flujo de
-- captura de identidad que este lote de correccion puede tocar -- el primer contacto de
-- WhatsApp vive en `apps/api/src/routes/mensajeria.ts`, que pertenece al otro lote de
-- correccion en curso: la tabla `consent`/`record_consent()` ya queda lista para que
-- ese lote la use, ver nota en la cabecera de docs/auditoria-2/correccion-A-seguridad-legal.md).
-- El "bloqueo automatico tras BAJA" en el envio de plantillas de marketing
-- (packages/agent-core/src/tools/messagingTools.ts) tambien pertenece a ese otro lote
-- (packages/agent-core esta fuera de alcance de este corrector) -- queda declarado
-- `pendiente-coordinacion`, no `resuelto`.

create type public.consent_channel as enum ('checkin_online', 'whatsapp', 'web', 'presencial');
create type public.consent_kind as enum ('tratamiento_datos', 'marketing');

create table public.consent (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid references public.guest(id) on delete set null,
  reservation_id uuid references public.reservation(id) on delete set null,
  channel public.consent_channel not null,
  consent_kind public.consent_kind not null,
  aviso_version text not null,
  granted boolean not null,
  created_at timestamptz not null default now()
);
create index consent_tenant_hotel_idx on public.consent (tenant_id, hotel_id, created_at);
create index consent_guest_idx on public.consent (guest_id) where guest_id is not null;
create index consent_reservation_idx on public.consent (reservation_id) where reservation_id is not null;
-- FK compuesta desde el nacimiento de la tabla (mismo criterio que 0060/0061/0064):
-- un registro de consentimiento de Hotel A nunca puede apuntar a un guest de Hotel B.
alter table public.consent
  add constraint consent_guest_hotel_fk
  foreign key (hotel_id, guest_id) references public.guest (hotel_id, id) on delete set null (guest_id);
alter table public.consent
  add constraint consent_reservation_hotel_fk
  foreign key (hotel_id, reservation_id) references public.reservation (hotel_id, id) on delete set null (reservation_id);

alter table public.consent enable row level security;
create policy "consent_staff_select" on public.consent for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
grant select on public.consent to authenticated;
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- `record_consent()` (SECURITY DEFINER, abajo) -- un registro de consentimiento es
-- append-only, igual que audit_log/agent_run.

create or replace function public.record_consent(
  _tenant_id uuid,
  _hotel_id uuid,
  _reservation_id uuid,
  _guest_id uuid,
  _channel text,
  _consent_kind text,
  _aviso_version text,
  _granted boolean
)
returns public.consent
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_row public.consent;
begin
  v_actor := auth.uid();
  if v_actor is not null then
    if not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (record_consent)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if not (_hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (record_consent)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  if _aviso_version is null or length(trim(_aviso_version)) = 0 then
    raise exception 'aviso_version_requerida: todo consentimiento debe registrar la version del aviso aceptado' using errcode = 'P0001';
  end if;

  insert into public.consent (tenant_id, hotel_id, reservation_id, guest_id, channel, consent_kind, aviso_version, granted)
  values (_tenant_id, _hotel_id, _reservation_id, _guest_id, _channel::public.consent_channel, _consent_kind::public.consent_kind, _aviso_version, _granted)
  returning * into v_row;

  perform public.record_audit_log(_tenant_id, _hotel_id, 'consent.recorded', 'consent', v_row.id,
    jsonb_build_object('channel', _channel, 'consentKind', _consent_kind, 'granted', _granted, 'avisoVersion', _aviso_version));

  return v_row;
end;
$$;

revoke all on function public.record_consent(uuid, uuid, uuid, uuid, text, text, text, boolean) from public;
grant execute on function public.record_consent(uuid, uuid, uuid, uuid, text, text, text, boolean) to atiende_app, authenticated;

-- ---------------------------------------------------------------------------
-- ARCO: ticket auditado con SLA (REQ-SEG-002, "resuelto dentro del plazo legal <=20
-- dias con registro auditable") + exportacion de datos por enlace de un solo uso.
-- ---------------------------------------------------------------------------
create table public.privacy_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid references public.guest(id) on delete set null,
  tipo text not null check (tipo in ('acceso', 'rectificacion', 'cancelacion', 'oposicion')),
  contacto text not null,
  detalle text,
  status text not null default 'recibida' check (status in ('recibida', 'en_proceso', 'resuelta', 'rechazada')),
  sla_due_at timestamptz not null default (now() + interval '20 days'),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text
);
create index privacy_request_tenant_hotel_idx on public.privacy_request (tenant_id, hotel_id, status);
alter table public.privacy_request
  add constraint privacy_request_guest_hotel_fk
  foreign key (hotel_id, guest_id) references public.guest (hotel_id, id) on delete set null (guest_id);

alter table public.privacy_request enable row level security;
-- Solo owner/gm gestionan tickets ARCO (mismo criterio que sat_filing_approval/
-- read_identity_vault_document: la decision de rectificar/cancelar/oponerse datos de
-- huesped es de nivel administrativo, no de cualquier rol operativo).
create policy "privacy_request_admin_select" on public.privacy_request for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "privacy_request_admin_update" on public.privacy_request for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
grant select, update on public.privacy_request to authenticated;
-- Sin policy de insert para `authenticated`: quien solicita ARCO normalmente no tiene
-- sesion de staff (es un huesped) -- toda creacion pasa por `create_privacy_request()`.

create or replace function public.create_privacy_request(
  _hotel_id uuid,
  _tipo text,
  _contacto text,
  _detalle text default null
)
returns public.privacy_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_row public.privacy_request;
begin
  select org_id into v_tenant_id from public.hotel where id = _hotel_id;
  if not found then
    raise exception 'hotel_no_encontrado: % no existe' , _hotel_id using errcode = 'P0001';
  end if;

  if _tipo not in ('acceso', 'rectificacion', 'cancelacion', 'oposicion') then
    raise exception 'tipo_invalido: "%" no es acceso/rectificacion/cancelacion/oposicion', _tipo using errcode = 'P0001';
  end if;

  if _contacto is null or length(trim(_contacto)) = 0 then
    raise exception 'contacto_requerido: se requiere un correo o telefono de contacto para dar seguimiento' using errcode = 'P0001';
  end if;

  insert into public.privacy_request (tenant_id, hotel_id, tipo, contacto, detalle)
  values (v_tenant_id, _hotel_id, _tipo, trim(_contacto), _detalle)
  returning * into v_row;

  perform public.record_audit_log(v_tenant_id, _hotel_id, 'privacy_request.created', 'privacy_request', v_row.id,
    jsonb_build_object('tipo', _tipo));

  return v_row;
end;
$$;

revoke all on function public.create_privacy_request(uuid, text, text, text) from public;
grant execute on function public.create_privacy_request(uuid, text, text, text) to atiende_app, authenticated;

-- Enlace de un solo uso para que el HUESPED (sin sesion de staff) exporte sus propios
-- datos -- mismo patron que `checkin_link` (token de 256 bits generado en codigo de
-- aplicacion, de un solo uso real via `for update` + marca `usado` al final).
create table public.guest_data_export_link (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  token text not null unique,
  status text not null default 'pendiente' check (status in ('pendiente', 'usado', 'expirado')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index guest_data_export_link_guest_idx on public.guest_data_export_link (guest_id);
alter table public.guest_data_export_link
  add constraint guest_data_export_link_guest_hotel_fk
  foreign key (hotel_id, guest_id) references public.guest (hotel_id, id) on delete cascade;

alter table public.guest_data_export_link enable row level security;
create policy "guest_data_export_link_staff_select" on public.guest_data_export_link for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "guest_data_export_link_staff_insert" on public.guest_data_export_link for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
grant select, insert on public.guest_data_export_link to authenticated;

create or replace function public.export_guest_data_public(_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.guest_data_export_link;
  v_guest public.guest;
  v_result jsonb;
begin
  select * into v_link from public.guest_data_export_link where token = _token for update;
  if not found then
    raise exception 'export_link_no_encontrado: el enlace de exportacion no existe' using errcode = 'P0001';
  end if;

  if v_link.status = 'usado' then
    raise exception 'export_link_ya_usado: este enlace ya fue utilizado (de un solo uso)' using errcode = 'P0001';
  end if;

  if v_link.expires_at < now() then
    update public.guest_data_export_link set status = 'expirado' where id = v_link.id and status = 'pendiente';
    raise exception 'export_link_expirado: este enlace ya vencio' using errcode = 'P0001';
  end if;

  select * into v_guest from public.guest where id = v_link.guest_id and hotel_id = v_link.hotel_id;
  if not found then
    raise exception 'guest_no_encontrado: el huesped del enlace ya no existe' using errcode = 'P0001';
  end if;

  select jsonb_build_object(
    'huesped', jsonb_build_object(
      'nombreCompleto', v_guest.full_name,
      'email', v_guest.email,
      'telefono', v_guest.phone,
      'tipoDocumento', v_guest.document_type,
      'ultimos4Documento', v_guest.document_last4
    ),
    'reservas', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id, 'checkIn', r.check_in_date, 'checkOut', r.check_out_date, 'estado', r.status
      ) order by r.check_in_date desc), '[]'::jsonb)
      from public.reservation r where r.guest_id = v_guest.id and r.hotel_id = v_link.hotel_id
    ),
    'consentimientos', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'canal', co.channel, 'tipo', co.consent_kind, 'otorgado', co.granted, 'fecha', co.created_at, 'avisoVersion', co.aviso_version
      ) order by co.created_at desc), '[]'::jsonb)
      from public.consent co where co.guest_id = v_guest.id and co.hotel_id = v_link.hotel_id
    )
  ) into v_result;

  update public.guest_data_export_link set status = 'usado', used_at = now() where id = v_link.id;

  perform public.record_audit_log(v_link.tenant_id, v_link.hotel_id, 'privacy.data_exported', 'guest', v_guest.id,
    jsonb_build_object('exportLinkId', v_link.id));

  return v_result;
end;
$$;

revoke all on function public.export_guest_data_public(text) from public;
grant execute on function public.export_guest_data_public(text) to atiende_app, authenticated;
