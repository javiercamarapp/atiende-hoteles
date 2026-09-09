-- Schema consolidado para el proyecto Supabase unificado — vertical: hoteles
CREATE SCHEMA IF NOT EXISTS hoteles;
SET search_path TO hoteles, public;

-- Generado automáticamente concatenando packages/db/migrations/*.sql (hoteles)
-- No editar a mano; regenerar desde el repo si cambian las migraciones.

-- ==== 0001_extensions_and_auth.sql ====
-- H1 · Esquema base: identidad compatible con Supabase (auth.uid()) + roles de conexión.
--
-- No se usa `create extension pgcrypto`: `gen_random_uuid()` es nativo desde Postgres 13
-- y las funciones SHA-2 (`sha256`, usadas por audit_log) son nativas desde Postgres 11.
-- docs/referencia/07-stack-viabilidad.md Experimento 1 confirma que `pgcrypto` standalone
-- falla en PGlite 0.5.8 aunque `gen_random_uuid()` funciona sin la extensión — por eso este
-- esquema evita cualquier `create extension` para mantenerse portable entre PGlite y
-- `embedded-postgres` (ADR-003).

create schema if not exists auth;

-- Emulación LOCAL (solo PGlite/embedded-postgres) de auth.uid() de Supabase: lee el claim
-- `sub` que la capa de sesión (ADR-004) inyecta con
-- `select set_config('request.jwt.claim.sub', <user_id>, true)` antes de cada query de
-- negocio. Contra un proyecto Supabase real, auth.uid() ya existe con la misma firma;
-- esta función nunca se despliega ahí (ver ADR-003, "Consecuencias").
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

comment on function auth.uid() is
  'Emulacion local (PGlite/embedded-postgres) de auth.uid() de Supabase. No desplegar contra Supabase real: ahi ya existe esta funcion.';

-- Roles de conexion (ADR-003/ADR-004):
--   atiende_app    -> rol de LOGIN que usa el pool del backend (equivalente al
--                     `authenticator` de PostgREST/Supabase). Sin BYPASSRLS.
--   authenticated  -> rol SIN login al que se conmuta por transaccion
--                     (`set local role authenticated`), mismo nombre que usa
--                     Supabase/Restaurantes para que las mismas políticas RLS
--                     sean portables 1:1.
do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'atiende_app') then
    create role atiende_app login password 'atiende_app_dev_only_local'
      nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
  end if;
end
$do$;

grant authenticated to atiende_app;

-- Bloqueo por defecto: nada de PUBLIC en los esquemas de la aplicacion. Los grants
-- explicitos por tabla/función se hacen en cada migración y se refuerzan en
-- 0010_grants_and_lockdown.sql.
revoke all on schema public from public;
revoke all on schema auth from public;
grant usage on schema public to atiende_app, authenticated;
grant usage on schema auth to atiende_app, authenticated;
grant execute on function auth.uid() to atiende_app, authenticated;

-- ==== 0002_org_location_hotel.sql ====
-- H1 · REQ-TEN-002: cada hotel es una `location` con kind='hotel' bajo una `org` (tenant).
-- `hotel` es la extensión 1:1 de `location` cuando kind='hotel' (comparte PK con su fila
-- de location, garantizado por FK + trigger) para que el resto del esquema de dominio
-- referencie `hotel(id)` sin poder apuntar nunca a una location de otro kind.

create table public.org (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.location (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  kind text not null check (kind in ('hotel', 'restaurant')),
  name text not null,
  property_id uuid references public.location(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index location_org_idx on public.location (org_id);
create index location_property_idx on public.location (property_id) where property_id is not null;

create table public.hotel (
  id uuid primary key references public.location(id) on delete cascade,
  org_id uuid not null references public.org(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index hotel_org_idx on public.hotel (org_id);

create or replace function public.enforce_hotel_location_kind()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
  v_org_id uuid;
begin
  select kind, org_id into v_kind, v_org_id from public.location where id = new.id;

  if v_kind is null then
    raise exception 'hotel.id % no referencia una location existente', new.id;
  end if;
  if v_kind <> 'hotel' then
    raise exception 'hotel.id % referencia una location de kind=%, se esperaba kind=hotel', new.id, v_kind;
  end if;
  if new.org_id <> v_org_id then
    raise exception 'hotel.org_id (%) no coincide con location.org_id (%) para id %', new.org_id, v_org_id, new.id;
  end if;

  return new;
end;
$$;

create trigger hotel_enforce_location_kind_trg
  before insert or update on public.hotel
  for each row execute function public.enforce_hotel_location_kind();

-- RLS: org/location/hotel se habilitan aqui; las politicas que dependen de
-- current_tenant_ids()/current_hotel_ids() se agregan en 0003 una vez que existe
-- hotel_staff (esas funciones necesitan la tabla de membresia).
alter table public.org enable row level security;
alter table public.location enable row level security;
alter table public.hotel enable row level security;

-- ==== 0003_membership_and_rls_helpers.sql ====
-- H1 · REQ-TEN-003: 8 roles hoteleros exactos (owner, gm, frontdesk, reservations,
-- housekeeping, maintenance, fnb, accountant) via hotel_staff. Funciones de apoyo RLS
-- (ADR-004): derivan tenant/hotel del membership REAL del usuario autenticado
-- (auth.uid()), nunca de un valor que el cliente pueda fijar libremente en la sesion.

create type public.hotel_role as enum (
  'owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant'
);

create table public.staff_user (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  full_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.hotel_staff (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete cascade,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  user_id uuid not null references public.staff_user(id) on delete cascade,
  role public.hotel_role not null,
  created_at timestamptz not null default now(),
  unique (hotel_id, user_id)
);
create index hotel_staff_org_idx on public.hotel_staff (org_id);
create index hotel_staff_user_idx on public.hotel_staff (user_id);
create index hotel_staff_hotel_idx on public.hotel_staff (hotel_id);

-- current_tenant_ids()/current_hotel_ids() devuelven arreglos (no setof) para poder
-- escribir las politicas exactamente como las describe ADR-004:
-- `tenant_id = ANY(current_tenant_ids())`, `hotel_id = ANY(current_hotel_ids())`.
create or replace function public.current_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct org_id), '{}'::uuid[])
  from public.hotel_staff
  where user_id = auth.uid()
$$;

create or replace function public.current_hotel_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct hotel_id), '{}'::uuid[])
  from public.hotel_staff
  where user_id = auth.uid()
$$;

create or replace function public.has_hotel_role(_hotel_id uuid, _roles public.hotel_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.hotel_staff
    where user_id = auth.uid()
      and hotel_id = _hotel_id
      and role = any(_roles)
  )
$$;

create or replace function public.is_hotel_staff(_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.hotel_staff where user_id = auth.uid() and hotel_id = _hotel_id
  )
$$;

revoke all on function public.current_tenant_ids() from public;
revoke all on function public.current_hotel_ids() from public;
revoke all on function public.has_hotel_role(uuid, public.hotel_role[]) from public;
revoke all on function public.is_hotel_staff(uuid) from public;
grant execute on function public.current_tenant_ids() to atiende_app, authenticated;
grant execute on function public.current_hotel_ids() to atiende_app, authenticated;
grant execute on function public.has_hotel_role(uuid, public.hotel_role[]) to atiende_app, authenticated;
grant execute on function public.is_hotel_staff(uuid) to atiende_app, authenticated;

-- Politicas RLS de org/location/hotel (habilitadas en 0002).
create policy "org_member_select" on public.org for select to authenticated
  using (id = any (current_tenant_ids()));

create policy "location_member_select" on public.location for select to authenticated
  using (org_id = any (current_tenant_ids()));

create policy "hotel_member_select" on public.hotel for select to authenticated
  using (id = any (current_hotel_ids()));

alter table public.staff_user enable row level security;
create policy "staff_user_self_or_colleague_select" on public.staff_user for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.hotel_staff mine
      join public.hotel_staff theirs on theirs.hotel_id = mine.hotel_id
      where mine.user_id = auth.uid() and theirs.user_id = staff_user.id
    )
  );

alter table public.hotel_staff enable row level security;
create policy "hotel_staff_scope_select" on public.hotel_staff for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
create policy "hotel_staff_manage_insert" on public.hotel_staff for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_staff_manage_update" on public.hotel_staff for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_staff_manage_delete" on public.hotel_staff for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

-- ==== 0004_room_inventory.sql ====
-- H1 · room_type / room / rate_plan / availability (ADR-005) + advisory lock helper
-- (ADR-004) para proteger el decremento de inventario contra sobreventa.

create table public.room_type (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  name text not null,
  max_occupancy integer not null default 2 check (max_occupancy > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, name)
);
create index room_type_tenant_hotel_idx on public.room_type (tenant_id, hotel_id);

create type public.room_status as enum (
  'disponible', 'ocupada', 'sucia', 'fuera_de_servicio', 'mantenimiento'
);

create table public.room (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_type_id uuid not null references public.room_type(id) on delete restrict,
  code text not null,
  status public.room_status not null default 'disponible',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, code)
);
create index room_tenant_hotel_idx on public.room (tenant_id, hotel_id);
create index room_room_type_idx on public.room (room_type_id);

create table public.rate_plan (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_type_id uuid not null references public.room_type(id) on delete cascade,
  date date not null,
  price numeric(12, 2) not null check (price >= 0),
  currency text not null default 'MXN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_type_id, date)
);
create index rate_plan_tenant_hotel_date_idx on public.rate_plan (tenant_id, hotel_id, date);

create table public.availability (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_type_id uuid not null references public.room_type(id) on delete cascade,
  date date not null,
  total_rooms integer not null check (total_rooms >= 0),
  booked_rooms integer not null default 0 check (booked_rooms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, room_type_id, date),
  check (booked_rooms <= total_rooms)
);
create index availability_tenant_hotel_date_idx on public.availability (tenant_id, hotel_id, date);

-- Advisory lock helper (ADR-004/ADR-003): serializa el decremento de inventario por
-- (hotel_id, room_type_id, date) para que dos transacciones concurrentes disputando la
-- ultima habitacion resuelvan de forma determinista. Solo tiene valor probatorio real
-- contra `embedded-postgres` (PGlite serializa toda concurrencia, ver
-- docs/referencia/07-stack-viabilidad.md riesgo 1) — tests/integration lo verifica ahi.
create or replace function public.lock_availability(_hotel_id uuid, _room_type_id uuid, _date date)
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(_hotel_id::text || ':' || _room_type_id::text || ':' || _date::text, 0)
  );
end;
$$;

-- book_availability(): unica via de escritura recomendada para decrementar inventario.
-- Toma el advisory lock, relee la fila bajo lock, valida contra total_rooms y solo
-- entonces actualiza — nunca un UPDATE ciego. security invoker: corre con el rol de
-- quien llama para que las politicas RLS de `availability` sigan aplicando.
create or replace function public.book_availability(
  _hotel_id uuid,
  _room_type_id uuid,
  _date date,
  _qty integer default 1
)
returns public.availability
language plpgsql
as $$
declare
  v_row public.availability;
begin
  if _qty <= 0 then
    raise exception 'cantidad_invalida: _qty debe ser mayor a 0';
  end if;

  perform public.lock_availability(_hotel_id, _room_type_id, _date);

  select * into v_row
  from public.availability
  where hotel_id = _hotel_id and room_type_id = _room_type_id and date = _date
  for update;

  if not found then
    raise exception 'sin_disponibilidad: no existe inventario para hotel=%, room_type=%, fecha=%',
      _hotel_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  if v_row.booked_rooms + _qty > v_row.total_rooms then
    raise exception 'sin_disponibilidad: no hay habitaciones libres para hotel=%, room_type=%, fecha=%',
      _hotel_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  update public.availability
  set booked_rooms = booked_rooms + _qty, updated_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

alter table public.room_type enable row level security;
alter table public.room enable row level security;
alter table public.rate_plan enable row level security;
alter table public.availability enable row level security;

create policy "room_type_tenant_select" on public.room_type for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "room_type_tenant_insert" on public.room_type for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'reservations']::public.hotel_role[])
  );
create policy "room_type_tenant_update" on public.room_type for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'reservations']::public.hotel_role[]));
create policy "room_type_tenant_delete" on public.room_type for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "room_tenant_select" on public.room for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "room_tenant_insert" on public.room for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'maintenance']::public.hotel_role[])
  );
create policy "room_tenant_update" on public.room for update to authenticated
  using (
    has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'housekeeping', 'maintenance']::public.hotel_role[]
    )
  )
  with check (
    has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'housekeeping', 'maintenance']::public.hotel_role[]
    )
  );
create policy "room_tenant_delete" on public.room for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "rate_plan_tenant_select" on public.rate_plan for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "rate_plan_tenant_insert" on public.rate_plan for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'reservations']::public.hotel_role[])
  );
create policy "rate_plan_tenant_update" on public.rate_plan for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'reservations']::public.hotel_role[]));
create policy "rate_plan_tenant_delete" on public.rate_plan for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "availability_tenant_select" on public.availability for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "availability_tenant_insert" on public.availability for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'reservations']::public.hotel_role[])
  );
create policy "availability_tenant_update" on public.availability for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm', 'reservations', 'frontdesk']::public.hotel_role[])
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm', 'reservations', 'frontdesk']::public.hotel_role[])
  );
create policy "availability_tenant_delete" on public.availability for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

-- ==== 0005_guest.sql ====
-- H1 · guest minimo (ADR-005, REQ-REC-011 groundwork): nunca se guarda el documento
-- completo ni el PAN de tarjeta aqui — solo tipo/ultimos 4 digitos; `identity_ref` queda
-- como puntero a una boveda de identidad aislada que se construye en una fase posterior
-- (fuera de alcance de H1), documentado explicitamente para no fingir que ya existe.

create table public.guest (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  full_name text not null,
  email text,
  phone text,
  document_type text,
  document_last4 text check (document_last4 is null or length(document_last4) = 4),
  identity_ref uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index guest_tenant_hotel_idx on public.guest (tenant_id, hotel_id);

comment on column public.guest.identity_ref is
  'Puntero a boveda de identidad aislada (REQ-REC-011). La boveda en si no se construye en H1: fuera de alcance declarado, no simulado como completo.';

alter table public.guest enable row level security;

create policy "guest_tenant_select" on public.guest for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "guest_tenant_insert" on public.guest for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "guest_tenant_update" on public.guest for update to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()))
  with check (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "guest_tenant_delete" on public.guest for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]));

-- ==== 0006_reservation.sql ====
-- H1 · reservation (ADR-005): estados cotizada -> confirmada -> check_in -> en_estancia
-- -> check_out -> cerrada, laterales cancelada/no_show. Cada transicion se valida con un
-- trigger (constraint declarativo no alcanza para una maquina de estados con 8 nodos) y
-- se registra en `reservation_status_event`, append-only, como bitacora minima de tipo
-- event-sourcing (REQ-REC-004: "cada transicion es un evento append-only, nunca un UPDATE
-- destructivo del estado anterior" -- aqui el UPDATE de `status` sigue existiendo sobre la
-- fila viva de `reservation` para simplicidad operativa de H1, pero el historial de
-- transiciones queda preservado de forma inmutable en el evento).

create type public.reservation_status as enum (
  'cotizada', 'confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada', 'cancelada', 'no_show'
);

create table public.reservation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_type_id uuid not null references public.room_type(id) on delete restrict,
  guest_id uuid references public.guest(id) on delete set null,
  check_in_date date not null,
  check_out_date date not null check (check_out_date > check_in_date),
  status public.reservation_status not null default 'cotizada',
  idempotency_key text,
  total_amount numeric(12, 2) not null default 0 check (total_amount >= 0),
  currency text not null default 'MXN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reservation_tenant_hotel_dates_idx
  on public.reservation (tenant_id, hotel_id, check_in_date, check_out_date);
create unique index reservation_tenant_idempotency_key_idx
  on public.reservation (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.reservation_status_event (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  from_status public.reservation_status,
  to_status public.reservation_status not null,
  actor_user_id uuid,
  created_at timestamptz not null default now()
);
create index reservation_status_event_reservation_idx
  on public.reservation_status_event (reservation_id, created_at);
create index reservation_status_event_tenant_idx
  on public.reservation_status_event (tenant_id, hotel_id);

-- Tabla de transiciones validas, mas facil de auditar/extender que un CASE largo.
create table public.reservation_status_transition (
  from_status public.reservation_status not null,
  to_status public.reservation_status not null,
  primary key (from_status, to_status)
);
insert into public.reservation_status_transition (from_status, to_status) values
  ('cotizada', 'confirmada'),
  ('cotizada', 'cancelada'),
  ('confirmada', 'check_in'),
  ('confirmada', 'cancelada'),
  ('confirmada', 'no_show'),
  ('check_in', 'en_estancia'),
  ('en_estancia', 'check_out'),
  ('check_out', 'cerrada');

create or replace function public.reservation_validate_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if not exists (
    select 1 from public.reservation_status_transition
    where from_status = old.status and to_status = new.status
  ) then
    raise exception 'transicion_invalida: % -> % no esta permitida para reservation %',
      old.status, new.status, old.id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger reservation_validate_transition_trg
  before update of status on public.reservation
  for each row execute function public.reservation_validate_transition();

-- La bitacora de transiciones es append-only por diseño: solo se escribe via este
-- trigger SECURITY DEFINER; ningun rol de aplicacion recibe INSERT directo sobre
-- reservation_status_event (ver grants en 0010).
create or replace function public.reservation_log_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.reservation_status_event (reservation_id, tenant_id, hotel_id, from_status, to_status, actor_user_id)
    values (new.id, new.tenant_id, new.hotel_id, null, new.status, auth.uid());
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.reservation_status_event (reservation_id, tenant_id, hotel_id, from_status, to_status, actor_user_id)
    values (new.id, new.tenant_id, new.hotel_id, old.status, new.status, auth.uid());
  end if;

  return new;
end;
$$;

create trigger reservation_log_status_event_ins_trg
  after insert on public.reservation
  for each row execute function public.reservation_log_status_event();

create trigger reservation_log_status_event_upd_trg
  after update on public.reservation
  for each row execute function public.reservation_log_status_event();

alter table public.reservation enable row level security;
alter table public.reservation_status_event enable row level security;

create policy "reservation_tenant_select" on public.reservation for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "reservation_tenant_insert" on public.reservation for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "reservation_tenant_update" on public.reservation for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "reservation_tenant_delete" on public.reservation for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "reservation_status_event_tenant_select" on public.reservation_status_event
  for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));

-- ==== 0007_folio.sql ====
-- H1 · folio/charge/payment minimos (ADR-005). Dinero siempre numeric(12,2) (REQ-GOB-011).
-- El reverso de un cargo se modela con `charge.reversed_by` (REQ-REC-004), nunca borrado
-- fisico. RLS restringe folio/charge/payment a roles con función administrativa/de
-- dinero (owner, gm, frontdesk, reservations, fnb, accountant) -- housekeeping y
-- maintenance quedan excluidos explicitamente de leer o escribir aqui.

create type public.folio_status as enum ('abierto', 'cerrado');

create table public.folio (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete restrict,
  status public.folio_status not null default 'abierto',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index folio_reservation_idx on public.folio (reservation_id);
create index folio_tenant_hotel_idx on public.folio (tenant_id, hotel_id);

create table public.charge (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  folio_id uuid not null references public.folio(id) on delete cascade,
  description text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  tax_amount numeric(12, 2) not null default 0 check (tax_amount >= 0),
  reversed_by uuid references public.charge(id) on delete set null,
  created_at timestamptz not null default now()
);
create index charge_folio_idx on public.charge (folio_id);
create index charge_tenant_hotel_idx on public.charge (tenant_id, hotel_id);

create table public.payment (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  folio_id uuid not null references public.folio(id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  method text not null,
  external_ref text,
  created_at timestamptz not null default now()
);
create index payment_folio_idx on public.payment (folio_id);
create index payment_tenant_hotel_idx on public.payment (tenant_id, hotel_id);

alter table public.folio enable row level security;
alter table public.charge enable row level security;
alter table public.payment enable row level security;

-- Roles con acceso a dinero/folio, explicitamente SIN housekeeping ni maintenance
-- (verificado por tests/unit: rol housekeeping no puede leer folio/charge/payment).
-- Definido como funcion para no repetir el arreglo literal en cada politica.
create or replace function public.can_access_money(_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_hotel_role(
    _hotel_id,
    array['owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant']::public.hotel_role[]
  )
$$;

revoke all on function public.can_access_money(uuid) from public;
grant execute on function public.can_access_money(uuid) to atiende_app, authenticated;

create policy "folio_money_role_select" on public.folio for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
create policy "folio_money_role_insert" on public.folio for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
create policy "folio_money_role_update" on public.folio for update to authenticated
  using (can_access_money(hotel_id))
  with check (can_access_money(hotel_id));

create policy "charge_money_role_select" on public.charge for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
create policy "charge_money_role_insert" on public.charge for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
-- Sin policy de UPDATE/DELETE para charge: un cargo no se edita ni se borra, solo se
-- reversa insertando un nuevo charge que apunta a el via `reversed_by` (REQ-REC-004).

create policy "payment_money_role_select" on public.payment for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
create policy "payment_money_role_insert" on public.payment for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
-- Sin policy de UPDATE/DELETE para payment: un pago no se edita ni se borra.

-- ==== 0008_audit_log.sql ====
-- H1 · audit_log (ADR-005/GOB-026): append-only, hash encadenado al registro anterior
-- DEL MISMO TENANT (cadena por tenant, no global, para no acoplar el historial de un
-- hotel al de otro). Ni UPDATE ni DELETE estan permitidos, ni siquiera para el dueño de
-- la fila: se bloquean con un trigger ademas de no otorgar esos privilegios via GRANT
-- (0010), como defensa en profundidad.

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid references public.hotel(id) on delete set null,
  actor_user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_created_idx on public.audit_log (tenant_id, created_at);

create or replace function public.audit_log_set_hash()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
  v_created_at timestamptz;
  v_canonical text;
begin
  v_created_at := coalesce(new.created_at, now());

  select hash into v_prev_hash
  from public.audit_log
  where tenant_id = new.tenant_id
  order by created_at desc, id desc
  limit 1;

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.tenant_id::text
    || '|' || coalesce(new.hotel_id::text, '')
    || '|' || coalesce(new.actor_user_id::text, '')
    || '|' || new.action
    || '|' || new.entity_type
    || '|' || coalesce(new.entity_id::text, '')
    || '|' || new.payload::text
    || '|' || v_created_at::text;

  new.prev_hash := v_prev_hash;
  new.created_at := v_created_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  return new;
end;
$$;

create trigger audit_log_set_hash_trg
  before insert on public.audit_log
  for each row execute function public.audit_log_set_hash();

create or replace function public.audit_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log_append_only: % no esta permitido sobre audit_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger audit_log_block_update_trg
  before update on public.audit_log
  for each row execute function public.audit_log_block_mutation();

create trigger audit_log_block_delete_trg
  before delete on public.audit_log
  for each row execute function public.audit_log_block_mutation();

-- record_audit_log(): unica via recomendada para insertar (SECURITY DEFINER) para que
-- ningun rol de aplicacion necesite INSERT directo sobre la tabla (ver grants en 0010).
create or replace function public.record_audit_log(
  _tenant_id uuid,
  _hotel_id uuid,
  _action text,
  _entity_type text,
  _entity_id uuid,
  _payload jsonb default '{}'::jsonb
)
returns public.audit_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.audit_log;
begin
  insert into public.audit_log (tenant_id, hotel_id, actor_user_id, action, entity_type, entity_id, payload)
  values (_tenant_id, _hotel_id, auth.uid(), _action, _entity_type, _entity_id, _payload)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_audit_log(uuid, uuid, text, text, uuid, jsonb) from public;
grant execute on function public.record_audit_log(uuid, uuid, text, text, uuid, jsonb) to atiende_app, authenticated;

alter table public.audit_log enable row level security;
create policy "audit_log_tenant_select" on public.audit_log for select to authenticated
  using (tenant_id = any (current_tenant_ids()));
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- record_audit_log() (SECURITY DEFINER) o por el rol propietario de las migraciones.

-- ==== 0009_outbox_idempotency.sql ====
-- H1 · outbox (ADR-004: toda escritura hacia un conector externo pasa por aqui, drenada
-- por un worker con backoff) e idempotency_key (ADR-004: UNIQUE (tenant_id, scope, key) +
-- INSERT ... ON CONFLICT). Ambas son tablas operativas del backend; RLS las acota por
-- tenant y las restringe a roles de gestion (owner/gm) para lectura/escritura directa vía
-- el rol `authenticated` (el flujo normal de outbox/idempotencia lo maneja el propio
-- backend con sus propias funciones de aplicacion, no un usuario final).

create type public.outbox_status as enum ('pendiente', 'enviado', 'fallido');

create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid references public.hotel(id) on delete set null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.outbox_status not null default 'pendiente',
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbox_tenant_status_available_idx on public.outbox (tenant_id, status, available_at);
create index outbox_aggregate_idx on public.outbox (aggregate_type, aggregate_id);

create table public.idempotency_key (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  scope text not null,
  key text not null,
  resource_id uuid,
  response jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, scope, key)
);
create index idempotency_key_tenant_scope_idx on public.idempotency_key (tenant_id, scope);

alter table public.outbox enable row level security;
alter table public.idempotency_key enable row level security;

create policy "outbox_tenant_manager_select" on public.outbox for select to authenticated
  using (tenant_id = any (current_tenant_ids()));
create policy "outbox_tenant_manager_insert" on public.outbox for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()));
create policy "outbox_tenant_manager_update" on public.outbox for update to authenticated
  using (tenant_id = any (current_tenant_ids()))
  with check (tenant_id = any (current_tenant_ids()));

create policy "idempotency_key_tenant_select" on public.idempotency_key for select to authenticated
  using (tenant_id = any (current_tenant_ids()));
create policy "idempotency_key_tenant_insert" on public.idempotency_key for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()));

-- ==== 0010_grants_and_lockdown.sql ====
-- H1 · Cierre de permisos (ADR-004): rol de aplicacion sin BYPASSRLS, REVOKE ALL FROM
-- PUBLIC ya aplicado a nivel de esquema (0001); aqui se hace explicito tabla por tabla
-- (defensa en profundidad, no depende solo del default de Postgres 15+) y se otorgan los
-- privilegios minimos que cada politica RLS ya definida necesita para poder aplicarse
-- (GRANT + RLS son independientes: sin el GRANT, la politica nunca llega a evaluarse).

revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;
revoke all on all functions in schema public from public;
revoke all on all functions in schema auth from public;

-- Confirma que `atiende_app` (rol de LOGIN del pool del backend) nunca tiene BYPASSRLS ni
-- superusuario, incluso si alguna migracion futura lo intentara: no es reversible por una
-- migracion posterior (ver README de packages/db).
alter role atiende_app nosuperuser nobypassrls;

-- Catalogo de tenant/org (solo lectura para `authenticated`; alta de org/hotel es
-- operacion de plataforma fuera de alcance de H1, se hace con el rol propietario).
grant select on public.org to authenticated;
grant select on public.location to authenticated;
grant select on public.hotel to authenticated;
grant select on public.staff_user to authenticated;
grant select, insert, update, delete on public.hotel_staff to authenticated;

-- Inventario y tarifas.
grant select, insert, update, delete on public.room_type to authenticated;
grant select, insert, update, delete on public.room to authenticated;
grant select, insert, update, delete on public.rate_plan to authenticated;
grant select, insert, update, delete on public.availability to authenticated;

-- El `revoke all on all functions in schema public from public` de arriba tambien quita
-- el EXECUTE (concedido por defecto a PUBLIC en Postgres) de las funciones creadas en
-- 0004 que no re-otorgaron su propio grant explicito; se restituye aqui.
grant execute on function public.lock_availability(uuid, uuid, date) to atiende_app, authenticated;
grant execute on function public.book_availability(uuid, uuid, date, integer) to atiende_app, authenticated;

-- Huespedes y reservas.
grant select, insert, update, delete on public.guest to authenticated;
grant select, insert, update, delete on public.reservation to authenticated;
grant select on public.reservation_status_event to authenticated;
grant select on public.reservation_status_transition to authenticated;

-- Dinero: folio/charge/payment nunca se editan/borran salvo folio (abrir/cerrar); charge
-- y payment son append-only (reverso via `charge.reversed_by`, REQ-REC-004).
grant select, insert, update on public.folio to authenticated;
grant select, insert on public.charge to authenticated;
grant select, insert on public.payment to authenticated;

-- audit_log: append-only, solo lectura directa; toda escritura pasa por
-- record_audit_log() (SECURITY DEFINER, ver 0008).
grant select on public.audit_log to authenticated;

-- Outbox / idempotencia (operativas del backend).
grant select, insert, update on public.outbox to authenticated;
grant select, insert on public.idempotency_key to authenticated;

-- `atiende_app` en si (antes de `set local role authenticated`) solo necesita poder
-- conmutar de rol; no recibe privilegios de tabla propios.

-- ==== 0011_staff_auth_and_idempotency_hash.sql ====
-- H2 · ADR-004: login por email/contraseña contra `staff_user` necesita un hash de
-- contraseña que H1 no incluyó (expand-only: se agrega aquí, nunca se edita 0003).
-- `password_hash` es NULLABLE a propósito: un `staff_user` sin contraseña todavía
-- (alta pendiente) simplemente no puede iniciar sesión, no rompe el esquema.
--
-- Se revoca el SELECT de fila completa que 0010 otorgó sobre `staff_user` y se
-- vuelve a otorgar por columnas explícitas SIN `password_hash`: ningún compañero de
-- hotel (ni siquiera vía la política "self_or_colleague" de 0003) debe poder leer el
-- hash de otro usuario a través de la API con el rol `authenticated`. El login en sí
-- lee `password_hash` con el cliente admin (superusuario, bypassa RLS y grants de
-- columna) antes de que exista una sesión autenticada -- mismo patrón que el rol de
-- servicio de GoTrue en Supabase real.
alter table public.staff_user add column password_hash text;

revoke select on public.staff_user from authenticated;
grant select (id, email, full_name, created_at, updated_at) on public.staff_user to authenticated;

-- H2 · ADR-004: idempotencia por `(tenant_id, scope, key)` ya existía (0009); falta
-- guardar el hash del cuerpo de la solicitud para poder distinguir "misma clave,
-- mismo cuerpo" (devolver la respuesta cacheada) de "misma clave, cuerpo distinto"
-- (422, ver apps/api). `request_hash` es NULLABLE porque las filas insertadas por
-- H1 antes de esta migración (si las hubiera) no tienen ese dato -- no se puede
-- rellenar retroactivamente sin inventar un hash falso.
alter table public.idempotency_key add column request_hash text;

-- 0009 solo otorgó SELECT/INSERT sobre idempotency_key: el patrón real de apps/api
-- (INSERT de reclamo ANTES de correr la mutación, luego UPDATE con la respuesta ya
-- resuelta DENTRO de la misma transacción, ver apps/api/src/lib/idempotency.ts) también
-- necesita UPDATE. No hay policy de UPDATE que lo permita todavía: se agrega aquí, con el
-- mismo alcance por tenant que ya usan sus policies de SELECT/INSERT.
grant update on public.idempotency_key to authenticated;
create policy "idempotency_key_tenant_update" on public.idempotency_key for update to authenticated
  using (tenant_id = any (current_tenant_ids()))
  with check (tenant_id = any (current_tenant_ids()));

-- ==== 0012_audit_log_sequence.sql ====
-- H2 · Corrige un desempate no determinista en `audit_log_set_hash()` (0008): el
-- trigger elegia la fila "anterior" con `order by created_at desc, id desc limit 1`,
-- pero `id` es un UUID aleatorio (gen_random_uuid()) sin relacion con el orden real de
-- insercion. Cuando dos inserciones del MISMO tenant caen en el mismo `created_at`
-- (resolucion de reloj, perfectamente posible bajo carga real de la API o en pruebas
-- rapidas en PGlite/embedded-postgres), el desempate por `id` podia romper la cadena de
-- hash (prev_hash apuntando a la fila "equivocada"), detectado por
-- tests/unit/audit-log.spec.ts de forma intermitente.
--
-- Se agrega una columna `seq` estrictamente monotona (identity, asignada por Postgres
-- de forma atomica en cada INSERT, ANTES de que corra el trigger BEFORE INSERT) para
-- desempatar por orden real de insercion en vez de por UUID. No cambia la formula del
-- hash en si (mismas columnas que 0008: prev_hash|tenant|hotel|actor|action|entity_type|
-- entity_id|payload|created_at) -- solo corrige COMO se localiza la fila anterior, por lo
-- que las cadenas de hash ya generadas siguen siendo verificables con la misma formula.
alter table public.audit_log add column seq bigint generated always as identity;
create unique index audit_log_seq_idx on public.audit_log (seq);
create index audit_log_tenant_seq_idx on public.audit_log (tenant_id, seq);

create or replace function public.audit_log_set_hash()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
  v_created_at timestamptz;
  v_canonical text;
begin
  v_created_at := coalesce(new.created_at, now());

  select hash into v_prev_hash
  from public.audit_log
  where tenant_id = new.tenant_id
  order by seq desc
  limit 1;

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.tenant_id::text
    || '|' || coalesce(new.hotel_id::text, '')
    || '|' || coalesce(new.actor_user_id::text, '')
    || '|' || new.action
    || '|' || new.entity_type
    || '|' || coalesce(new.entity_id::text, '')
    || '|' || new.payload::text
    || '|' || v_created_at::text;

  new.prev_hash := v_prev_hash;
  new.created_at := v_created_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  return new;
end;
$$;

-- ==== 0013_tarifas_avanzadas_y_politicas.sql ====
-- H4 · Extensiones de tarifas/restricciones/políticas para el motor de cotización
-- determinista (`@atiende-hoteles/domain-hotel`) y el ciclo de vida completo de la
-- reserva (modificación bajo lock, cancelación con política, no-show, sobreventa
-- controlada). Expand-only sobre 0004/0006/0008/0009 (REQ-GOB-010): ninguna migración
-- ya aplicada se edita.

-- Restricciones de estadía por noche (MinLOS/CTA/CTD, citadas en H07-005): viven en
-- `rate_plan` porque varían por temporada igual que el precio, no son un valor fijo del
-- room_type. Los defaults reproducen "sin restricción" para todo lo ya sembrado.
alter table public.rate_plan add column min_stay integer not null default 1 check (min_stay >= 1);
alter table public.rate_plan add column closed_to_arrival boolean not null default false;
alter table public.rate_plan add column closed_to_departure boolean not null default false;

-- Sobreventa controlada (REQ-RES-007/H02-010, "1-2 habitaciones solo en fechas de alta
-- ocupación"): configurable por tipo de habitación, nunca un límite global fijo.
-- `max_overbook_rooms = 0` (default) reproduce EXACTAMENTE el comportamiento anterior
-- de `book_availability` — ninguna sobreventa salvo que un rol autorizado la configure.
alter table public.room_type add column max_overbook_rooms integer not null default 0 check (max_overbook_rooms >= 0);
alter table public.room_type add column overbooking_occupancy_threshold_pct numeric(5, 2) not null default 95
  check (overbooking_occupancy_threshold_pct between 0 and 100);

-- El CHECK original de 0004 (`booked_rooms <= total_rooms`, sin nombre explícito,
-- Postgres lo bautizó "availability_check") bloquearía CUALQUIER sobreventa sin
-- importar lo que `book_availability()` decida más abajo -- un CHECK de tabla no puede
-- referenciar `room_type.max_overbook_rooms` (otra tabla), así que no se puede
-- "arreglar" con otro CHECK: se elimina y la invariante ("nunca vender más que
-- total_rooms + sobreventa vigente") queda exclusivamente a cargo de
-- `book_availability()`/`release_availability()` como ÚNICA vía de escritura
-- sancionada (ya documentado así desde 0004). Localizado dinámicamente por su
-- definición (no por nombre) para no depender de que Postgres siga generando el mismo
-- nombre automático en otra versión/motor.
do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.availability'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) = 'CHECK ((booked_rooms <= total_rooms))'
  loop
    execute format('alter table public.availability drop constraint %I', con.conname);
  end loop;
end $$;

-- Impuestos por hotel (REQ-REV-001): IVA/ISH son PARÁMETROS configurables por hotel,
-- nunca una verdad fiscal fija en código. El motor de cotización los lee de aquí; el
-- LLM jamás calcula ni fija esta cifra por ninguna ruta de código.
create table public.hotel_tax_config (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  iva_rate numeric(6, 4) not null default 0.16 check (iva_rate >= 0 and iva_rate <= 1),
  ish_rate numeric(6, 4) not null default 0.03 check (ish_rate >= 0 and ish_rate <= 1),
  updated_at timestamptz not null default now()
);

-- Política de cancelación/depósito (REQ-RES-004), estructurada en los 4 puntos citados
-- por el encargo (`free_until`, `penalty`, `no_show`, `deposit`), configurable por
-- hotel. La reserva guarda una COPIA (`cancellation_policy_snapshot`) al crearse para
-- que un cambio posterior de política no altere retroactivamente reservas ya hechas.
create table public.hotel_cancellation_policy (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  free_until_hours integer not null default 24 check (free_until_hours >= 0),
  penalty_pct numeric(5, 2) not null default 50 check (penalty_pct between 0 and 100),
  no_show_pct numeric(5, 2) not null default 100 check (no_show_pct between 0 and 100),
  deposit_pct numeric(5, 2) not null default 20 check (deposit_pct between 0 and 100),
  updated_at timestamptz not null default now()
);

-- REQ-RES-004: "siempre debe entregar un número de cancelación al confirmar" — el mismo
-- código sirve también como código de reserva para el huésped (REQ-RES-005: código +
-- apellido). Es GLOBAL (no indexado por tenant): un huésped que llama solo conoce su
-- código, no de qué tenant es — debe ser localizable sin conocer el hotel de antemano.
alter table public.reservation
  add column confirmation_code text default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
alter table public.reservation add column cancellation_policy_snapshot jsonb;
alter table public.reservation add column canceled_at timestamptz;
alter table public.reservation add column cancellation_penalty_amount numeric(12, 2);

-- El DEFAULT de arriba solo aplica a INSERTs futuros; esta actualización cubre
-- filas insertadas por una versión previa de esta migración o por un dump restaurado
-- antes de que existiera la columna (nunca dependemos de que "ya nadie tiene datos").
update public.reservation
set confirmation_code = upper(substr(encode(sha256(id::text::bytea), 'hex'), 1, 8))
where confirmation_code is null;

alter table public.reservation alter column confirmation_code set not null;
create unique index reservation_confirmation_code_idx on public.reservation (confirmation_code);

-- Sobreventa controlada dentro del MISMO advisory lock (ADR-004): reemplaza el cuerpo
-- de `book_availability` (0004) sin cambiar su firma — toda ruta que ya lo invoca (H2)
-- sigue funcionando idéntico mientras `max_overbook_rooms = 0` (default de 0004/aquí).
create or replace function public.book_availability(
  _hotel_id uuid,
  _room_type_id uuid,
  _date date,
  _qty integer default 1
)
returns public.availability
language plpgsql
as $$
declare
  v_row public.availability;
  v_max_overbook integer;
  v_threshold numeric;
  v_effective_capacity integer;
  v_occupancy_pct numeric;
begin
  if _qty <= 0 then
    raise exception 'cantidad_invalida: _qty debe ser mayor a 0';
  end if;

  perform public.lock_availability(_hotel_id, _room_type_id, _date);

  select * into v_row
  from public.availability
  where hotel_id = _hotel_id and room_type_id = _room_type_id and date = _date
  for update;

  if not found then
    raise exception 'sin_disponibilidad: no existe inventario para hotel=%, room_type=%, fecha=%',
      _hotel_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  select max_overbook_rooms, overbooking_occupancy_threshold_pct
    into v_max_overbook, v_threshold
    from public.room_type
    where id = _room_type_id;

  v_occupancy_pct := case
    when v_row.total_rooms > 0 then (v_row.booked_rooms::numeric / v_row.total_rooms::numeric) * 100
    else 100
  end;

  -- La sobreventa solo se habilita al alcanzar el umbral de ocupación configurado
  -- (H02-010/H02 p.16): por debajo del umbral, `max_overbook_rooms` no aplica.
  v_effective_capacity := v_row.total_rooms
    + case when v_occupancy_pct >= coalesce(v_threshold, 95) then coalesce(v_max_overbook, 0) else 0 end;

  if v_row.booked_rooms + _qty > v_effective_capacity then
    raise exception 'sin_disponibilidad: no hay habitaciones libres para hotel=%, room_type=%, fecha=%',
      _hotel_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  update public.availability
  set booked_rooms = booked_rooms + _qty, updated_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- release_availability(): contraparte simétrica de book_availability para
-- cancelación/modificación — mismo advisory lock, nunca deja `booked_rooms` negativo.
create or replace function public.release_availability(
  _hotel_id uuid,
  _room_type_id uuid,
  _date date,
  _qty integer default 1
)
returns public.availability
language plpgsql
as $$
declare
  v_row public.availability;
begin
  if _qty <= 0 then
    raise exception 'cantidad_invalida: _qty debe ser mayor a 0';
  end if;

  perform public.lock_availability(_hotel_id, _room_type_id, _date);

  update public.availability
  set booked_rooms = greatest(booked_rooms - _qty, 0), updated_at = now()
  where hotel_id = _hotel_id and room_type_id = _room_type_id and date = _date
  returning * into v_row;

  if not found then
    raise exception 'sin_disponibilidad: no existe inventario para hotel=%, room_type=%, fecha=%',
      _hotel_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

grant execute on function public.release_availability(uuid, uuid, date, integer) to atiende_app, authenticated;

-- Cancelación verificada por identidad (REQ-RES-005/H03-025): código de reserva +
-- apellido, SIN sesión de staff — por eso corre SECURITY DEFINER (mismo patrón que
-- `record_audit_log` en 0008): es la única vía que puede tocar una `reservation` sin
-- que quien llama pertenezca al `hotel_staff` de ese hotel. El apellido se compara
-- como subcadena case-insensitive de `guest.full_name` porque el esquema (0005) no
-- separa nombre/apellido; se documenta como simplificación deliberada, no un error.
create or replace function public.cancel_reservation_public(
  _confirmation_code text,
  _apellido text
)
returns public.reservation
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res public.reservation;
  v_res_found boolean;
  v_guest_name text;
  v_policy record;
  v_hours_until_checkin numeric;
  v_penalty numeric(12, 2);
  v_night date;
begin
  -- No se puede mezclar una variable %ROWTYPE (v_res) con una escalar (v_guest_name) en
  -- el mismo INTO de plpgsql ("record variable cannot be part of multiple-item INTO
  -- list") -- se resuelve en dos pasos: la fila completa primero, el nombre del huésped
  -- después a partir de `v_res.guest_id` ya resuelto. `FOUND` se guarda en
  -- `v_res_found` de inmediato porque el segundo SELECT lo sobrescribe.
  select r.* into v_res
  from public.reservation r
  where r.confirmation_code = upper(trim(_confirmation_code))
  for update of r;
  v_res_found := found;

  if v_res_found then
    select g.full_name into v_guest_name from public.guest g where g.id = v_res.guest_id;
  end if;

  if not v_res_found
     or v_guest_name is null
     or length(trim(coalesce(_apellido, ''))) = 0
     or position(lower(trim(_apellido)) in lower(v_guest_name)) = 0 then
    raise exception 'cancelacion_no_verificada: código de reserva o apellido no coinciden'
      using errcode = 'P0001';
  end if;

  if v_res.status not in ('cotizada', 'confirmada') then
    raise exception 'transicion_invalida: la reserva % no admite cancelación en estado %',
      v_res.id, v_res.status
      using errcode = 'P0001';
  end if;

  select * into v_policy from public.hotel_cancellation_policy where hotel_id = v_res.hotel_id;
  v_hours_until_checkin := extract(epoch from (v_res.check_in_date::timestamptz - now())) / 3600;

  if v_policy.hotel_id is null or v_hours_until_checkin >= v_policy.free_until_hours then
    v_penalty := 0;
  else
    v_penalty := round(v_res.total_amount * coalesce(v_policy.penalty_pct, 50) / 100, 2);
  end if;

  v_night := v_res.check_in_date;
  while v_night < v_res.check_out_date loop
    perform public.release_availability(v_res.hotel_id, v_res.room_type_id, v_night, 1);
    v_night := v_night + 1;
  end loop;

  update public.reservation
  set status = 'cancelada', canceled_at = now(), cancellation_penalty_amount = v_penalty, updated_at = now()
  where id = v_res.id
  returning * into v_res;

  perform public.record_audit_log(
    v_res.tenant_id, v_res.hotel_id, 'reservation.canceled_by_guest', 'reservation', v_res.id,
    jsonb_build_object('penaltyAmount', v_penalty, 'verifiedBy', 'confirmation_code+apellido')
  );

  insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
  values (
    v_res.tenant_id, v_res.hotel_id, 'reservation', v_res.id, 'reservation.canceled',
    jsonb_build_object('penaltyAmount', v_penalty, 'canceledBy', 'guest')
  );

  return v_res;
end;
$$;

revoke all on function public.cancel_reservation_public(text, text) from public;
grant execute on function public.cancel_reservation_public(text, text) to atiende_app, authenticated;

alter table public.hotel_tax_config enable row level security;
alter table public.hotel_cancellation_policy enable row level security;

-- Solo owner/gm configuran impuestos y política de cancelación (más cercano a
-- "gerente"; el catálogo de 8 roles de REQ-TEN-003 no incluye un rol "revenue"
-- dedicado — ver docs/PROGRESO.md H4 para la nota de esta correspondencia).
create policy "hotel_tax_config_tenant_select" on public.hotel_tax_config for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "hotel_tax_config_tenant_insert" on public.hotel_tax_config for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "hotel_tax_config_tenant_update" on public.hotel_tax_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "hotel_cancellation_policy_tenant_select" on public.hotel_cancellation_policy for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "hotel_cancellation_policy_tenant_insert" on public.hotel_cancellation_policy for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "hotel_cancellation_policy_tenant_update" on public.hotel_cancellation_policy for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.hotel_tax_config to authenticated;
grant select, insert, update on public.hotel_cancellation_policy to authenticated;

-- ==== 0014_reservation_channel.sql ====
-- H4 · REQ-RES-020: registrar por reserva el canal/agente de origen para atribución de
-- comisión y reporting de room-nights directas. REQ-RES-022/REQ-REV-008 prohíben
-- construir conectividad OTA propia en esta fase, así que ningún escritor de este
-- repositorio produce hoy un valor distinto de 'directo' -- la columna deja el esquema
-- listo para cuando exista un channel manager/PMS certificado, sin otra migración.
alter table public.reservation add column channel text not null default 'directo';

-- ==== 0015_audit_log_advisory_lock.sql ====
-- H4 · auditoría-1/backend [ALTO]: la cadena de hash de `audit_log` (0008/0012) se
-- puede bifurcar bajo escritura concurrente del MISMO tenant. `audit_log_set_hash()`
-- hacía `select hash ... order by seq desc limit 1` para calcular `prev_hash` y luego
-- insertaba, sin ningún mecanismo que serializara esa lectura-escritura por tenant --
-- dos transacciones concurrentes del mismo tenant (ej. un `reservation.created` y un
-- `payment.recorded` casi simultáneos, el caso real de dos requests de API en paralelo)
-- podían leer el mismo "último hash" antes de que cualquiera insertara, produciendo dos
-- filas con `prev_hash = null` en vez de una cadena, verificado empíricamente en
-- tests/integration/audit-log-concurrencia.spec.ts.
--
-- Primer intento descartado (documentado aquí porque casi se queda sin probar a fondo):
-- `pg_advisory_xact_lock` por tenant ANTES del SELECT. Se probó empíricamente contra
-- `embedded-postgres` real con 20 escrituras concurrentes y SÍ sigue bifurcando la
-- cadena intermitentemente (~1 de cada 3-5 corridas): el advisory lock serializa
-- correctamente el ORDEN de ejecución (verificado con `raise notice`+timestamps -- cada
-- sesión adquiere el lock estrictamente después de que la anterior lo liberó), pero la
-- sentencia `select ... into` que sigue puede seguir viendo una versión no actualizada
-- de "la última fila" en la ventana exacta de la liberación del lock -- un advisory lock
-- por sí solo NO reejecuta ni refresca el plan de la sentencia que sigue.
--
-- Arreglo real: una fila "cabeza de cadena" por tenant (`audit_log_chain_head`),
-- bloqueada con `SELECT ... FOR UPDATE`. A diferencia del advisory lock, `FOR UPDATE` es
-- el mecanismo de Postgres diseñado exactamente para este patrón: si la fila fue
-- modificada por otra transacción entre que la sentencia empezó y logró el lock,
-- Postgres vuelve a evaluarla (EvalPlanQual) y entrega la versión ya comprometida más
-- reciente -- nunca una copia obsoleta. Verificado con la misma prueba de 20 escrituras
-- concurrentes repetida 15+ veces sin ninguna bifurcación.
create table public.audit_log_chain_head (
  tenant_id uuid primary key references public.org(id) on delete cascade,
  hash text
);

-- Siembra la cabeza de cada tenant que ya tenga historial (`audit_log` no está vacía en
-- un entorno de desarrollo/producción que ya haya corrido antes de este arreglo) con su
-- hash más reciente por `seq` -- nunca arranca la cadena desde cero perdiendo el enlace
-- con lo ya escrito.
insert into public.audit_log_chain_head (tenant_id, hash)
select distinct on (tenant_id) tenant_id, hash
from public.audit_log
order by tenant_id, seq desc
on conflict (tenant_id) do nothing;

-- Tabla puramente interna de contabilidad de la cadena: ninguna ruta de aplicación la
-- lee ni la escribe directamente (mismo criterio que `audit_log` con
-- `record_audit_log()`) -- solo el trigger `audit_log_set_hash()`, que corre con el
-- privilegio del propietario de `record_audit_log()` (SECURITY DEFINER, 0008) porque el
-- INSERT que lo dispara ocurre dentro de esa función.
revoke all on public.audit_log_chain_head from public;
alter table public.audit_log_chain_head enable row level security;
-- Sin ninguna policy: `authenticated` queda sin SELECT/INSERT/UPDATE/DELETE directo.

create or replace function public.audit_log_set_hash()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
  v_created_at timestamptz;
  v_canonical text;
begin
  -- Garantiza que exista la fila-cabeza de este tenant (primera escritura de su
  -- historia) antes de intentar bloquearla -- `on conflict do nothing` la vuelve segura
  -- ante dos primeras escrituras concurrentes del mismo tenant nuevo.
  insert into public.audit_log_chain_head (tenant_id, hash)
  values (new.tenant_id, null)
  on conflict (tenant_id) do nothing;

  -- FOR UPDATE: bloquea la fila-cabeza de ESTE tenant (nunca la de otros) hasta el
  -- commit/rollback de esta transacción, y entrega SIEMPRE el valor comprometido más
  -- reciente (EvalPlanQual), no una copia tomada antes de esperar el lock.
  select hash into v_prev_hash
  from public.audit_log_chain_head
  where tenant_id = new.tenant_id
  for update;

  v_created_at := coalesce(new.created_at, now());

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.tenant_id::text
    || '|' || coalesce(new.hotel_id::text, '')
    || '|' || coalesce(new.actor_user_id::text, '')
    || '|' || new.action
    || '|' || new.entity_type
    || '|' || coalesce(new.entity_id::text, '')
    || '|' || new.payload::text
    || '|' || v_created_at::text;

  new.prev_hash := v_prev_hash;
  new.created_at := v_created_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  update public.audit_log_chain_head set hash = new.hash where tenant_id = new.tenant_id;

  return new;
end;
$$;

-- ==== 0016_record_audit_log_valida_actor.sql ====
-- auditoria-1/seguridad [CRITICO] "record_audit_log() permite falsificar el audit_log
-- de cualquier organizacion, no solo de otro hotel" (docs/auditoria-1/seguridad.md).
--
-- `record_audit_log()` (0008) es SECURITY DEFINER y hasta ahora insertaba directo con
-- los parametros `_tenant_id`/`_hotel_id` que recibia, sin comparar contra la membresia
-- real (`current_tenant_ids()`/`current_hotel_ids()`) del `auth.uid()` de la sesion que
-- la invoca. Verificado: una sesion real `authenticated` como `housekeeping` de un
-- hotel podia llamar `record_audit_log('<org-ajena>', '<hotel-ajeno>', ...)` y la fila
-- quedaba insertada, correctamente encadenada por hash, en la cadena de auditoria de
-- una organizacion completamente ajena.
--
-- Arreglo: valida `_tenant_id`/`_hotel_id` contra la membresia real del actor SOLO
-- cuando existe un actor de sesion real (`auth.uid()` no nulo, ver 0001) -- una llamada
-- sin sesion (conexion admin/superusuario del runner/seed/tests, o un SECURITY DEFINER
-- de nivel superior como `cancel_reservation_public`, 0013, que ya verifico codigo de
-- reserva + apellido antes de llegar aqui) sigue funcionando exactamente igual: ya paso
-- por su propia autorizacion o es codigo de plataforma de confianza, nunca alcanzable
-- por un request HTTP externo con `authenticated` (toda ruta real de apps/api que
-- escribe audit_log corre dentro de `dbSession`, que SIEMPRE fija
-- `request.jwt.claim.sub` al usuario ya autenticado -- ver apps/api/src/middleware.ts).
--
-- Esto cierra exactamente el vector reportado sin tocar ningun caller legitimo: todo
-- llamador real de apps/api pasa `orgId`/`hotelId` ya verificados en vivo por
-- `requireHotelMembership` contra `hotel_staff`, asi que `_tenant_id`/`_hotel_id`
-- siempre coinciden con `current_tenant_ids()`/`current_hotel_ids()` del mismo actor.
create or replace function public.record_audit_log(
  _tenant_id uuid,
  _hotel_id uuid,
  _action text,
  _entity_type text,
  _entity_id uuid,
  _payload jsonb default '{}'::jsonb
)
returns public.audit_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.audit_log;
  v_actor uuid;
begin
  v_actor := auth.uid();

  if v_actor is not null then
    if _tenant_id is null or not (_tenant_id = any (current_tenant_ids())) then
      raise exception
        'tenant_no_autorizado: el actor % no pertenece a la organizacion % (record_audit_log)',
        v_actor, _tenant_id
        using errcode = '42501';
    end if;

    if _hotel_id is not null and not (_hotel_id = any (current_hotel_ids())) then
      raise exception
        'hotel_no_autorizado: el actor % no pertenece al hotel % (record_audit_log)',
        v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  insert into public.audit_log (tenant_id, hotel_id, actor_user_id, action, entity_type, entity_id, payload)
  values (_tenant_id, _hotel_id, v_actor, _action, _entity_type, _entity_id, _payload)
  returning * into v_row;

  return v_row;
end;
$$;

-- ==== 0017_outbox_idempotency_scope_hotel_y_rol.sql ====
-- auditoria-1/seguridad [CRITICO] "outbox e idempotency_key solo aislan por
-- organizacion, no por hotel: cualquier staff de un hotel lee y falsifica eventos de
-- otro hotel de la misma org" (docs/auditoria-1/seguridad.md).
--
-- Ambas tablas (0009) tienen columna `hotel_id` pero sus policies solo comparaban
-- `tenant_id = any(current_tenant_ids())` -- nunca `hotel_id`, y el comentario original
-- de 0009 ("restringidas a roles de gestion owner/gm") nunca se implemento: el GRANT es
-- liso para todo `authenticated`. Verificado: housekeeping de un hotel podia leer
-- (y falsificar via INSERT) el outbox/idempotency_key de OTRO hotel de la misma org,
-- incluyendo montos/metodo de pago en transito.
--
-- Arreglo: se reemplazan las policies para exigir ADEMAS `hotel_id = any
-- (current_hotel_ids())` y `can_access_money(hotel_id)` (0007) -- el mismo criterio de
-- rol que ya protege folio/charge/payment, porque el payload de estos eventos es
-- financiero (montos, metodos de pago, totales de reserva) en la misma medida. Los 4
-- roles reales que hoy escriben aqui (MANAGE_RESERVATIONS_ROLES: owner/gm/frontdesk/
-- reservations, ver apps/api/src/domain/roles.ts) son subconjunto estricto de
-- can_access_money(), asi que ningun flujo de aplicacion existente se rompe.
-- `hotel_id is null` queda sin policy que la alcance (deny-by-default): hoy ningun
-- escritor de apps/api inserta con hotel_id nulo.
drop policy "outbox_tenant_manager_select" on public.outbox;
drop policy "outbox_tenant_manager_insert" on public.outbox;
drop policy "outbox_tenant_manager_update" on public.outbox;

create policy "outbox_hotel_money_role_select" on public.outbox for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id is not null and can_access_money(hotel_id));
create policy "outbox_hotel_money_role_insert" on public.outbox for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and hotel_id is not null and can_access_money(hotel_id));
create policy "outbox_hotel_money_role_update" on public.outbox for update to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id is not null and can_access_money(hotel_id))
  with check (tenant_id = any (current_tenant_ids()) and hotel_id is not null and can_access_money(hotel_id));

drop policy "idempotency_key_tenant_select" on public.idempotency_key;
drop policy "idempotency_key_tenant_insert" on public.idempotency_key;
drop policy "idempotency_key_tenant_update" on public.idempotency_key;

-- `idempotency_key` no tiene columna `hotel_id` (0009): el scope (ADR-004) es por
-- `(tenant_id, scope, key)`, no por hotel -- el resto de la fuga reportada
-- ("housekeeping lee montos de un pago de otro hotel") viene de que CUALQUIER
-- `authenticated` del org podia leer/escribir, sin filtro de rol. Se cierra exigiendo
-- que el actor tenga rol de dinero en AL MENOS un hotel de ese org (equivalente al
-- criterio "gestiona dinero en la organizacion", ya que la tabla no distingue hotel).
create policy "idempotency_key_money_role_select" on public.idempotency_key for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and exists (
      select 1 from public.hotel_staff hs
      where hs.user_id = auth.uid()
        and hs.org_id = idempotency_key.tenant_id
        and hs.role = any (array['owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant']::public.hotel_role[])
    )
  );
create policy "idempotency_key_money_role_insert" on public.idempotency_key for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and exists (
      select 1 from public.hotel_staff hs
      where hs.user_id = auth.uid()
        and hs.org_id = idempotency_key.tenant_id
        and hs.role = any (array['owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant']::public.hotel_role[])
    )
  );
create policy "idempotency_key_money_role_update" on public.idempotency_key for update to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and exists (
      select 1 from public.hotel_staff hs
      where hs.user_id = auth.uid()
        and hs.org_id = idempotency_key.tenant_id
        and hs.role = any (array['owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant']::public.hotel_role[])
    )
  )
  with check (
    tenant_id = any (current_tenant_ids())
    and exists (
      select 1 from public.hotel_staff hs
      where hs.user_id = auth.uid()
        and hs.org_id = idempotency_key.tenant_id
        and hs.role = any (array['owner', 'gm', 'frontdesk', 'reservations', 'fnb', 'accountant']::public.hotel_role[])
    )
  );

-- ==== 0018_room_type_id_fk_compuesta_por_hotel.sql ====
-- auditoria-1/datos [CRITICO] "availability/reservation/room/rate_plan.room_type_id no
-- esta scoped a hotel_id: fuga de tarifa y nombre de habitacion entre tenants distintos"
-- (docs/auditoria-1/datos.md). `room_type_id` en estas cuatro tablas era una FK SIMPLE a
-- `room_type(id)` -- nunca se verificaba que perteneciera al MISMO `hotel_id` de la fila
-- que lo referencia. Verificado con una sesion RLS real (rol `reservations`): la policy
-- de INSERT de `availability` solo exige `tenant_id`/`has_hotel_role(hotel_id, ...)`,
-- nunca que `room_type_id` pertenezca a ese `hotel_id` -- permite insertar una
-- `availability`/`reservation` de Hotel A que en realidad apunta al `room_type` (nombre
-- y tarifa) de un hotel B completamente ajeno, filtrando esa informacion via los JOIN
-- normales de `apps/api/src/routes/reservas.ts`.
--
-- Arreglo: FK COMPUESTA `(hotel_id, room_type_id) references room_type(hotel_id, id)`
-- en las 4 tablas -- Postgres exige un UNIQUE/PK sobre las columnas referenciadas del
-- padre, por eso se agrega primero `room_type(hotel_id, id)` (trivialmente unica: `id`
-- ya es PK). Esto hace que la invariante "room_type_id debe pertenecer al mismo
-- hotel_id de la fila" quede impuesta por el ESQUEMA, no solo por la aplicacion o por
-- RLS -- ninguna sesion (ni siquiera el cliente admin/superusuario) puede insertar una
-- combinacion cruzada, sin importar que rol tenga o si RLS esta activa.
--
-- Se conserva la FK simple original de cada tabla (mismo ON DELETE que ya tenian) y se
-- agrega la compuesta con el MISMO ON DELETE para no introducir un orden de disparo
-- ambiguo entre dos constraints que discreparan en la accion de borrado.
alter table public.room_type
  add constraint room_type_hotel_id_id_key unique (hotel_id, id);

alter table public.room
  add constraint room_room_type_hotel_fk
  foreign key (hotel_id, room_type_id) references public.room_type (hotel_id, id) on delete restrict;

alter table public.rate_plan
  add constraint rate_plan_room_type_hotel_fk
  foreign key (hotel_id, room_type_id) references public.room_type (hotel_id, id) on delete cascade;

alter table public.availability
  add constraint availability_room_type_hotel_fk
  foreign key (hotel_id, room_type_id) references public.room_type (hotel_id, id) on delete cascade;

alter table public.reservation
  add constraint reservation_room_type_hotel_fk
  foreign key (hotel_id, room_type_id) references public.room_type (hotel_id, id) on delete restrict;

-- Indices de apoyo para las nuevas FKs compuestas (Postgres no los crea automaticamente
-- para el lado "hijo" de una FK, solo exige el unique del lado "padre" ya agregado
-- arriba) -- evita un seq scan al validar/cascada sobre estas tablas a escala.
create index room_hotel_room_type_idx on public.room (hotel_id, room_type_id);
create index rate_plan_hotel_room_type_idx on public.rate_plan (hotel_id, room_type_id);
create index availability_hotel_room_type_idx on public.availability (hotel_id, room_type_id);
create index reservation_hotel_room_type_idx on public.reservation (hotel_id, room_type_id);

-- ==== 0019_hotel_staff_org_id_derivado.sql ====
-- auditoria-1/datos [CRITICO] "hotel_staff.org_id no se valida contra hotel.org_id
-- real: un owner/gm de un hotel puede fabricar membresia con org_id de otro tenant y
-- ver su org/location" (docs/auditoria-1/datos.md). La policy `hotel_staff_manage_insert`
-- (0003) solo exige `has_hotel_role(hotel_id, ['owner','gm'])` -- nunca compara
-- `org_id` de la fila contra el `org_id` REAL de `hotel_id`. Verificado: un owner real
-- podia insertar `hotel_staff(org_id=<org ajeno>, hotel_id=<su hotel real>, ...)` y el
-- nuevo usuario quedaba con `current_tenant_ids()` apuntando a un tenant con el que no
-- tiene ninguna relacion legitima, exponiendole el catalogo org/location ajeno via
-- `org_member_select`/`location_member_select` (que solo filtran por org_id).
--
-- Arreglo: `org_id` deja de ser un valor que el cliente controla -- un trigger
-- BEFORE INSERT/UPDATE lo SOBRESCRIBE siempre con el `org_id` real de `hotel_id`
-- (derivado, nunca solo validado): cualquier valor que la sesion intente fijar en
-- `org_id` se descarta. Es la misma tecnica de "columna de scope derivada, no confiada
-- al cliente" que ya usa el propio esquema (auth.uid() para `actor_user_id`).
create or replace function public.hotel_staff_derive_org_id()
returns trigger
language plpgsql
as $$
declare
  v_real_org_id uuid;
begin
  select org_id into v_real_org_id from public.hotel where id = new.hotel_id;

  if v_real_org_id is null then
    raise exception 'hotel_inexistente: no existe hotel % para hotel_staff', new.hotel_id
      using errcode = '23503';
  end if;

  new.org_id := v_real_org_id;
  return new;
end;
$$;

create trigger hotel_staff_derive_org_id_trg
  before insert or update of hotel_id, org_id on public.hotel_staff
  for each row execute function public.hotel_staff_derive_org_id();

-- ==== 0020_outbox_last_error.sql ====
-- auditoria-1/backend [ALTO] "el worker de outbox descarta la causa real del error y no
-- aplica timeout por handler" (docs/auditoria-1/backend.md). El `catch {}` de
-- `drainOutboxOnce()` (apps/api/src/outbox/worker.ts) no nombraba la variable de error
-- ni la persistia en ningun lado -- tras `maxAttempts` fallos, la fila quedaba
-- `status='fallido'` sin ninguna pista de POR QUE. Se agrega una columna para que la
-- causa real (mensaje del error, o "handler_timeout: ..." si el handler se colgo)
-- quede junto al evento, consultable por el equipo de operacion sin depender de logs
-- externos que puedan haber rotado.
alter table public.outbox add column last_error text;

-- ==== 0021_outbox_worker_index.sql ====
-- auditoria-1/datos [MEDIO] "el worker de outbox no tiene un indice que sirva su propia
-- consulta -- full scan garantizado a escala" (docs/auditoria-1/datos.md). El unico
-- indice de `outbox` (0009) es `(tenant_id, status, available_at)`, con `tenant_id`
-- como columna lider -- pero `drainOutboxOnce()` (apps/api/src/outbox/worker.ts) drena
-- TODOS los tenants a la vez y consulta
-- `where status = 'pendiente' and available_at <= now() order by created_at asc`, sin
-- filtrar por `tenant_id`: ese indice es inutil para esa consulta (columna lider no
-- aparece en el WHERE), verificado con EXPLAIN produciendo `Seq Scan on outbox`.
--
-- Arreglo: indice `(status, created_at)` -- `status` es el filtro de igualdad real del
-- worker, y con `status` fijo el indice ya entrega las filas en el orden de
-- `created_at` que pide el `ORDER BY`, evitando ademas un sort explicito. El filtro de
-- `available_at <= now()` se evalua como recheck sobre las filas que el indice ya trajo
-- en orden -- barato porque `available_at` es un timestamptz simple, no un JOIN.
create index outbox_status_created_idx on public.outbox (status, created_at);

-- ==== 0022_idempotency_key_ttl.sql ====
-- auditoria-1/datos [MEDIO] "idempotency_key no tiene TTL ni columna de expiracion"
-- (docs/auditoria-1/datos.md). La tabla (0009) crecia una fila por cada Idempotency-Key
-- recibido, PARA SIEMPRE -- sin `expires_at` ni ventana de proteccion contra reintento
-- documentada: un `Idempotency-Key` reutilizado por error meses despues devolveria
-- indefinidamente la respuesta cacheada de la primera vez.
--
-- Arreglo: columna `expires_at` (7 dias desde la creacion -- ventana generosa para
-- cubrir un reintento manual/de integracion externa real, sin ser "para siempre") mas
-- un indice de apoyo para una futura tarea de purga por lote
-- (`delete from idempotency_key where expires_at < now()`, aun no construida como job
-- programado -- documentado como el siguiente paso, no simulado aqui). El uso real de
-- la ventana (permitir reclamar de nuevo una llave ya expirada) se implementa en
-- `apps/api/src/lib/idempotency.ts` via `ON CONFLICT ... DO UPDATE ... WHERE
-- expires_at < now()`.
alter table public.idempotency_key
  add column expires_at timestamptz not null default (now() + interval '7 days');

create index idempotency_key_expires_at_idx on public.idempotency_key (expires_at);

-- ==== 0023_hotel_timezone.sql ====
-- auditoria-1/datos [MEDIO] "ninguna tabla del dominio hotelero registra la zona
-- horaria del hotel -- ambiguedad entre date (sin huso) y timestamptz (UTC)"
-- (docs/auditoria-1/datos.md). `location`/`hotel` no tenian ninguna columna de zona
-- horaria: no hay donde anclar "que dia es hoy para este hotel" cuando se construya
-- night audit / reportes diarios / corte de disponibilidad (H5/H10). Hoy ningun codigo
-- depende de esto todavia -- se agrega la columna como cimiento correcto para cuando
-- ese codigo se escriba, sin inventar logica que no existe aun.
--
-- Nombre de zona horaria de la base de datos de IANA (tz database, ej.
-- 'America/Mexico_City'), no un offset fijo -- sobrevive cambios de horario de verano
-- si alguna region del despliegue los tuviera. Default al huso mas comun del mercado
-- inicial (documentado, no adivinado) -- una fila real de `hotel` puede sobreescribirlo.
alter table public.hotel add column timezone text not null default 'America/Mexico_City';

-- Validacion basica de forma (no exhaustiva: Postgres no expone una lista de zonas
-- validas como CHECK sin PL/pgSQL) -- exige "Continente/Ciudad" para descartar valores
-- claramente mal formados (ej. un offset num rico o una cadena vacia) sin acoplarse a
-- una lista de zonas que se desactualizaria.
alter table public.hotel
  add constraint hotel_timezone_formato_iana check (timezone ~ '^[A-Za-z_]+/[A-Za-z_/]+$');

-- ==== 0024_agent_run.sql ====
-- H7 · ADR-006/REQ-AGT-020: `agent_run` es UNA fila por corrida completa de
-- `AgentRunner` (agregado -- tokens/costo/steps/duración totales), la fuente real del
-- presupuesto/costo por hotel y por agente (REQ-AGT-020, "techo de costo por
-- agente/unidad de negocio, medido en producción"). El detalle PASO A PASO de cada
-- corrida (llm_call/tool_call/approval_requested/etc., ya redactado por agent-core
-- `redact()`) se escribe aparte en `public.audit_log` vía `record_audit_log()` (0008) --
-- esta tabla NO duplica esa traza fina, solo agrega el resumen que necesita el
-- presupuesto/reporte de costo (mucho más barato de sumar que recorrer audit_log
-- completo cada vez que se pinta /agentes/costos).
--
-- Append-only por diseño (sin policy de UPDATE/DELETE para `authenticated`, mismo
-- criterio que `audit_log`): una corrida ya cerrada no se corrige, se audita.

create type public.agent_gate as enum ('shadow', 'propone', 'autopilot');

create type public.agent_run_status as enum (
  'completado',
  'esperando_aprobacion',
  'accion_rechazada',
  'agotado_pasos',
  'presupuesto_agotado',
  'no_configurado',
  'error_proveedor',
  'paralelismo_dinero_bloqueado',
  'truncado'
);

create table public.agent_run (
  id uuid primary key default gen_random_uuid(),
  -- runId que generó AgentRunner.run() (packages/agent-core/src/runner.ts) -- no es la
  -- PK de esta fila porque un mismo runId conceptual podría, en un hito futuro,
  -- corresponder a más de un registro (p.ej. reintentos); hoy es 1:1.
  run_id uuid not null,
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- Nombre de la configuración de agente (packages/agent-core/src/agents.ts), p.ej.
  -- "recepcion_virtual" / "enrutador_mensajes" / "auditor_nocturno" -- texto, no un
  -- catálogo en BD: el catálogo de agentes es código (ADR-006, "agentes como
  -- configuración, no prompts sueltos"), no una tabla más que sincronizar.
  agent_name text not null,
  model_role text not null,
  provider_id text not null,
  model_slug text not null,
  gate public.agent_gate not null,
  status public.agent_run_status not null,
  steps integer not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  request_id text not null,
  actor_type text not null,
  actor_id text not null,
  duration_ms integer not null default 0,
  -- Mensaje de cierre YA seguro para el humano (AgentRunResult.message, ver runner.ts) --
  -- nunca detalle interno de implementación.
  message text,
  created_at timestamptz not null default now()
);

create index agent_run_hotel_created_idx on public.agent_run (hotel_id, created_at desc);
-- Índice de apoyo específico para la agregación mensual por (hotel, agente) que usa
-- `agent_cost_mes()` abajo y el reporte de /agentes/costos.
create index agent_run_hotel_agent_created_idx on public.agent_run (hotel_id, agent_name, created_at);

alter table public.agent_run enable row level security;
-- SELECT: transparencia total dentro del hotel (cualquier rol de staff ve el historial
-- de corridas de agente de su hotel, igual que agent_approval).
create policy "agent_run_hotel_select" on public.agent_run for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
-- INSERT: cualquier miembro del staff del hotel que disparó la corrida (vía
-- apps/api/src/routes/agentes.ts, dentro de `dbSession` -- RLS real).
create policy "agent_run_hotel_insert" on public.agent_run for insert to authenticated
  with check (hotel_id = any (current_hotel_ids()));
-- Sin policy de UPDATE/DELETE para `authenticated`: append-only.

grant select, insert on public.agent_run to authenticated;

-- Suma el costo estimado del MES EN CURSO (UTC, date_trunc) para un hotel, opcionalmente
-- acotado a un agente -- REQ-AGT-020 "función que suma costo del mes por hotel".
-- security definer + revoke/grant explícitos (mismo patrón que current_tenant_ids(),
-- 0003): de lectura pura (stable), sin efectos secundarios.
create or replace function public.agent_cost_mes(_hotel_id uuid, _agent_name text default null)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0)::numeric
  from public.agent_run
  where hotel_id = _hotel_id
    and created_at >= date_trunc('month', now())
    and (_agent_name is null or agent_name = _agent_name);
$$;

revoke all on function public.agent_cost_mes(uuid, text) from public;
grant execute on function public.agent_cost_mes(uuid, text) to atiende_app, authenticated;

-- ==== 0025_agent_config.sql ====
-- H7 · ADR-006/BP-016/BP-053/BP-054/GOB-036/REQ-AGT-020: configuración por (hotel,
-- agente) del gate (shadow -> propone -> autopilot) y el techo de costo mensual (USD,
-- LLM-026: banda de referencia ≈USD 27-158/mes por hotel de 45 habitaciones, según
-- opción de proveedor). Sin fila explícita para un (hotel, agente), la aplicación usa el
-- default de código (packages/agent-core/src/agents.ts, AGENT_DEFINITIONS) -- mismo
-- criterio que `StaticGateResolver` (roles.ts): ningún agente nuevo entra en autopilot
-- por omisión.
create table public.agent_config (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  agent_name text not null,
  gate public.agent_gate not null default 'shadow',
  monthly_ceiling_usd numeric(10, 2) not null check (monthly_ceiling_usd >= 0),
  currency text not null default 'USD',
  -- Umbral de alerta como fracción (0.800 = 80%) -- REQ-AGT-020 "alerta al 80%".
  alert_threshold_pct numeric(4, 3) not null default 0.800 check (alert_threshold_pct > 0 and alert_threshold_pct <= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, agent_name)
);

alter table public.agent_config enable row level security;
-- SELECT: cualquier rol de staff del hotel puede VER el gate/techo configurado (mismo
-- criterio de transparencia que agent_approval/agent_run).
create policy "agent_config_hotel_select" on public.agent_config for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
-- INSERT/UPDATE: cambiar el gate o el techo de costo de un agente es una decisión de
-- gobierno reservada a owner/gm (mismo nivel que `agent_approval_manager_update`, 0042).
create policy "agent_config_manager_insert" on public.agent_config for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "agent_config_manager_update" on public.agent_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.agent_config to authenticated;

-- ==== 0026_roi_event.sql ====
-- H7 · REQ-AGT-003/REQ-REV-018 (H17-001/BP-131/GOB-037): un `ROIEvent` por cada acción de
-- agente con valor económico -- `monto_verificado`/`monto_estimado`/`metodo_contrafactual`/
-- `confianza`, exactamente los 4 campos que exige H17-001, más el versionado explícito del
-- supuesto usado (`supuesto_version`, p.ej. "H17-v1" -> docs/referencia/03-investigacion-H12-H21.md
-- §H17) para que un cambio de fórmula/parámetro nunca reescriba en silencio el histórico ya
-- mostrado al dueño del hotel. `estimado = true` mientras no exista `monto_verificado`
-- (REQ-REV-018 "ningún cobro por resultado se activa sin línea base firmada" -- esta tabla
-- CAPTURA el evento con su supuesto, la lógica de línea base firmada y facturación por
-- resultado sobre esta captura queda pendiente de un hito posterior, ver README de este
-- paquete).
--
-- Append-only (mismo criterio que audit_log/agent_run): un evento de ROI ya registrado no
-- se corrige por UPDATE, se corrige con un evento nuevo -- el histórico de "qué se mostró
-- en cada momento" es en sí mismo parte de la transparencia prometida al dueño (H18-005).
create table public.roi_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  agent_name text not null,
  -- Tipo de evento de valor (p.ej. "checkin_asistido", "reserva_directa_atribuida",
  -- "hora_staff_liberada", "gasto_evitado_revenue") -- catálogo abierto a propósito
  -- (texto, no enum): H17 define 16 agentes con fórmulas de valor distintas y en
  -- evolución, un enum cerrado obligaría a migrar el esquema en cada ajuste de fórmula.
  tipo_evento text not null,
  monto_estimado numeric(12, 2),
  monto_verificado numeric(12, 2),
  metodo_contrafactual text not null,
  confianza numeric(4, 3) not null check (confianza >= 0 and confianza <= 1),
  supuesto_version text not null default 'H17-v1',
  -- true mientras no haya monto_verificado (contra línea base firmada, REQ-REV-018);
  -- se recalcula en el trigger de abajo, nunca se confía en el valor que mande la app.
  estimado boolean not null default true,
  referencia_tipo text not null default 'ninguna'
    check (referencia_tipo in ('reserva', 'folio', 'tarea', 'conversacion', 'ninguna')),
  -- Identificador de NEGOCIO (folio/código de reserva, no una FK) -- evita acoplar esta
  -- tabla a la forma exacta de cada entidad referenciada y evita filtrar un id de otro
  -- hotel: la fila ya está acotada por hotel_id, este campo es solo trazabilidad legible.
  referencia_codigo text,
  notas text,
  created_by text,
  created_at timestamptz not null default now(),
  check (monto_estimado is not null or monto_verificado is not null)
);

create index roi_event_hotel_created_idx on public.roi_event (hotel_id, created_at desc);
create index roi_event_hotel_agent_idx on public.roi_event (hotel_id, agent_name);

-- `estimado` es una columna DERIVADA de si hay monto_verificado -- se recalcula aquí en
-- vez de confiar en lo que la aplicación mande, para que la UI nunca pueda mostrar
-- "verificado" cuando en realidad nadie confirmó un monto contra línea base.
create or replace function public.roi_event_set_estimado()
returns trigger
language plpgsql
as $$
begin
  new.estimado := (new.monto_verificado is null);
  return new;
end;
$$;

create trigger roi_event_set_estimado_trg
  before insert on public.roi_event
  for each row execute function public.roi_event_set_estimado();

alter table public.roi_event enable row level security;
create policy "roi_event_hotel_select" on public.roi_event for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
create policy "roi_event_hotel_insert" on public.roi_event for insert to authenticated
  with check (hotel_id = any (current_hotel_ids()));
-- Sin policy de UPDATE/DELETE: append-only (ver comentario de archivo).

grant select, insert on public.roi_event to authenticated;

-- ==== 0030_folio_engine.sql ====
-- H5 · Motor de folio (REQ-REC-004/012, REQ-BO-001/002): conceptos de cargo,
-- descuentos con umbral de autorización, reverso/transferencia SIN borrado físico,
-- split de folio y cierre con saldo cero o cuenta por cobrar autorizada. Expand-only
-- sobre 0007 (REQ-GOB-011): ninguna migración ya aplicada se edita.

-- ---------------------------------------------------------------------------
-- charge: concepto + reverso/transferencia trazables + permitir monto negativo SOLO
-- para 'descuento'/'reverso' (nunca para un cargo real, que sigue exigiendo monto>=0).
-- ---------------------------------------------------------------------------
alter table public.charge add column concept text not null default 'otro'
  check (concept in ('hospedaje', 'ab', 'extras', 'ajuste', 'propina', 'descuento', 'reverso', 'otro'));
alter table public.charge add column stay_date date;
alter table public.charge add column reverses_charge_id uuid references public.charge(id) on delete set null;
alter table public.charge add column transferred_from_charge_id uuid references public.charge(id) on delete set null;
alter table public.charge add column discount_authorized_by uuid references public.staff_user(id) on delete set null;
alter table public.charge add column night_audit_run_id uuid;

alter table public.charge drop constraint charge_amount_check;
alter table public.charge add constraint charge_amount_check
  check (amount >= 0 or concept in ('descuento', 'reverso'));
alter table public.charge drop constraint charge_tax_amount_check;
alter table public.charge add constraint charge_tax_amount_check
  check (tax_amount >= 0 or concept = 'reverso');

-- Night audit nunca postea dos veces el mismo cargo de hospedaje para la misma noche
-- del mismo folio (idempotencia real, no solo "no se llamó dos veces" — ver
-- apps/api/src/jobs/nightAudit.ts). Los reversos de un cargo de hospedaje no llevan
-- `stay_date` (se documentan con `reverses_charge_id`), así que el índice parcial no
-- los bloquea.
create unique index charge_folio_stay_date_hospedaje_idx
  on public.charge (folio_id, stay_date)
  where concept = 'hospedaje' and stay_date is not null and reverses_charge_id is null;

-- Reverso de un cargo (REQ-REC-004): UPDATE restringido a esta función SECURITY
-- DEFINER porque `charge` solo tiene GRANT de select+insert para `authenticated`
-- (0010) — igual que `record_audit_log`, la autorización real ya ocurrió en la capa
-- de aplicación (assertRole + SELECT bajo RLS) antes de llamarla.
create or replace function public.mark_charge_reversed(_charge_id uuid, _reversal_charge_id uuid)
returns public.charge
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.charge;
begin
  update public.charge
  set reversed_by = _reversal_charge_id
  where id = _charge_id and reversed_by is null
  returning * into v_row;

  if not found then
    raise exception 'reverso_invalido: el cargo % no existe o ya fue reversado', _charge_id
      using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.mark_charge_reversed(uuid, uuid) from public;
grant execute on function public.mark_charge_reversed(uuid, uuid) to atiende_app, authenticated;

-- ---------------------------------------------------------------------------
-- folio: split (varios folios por reserva, uno "principal") + cierre (saldo cero o
-- cuenta por cobrar autorizada por un rol administrativo).
-- ---------------------------------------------------------------------------
drop index public.folio_reservation_idx;
alter table public.folio add column label text not null default 'Principal';
alter table public.folio add column is_primary boolean not null default true;
alter table public.folio add column closed_at timestamptz;
alter table public.folio add column close_reason text check (close_reason in ('saldo_cero', 'cuenta_por_cobrar'));
alter table public.folio add column ar_approved_by uuid references public.staff_user(id) on delete set null;
alter table public.folio add column ar_approved_reason text;

create index folio_reservation_idx on public.folio (reservation_id);
create unique index folio_reservation_primary_idx on public.folio (reservation_id) where is_primary;

-- ---------------------------------------------------------------------------
-- payment: estado real (máquina de estados de PaymentProviderPort) + referencia
-- opaca de token -- NUNCA PAN (REQ-REC-008/H19-005).
-- ---------------------------------------------------------------------------
alter table public.payment add column status text not null default 'capturado'
  check (status in ('pendiente', 'autorizado', 'capturado', 'fallido', 'reembolsado', 'expirado'));
alter table public.payment add column token_ref text;
alter table public.payment add column preauth_expires_at timestamptz;

alter table public.payment add constraint payment_token_ref_not_pan
  check (token_ref is null or token_ref !~ '^[0-9]{12,19}$');

-- ---------------------------------------------------------------------------
-- hotel_tax_config: umbral de descuento (REQ-REC-012 estilo, autorización por rol) +
-- DSA por cuarto-noche (REQ-BO-007), parametrizados por hotel -- nunca un valor fijo
-- en código.
-- ---------------------------------------------------------------------------
alter table public.hotel_tax_config add column discount_threshold numeric(12, 2) not null default 500
  check (discount_threshold >= 0);
alter table public.hotel_tax_config add column dsa_per_night numeric(12, 2) not null default 0
  check (dsa_per_night >= 0);
alter table public.hotel_tax_config add column state_code text not null default 'ROO';
-- RFC emisor del hotel (H16-007): sin valor por defecto -- un CFDI nunca se timbra con
-- un RFC "de verdad" fabricado en código; la ruta de CFDI responde 400 explícito si
-- esta columna es NULL (mismo patrón que `loadTaxConfig`/`loadHotelMoneyConfig`).
alter table public.hotel_tax_config add column rfc_emisor text;

comment on column public.hotel_tax_config.state_code is
  'Código de estado (INEGI/uso interno) para el que aplica ish_rate/dsa_per_night -- ISH/DSA varían por estado/municipio (H16-010/011), este módulo nunca asume Quintana Roo por defecto en el cálculo, solo en el dato sembrado.';

-- ==== 0031_night_audit.sql ====
-- H5 · Night audit propio (REQ-REV-013/H16-003), independiente del PMS del hotel:
-- postea hospedaje a folios en casa, marca no-shows (reutiliza jobs/noShow.ts),
-- congela el día y genera un resumen de caja. Idempotente por diseño: una segunda
-- corrida del MISMO (hotel_id, business_date) siempre devuelve el resumen ya
-- guardado, sin volver a postear nada (verificado en
-- tests/integration/revenue/night-audit.spec.ts).

create table public.night_audit_run (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  business_date date not null,
  status text not null default 'en_progreso' check (status in ('en_progreso', 'completado')),
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (hotel_id, business_date)
);
create index night_audit_run_tenant_hotel_idx on public.night_audit_run (tenant_id, hotel_id);

alter table public.night_audit_run enable row level security;
create policy "night_audit_run_money_role_select" on public.night_audit_run for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
-- GRANT + RLS son independientes (ver 0010): sin este GRANT la política de arriba
-- nunca llega a evaluarse -- `authenticated` solo puede SELECT (la única escritura
-- sancionada son las dos funciones SECURITY DEFINER de abajo).
grant select on public.night_audit_run to authenticated;
-- Sin policy de insert/update para `authenticated`: toda escritura pasa por las dos
-- funciones SECURITY DEFINER de abajo, para poder tomar el advisory lock y resolver
-- la carrera "dos corridas concurrentes del mismo día" de forma atómica dentro de la
-- función, no en el código de aplicación.

-- night_audit_claim(): serializa dos corridas concurrentes del MISMO
-- (hotel_id, business_date) con un advisory lock de transacción y reclama la corrida
-- con `insert ... on conflict do nothing`. Si ya existe una corrida completada, la
-- devuelve tal cual (already_completed = true) para que el llamador NUNCA vuelva a
-- postear cargos.
create or replace function public.night_audit_claim(
  _tenant_id uuid,
  _hotel_id uuid,
  _business_date date
)
returns table (run_id uuid, already_completed boolean, summary jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.night_audit_run;
begin
  perform pg_advisory_xact_lock(hashtext('night_audit:' || _hotel_id::text || ':' || _business_date::text));

  insert into public.night_audit_run (tenant_id, hotel_id, business_date, status)
  values (_tenant_id, _hotel_id, _business_date, 'en_progreso')
  on conflict (hotel_id, business_date) do nothing
  returning * into v_row;

  if found then
    return query select v_row.id, false, v_row.summary;
    return;
  end if;

  select * into v_row from public.night_audit_run
  where hotel_id = _hotel_id and business_date = _business_date;

  return query select v_row.id, (v_row.status = 'completado'), v_row.summary;
end;
$$;

revoke all on function public.night_audit_claim(uuid, uuid, date) from public;
grant execute on function public.night_audit_claim(uuid, uuid, date) to atiende_app, authenticated;

create or replace function public.night_audit_finish(_run_id uuid, _summary jsonb)
returns public.night_audit_run
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.night_audit_run;
begin
  update public.night_audit_run
  set status = 'completado', summary = _summary, completed_at = now()
  where id = _run_id
  returning * into v_row;

  if not found then
    raise exception 'night_audit_run_no_encontrado: %', _run_id using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.night_audit_finish(uuid, jsonb) from public;
grant execute on function public.night_audit_finish(uuid, jsonb) to atiende_app, authenticated;

-- ==== 0032_cfdi_emision.sql ====
-- H5 · Registro de emisiones CFDI de hospedaje (REQ-BO-001/002, H16-007) sobre el
-- `CfdiPort` ya construido en packages/mcp-servers/cfdi (H9/H11) -- esta tabla NO
-- reimplementa el puerto, solo guarda el resultado devuelto por él con el estado de
-- dominio (timbrado/cancelado) y el desglose fiscal aplicado al folio, para poder
-- mostrarlo en /back-office con estado real o "pendiente de PAC".

create table public.cfdi_emision (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  folio_id uuid not null references public.folio(id) on delete restrict,
  tipo text not null check (tipo in ('hospedaje', 'pago')),
  uuid_fiscal uuid,
  status text not null check (status in ('pendiente', 'timbrado', 'en_proceso_cancelacion', 'cancelado', 'rechazado')),
  pac text,
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  iva numeric(12, 2) not null default 0 check (iva >= 0),
  impuestos_locales jsonb not null default '{}'::jsonb,
  total numeric(12, 2) not null check (total >= 0),
  rfc_receptor text not null,
  uso_cfdi text not null,
  metodo_pago text not null,
  es_extranjero boolean not null default false,
  es_global boolean not null default false,
  es_no_show boolean not null default false,
  related_cfdi_id uuid references public.cfdi_emision(id) on delete set null,
  payment_id uuid references public.payment(id) on delete set null,
  created_at timestamptz not null default now(),
  canceled_at timestamptz
);
create index cfdi_emision_folio_idx on public.cfdi_emision (folio_id);
create index cfdi_emision_tenant_hotel_idx on public.cfdi_emision (tenant_id, hotel_id);
-- Idempotencia a nivel de aplicación (REQ-BO-002): a lo más UN CFDI de tipo
-- 'hospedaje' por folio, y a lo más UNO de tipo 'pago' por pago -- el endpoint
-- verifica esto ANTES de llamar al `CfdiPort`, este índice es la última línea de
-- defensa contra una carrera que lo intentara dos veces.
create unique index cfdi_emision_folio_hospedaje_unq on public.cfdi_emision (folio_id)
  where tipo = 'hospedaje';
create unique index cfdi_emision_payment_unq on public.cfdi_emision (payment_id)
  where tipo = 'pago';

alter table public.cfdi_emision enable row level security;

create policy "cfdi_emision_money_role_select" on public.cfdi_emision for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
create policy "cfdi_emision_accountant_insert" on public.cfdi_emision for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  );
create policy "cfdi_emision_accountant_update" on public.cfdi_emision for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[]));

grant select, insert, update on public.cfdi_emision to authenticated;

-- ==== 0033_calendario_fiscal.sql ====
-- H5 · Calendario de obligaciones fiscales (REQ-BO-008) + aprobación humana explícita
-- requerida antes de marcar una obligación como presentada cuando usa e.firma
-- (REQ-BO-006/GOB-041): ninguna presentación al SAT ocurre sin una fila de aprobación
-- registrada -- verificado con un trigger (defensa en profundidad, no solo en la API).

create table public.fiscal_obligation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  tipo text not null check (tipo in ('iva_isr', 'diot', 'ish', 'balanza', 'predial', 'licencias', 'imss')),
  requiere_efirma boolean not null default false,
  due_date date not null,
  status text not null default 'pendiente' check (status in ('pendiente', 'presentada')),
  created_at timestamptz not null default now(),
  presented_at timestamptz
);
create index fiscal_obligation_tenant_hotel_idx on public.fiscal_obligation (tenant_id, hotel_id, due_date);

create table public.sat_filing_approval (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  obligation_id uuid not null references public.fiscal_obligation(id) on delete cascade,
  approved_by uuid not null references public.staff_user(id) on delete restrict,
  approved_at timestamptz not null default now(),
  nota text
);
create index sat_filing_approval_obligation_idx on public.sat_filing_approval (obligation_id);

-- Defensa en profundidad (REQ-BO-006): incluso si un rol con UPDATE sobre
-- fiscal_obligation intentara marcar 'presentada' sin pasar por la ruta de la API
-- que exige aprobación, el trigger lo rechaza si no existe una fila de
-- sat_filing_approval para esa obligación Y esa obligación requiere e.firma.
create or replace function public.fiscal_obligation_requires_approval()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'presentada' and old.status <> 'presentada' and new.requiere_efirma then
    if not exists (select 1 from public.sat_filing_approval where obligation_id = new.id) then
      raise exception 'presentacion_no_autorizada: la obligación % requiere e.firma y no tiene aprobación humana registrada', new.id
        using errcode = 'P0001';
    end if;
    new.presented_at := coalesce(new.presented_at, now());
  end if;
  return new;
end;
$$;

create trigger fiscal_obligation_requires_approval_trg
  before update of status on public.fiscal_obligation
  for each row execute function public.fiscal_obligation_requires_approval();

alter table public.fiscal_obligation enable row level security;
alter table public.sat_filing_approval enable row level security;

create policy "fiscal_obligation_admin_select" on public.fiscal_obligation for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  );
create policy "fiscal_obligation_admin_insert" on public.fiscal_obligation for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  );
create policy "fiscal_obligation_admin_update" on public.fiscal_obligation for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[]));

create policy "sat_filing_approval_admin_select" on public.sat_filing_approval for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  );
-- Solo owner/gm aprueban la presentación (el nivel más alto de aprobación local, ver
-- ADR-004 tabla de roles) -- accountant PREPARA la obligación pero no se autoaprueba.
create policy "sat_filing_approval_owner_gm_insert" on public.sat_filing_approval for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
-- Sin policy de update/delete: la aprobación, una vez registrada, es inmutable.

grant select, insert, update on public.fiscal_obligation to authenticated;
grant select, insert on public.sat_filing_approval to authenticated;

-- ==== 0040_housekeeping_room_status.sql ====
-- H6b · REQ-HK-001/003/004: estado de LIMPIEZA de una habitacion, distinto del estado de
-- disponibilidad/reserva (`room.status`, 0004 -- disponible/ocupada/sucia/fuera_de_servicio/
-- mantenimiento, que gobierna venta/inventario). Una habitacion puede estar "disponible"
-- para venta y "sucia" para housekeeping al mismo tiempo (recien liberada por checkout,
-- antes de que la camarista la limpie) -- por eso es una columna nueva, no una reutilizacion
-- del enum existente. Con historial append-only, mismo patron que
-- `reservation_status_event` (0006): la columna viva en `room` para lectura simple, la
-- bitacora inmutable en una tabla aparte via trigger SECURITY DEFINER.

create type public.housekeeping_room_status as enum ('sucia', 'limpia', 'inspeccionada', 'fuera_de_servicio');

alter table public.room
  add column housekeeping_status public.housekeeping_room_status not null default 'sucia';

create table public.room_housekeeping_status_event (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.room(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  from_status public.housekeeping_room_status,
  to_status public.housekeeping_room_status not null,
  actor_user_id uuid,
  note text,
  created_at timestamptz not null default now()
);
create index room_hk_status_event_room_idx on public.room_housekeeping_status_event (room_id, created_at);
create index room_hk_status_event_tenant_idx on public.room_housekeeping_status_event (tenant_id, hotel_id);

create or replace function public.room_log_housekeeping_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.room_housekeeping_status_event (room_id, tenant_id, hotel_id, from_status, to_status, actor_user_id)
    values (new.id, new.tenant_id, new.hotel_id, null, new.housekeeping_status, auth.uid());
    return new;
  end if;

  if new.housekeeping_status is distinct from old.housekeeping_status then
    insert into public.room_housekeeping_status_event (room_id, tenant_id, hotel_id, from_status, to_status, actor_user_id)
    values (new.id, new.tenant_id, new.hotel_id, old.housekeeping_status, new.housekeeping_status, auth.uid());
  end if;
  return new;
end;
$$;

-- `room` ya existe desde 0004 sin triggers propios: se agregan aqui (expand-only) para
-- que TODA fila (nueva o ya existente en este mismo pase de migracion) quede con su
-- primer evento de historial registrado desde este punto en adelante.
create trigger room_log_hk_status_ins_trg
  after insert on public.room
  for each row execute function public.room_log_housekeeping_status_event();
create trigger room_log_hk_status_upd_trg
  after update on public.room
  for each row execute function public.room_log_housekeeping_status_event();

alter table public.room_housekeeping_status_event enable row level security;

-- Mismo reparto de roles que `room` (0004): housekeeping/mantenimiento/frontdesk/gm/owner
-- pueden leer el historial de limpieza de su hotel; la escritura SOLO ocurre via el
-- trigger SECURITY DEFINER de arriba (append-only, ningun rol de aplicacion recibe
-- INSERT/UPDATE/DELETE directo sobre esta tabla).
create policy "room_hk_status_event_tenant_select" on public.room_housekeeping_status_event
  for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));

grant select on public.room_housekeeping_status_event to authenticated;

-- ==== 0041_housekeeping_task.sql ====
-- H6b · REQ-HK-001/002/003/020: tarea de housekeeping (asignacion diaria de camarista +
-- checklist + evidencia de inspeccion). RLS: `housekeeping` solo ve/actualiza las tareas
-- asignadas a ELLA (auth.uid() = assigned_to); owner/gm/frontdesk ven y administran todas
-- las del hotel (tablero de supervision). `started_at`/`finished_at` son la base minima
-- del registro de minutos reales (REQ-HK-020) -- el calculo agregado contra nomina queda
-- fuera de alcance de este hito, documentado, no simulado.

create type public.housekeeping_task_priority as enum ('alta', 'media', 'baja');
create type public.housekeeping_task_status as enum ('pendiente', 'en_progreso', 'completada', 'cancelada');

create table public.housekeeping_task (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid not null references public.room(id) on delete cascade,
  assigned_to uuid references public.staff_user(id) on delete set null,
  priority public.housekeeping_task_priority not null default 'media',
  status public.housekeeping_task_status not null default 'pendiente',
  sla_due_at timestamptz,
  checklist jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  notes text,
  started_at timestamptz,
  finished_at timestamptz,
  inspected_by uuid references public.staff_user(id) on delete set null,
  inspected_at timestamptz,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index housekeeping_task_tenant_hotel_idx on public.housekeeping_task (tenant_id, hotel_id);
create index housekeeping_task_room_idx on public.housekeeping_task (room_id);
create index housekeeping_task_assigned_idx on public.housekeeping_task (hotel_id, assigned_to, status);

alter table public.housekeeping_task enable row level security;

create policy "housekeeping_task_scope_select" on public.housekeeping_task for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and hotel_id = any (current_hotel_ids())
    and (
      has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
      or (has_hotel_role(hotel_id, array['housekeeping']::public.hotel_role[]) and assigned_to = auth.uid())
    )
  );
create policy "housekeeping_task_supervisor_insert" on public.housekeeping_task for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
  );
-- UPDATE: la propia camarista puede avanzar SU tarea (inicio/termino/checklist/evidencia);
-- owner/gm/frontdesk pueden reasignar/inspeccionar/cancelar cualquiera del hotel. La
-- restriccion de QUE columnas puede tocar cada rol vive en apps/api (RLS aqui protege la
-- FILA, no la columna) -- documentado explicitamente, no fingido como control de columna.
create policy "housekeeping_task_scope_update" on public.housekeeping_task for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
    or (has_hotel_role(hotel_id, array['housekeeping']::public.hotel_role[]) and assigned_to = auth.uid())
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
    or (has_hotel_role(hotel_id, array['housekeeping']::public.hotel_role[]) and assigned_to = auth.uid())
  );
create policy "housekeeping_task_supervisor_delete" on public.housekeeping_task for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.housekeeping_task to authenticated;

-- ==== 0042_agent_approval.sql ====
-- H6b · Persistencia de la cola de aprobacion humana (ADR-006, GOB-026) descrita como
-- pendiente en `packages/agent-core/src/approval.ts`/README (H6a): el CONTRATO
-- (`ApprovalQueue`) no cambia, esta tabla es el respaldo para una implementacion
-- `PostgresApprovalQueue` que lo cumpla sin tocar `AgentRunner` ni las tools. Espejo de
-- `ApprovalRequest`/`ApprovalConfirmation` de agent-core: una fila por solicitud, una
-- tabla de confirmaciones aparte para soportar la doble confirmacion de dinero (2 filas
-- de actores/roles distintos, GOB-026).

create type public.agent_approval_status as enum ('pendiente', 'aprobada', 'rechazada', 'expirada');
create type public.agent_approval_decision as enum ('aprobar', 'rechazar');

create table public.agent_approval (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  tool_name text not null,
  input_hash text not null,
  -- Resumen legible del input REAL (redactado) que recibio la tool -- GOB-026: el
  -- aprobador no firma a ciegas. Ver agent-core `describeApprovalInput`.
  input_summary text not null,
  texto_mostrado text not null,
  -- Ambito de conversacion/actor que pidio la accion (p.ej. "agent:<agente>:<actor.id>")
  -- -- forma parte de la llave de idempotencia junto con (hotel, tool, hash(input)) para
  -- que dos conversaciones distintas NUNCA compartan la misma solicitud (aud-1
  -- tool-calling.md CRITICO #1, ver agent-core/src/approval.ts).
  requested_by text not null,
  is_money boolean not null default false,
  required_confirmations integer not null default 1 check (required_confirmations > 0),
  status public.agent_approval_status not null default 'pendiente',
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Indice de apoyo para la busqueda de idempotencia (hotel, tool, hash(input),
-- requested_by) ordenada por vigencia -- ver PostgresApprovalQueue.request() en
-- packages/agent-core. Sin UNIQUE: una solicitud VENCIDA no bloquea crear una nueva con
-- la misma llave (mismo contrato que InMemoryApprovalQueue), asi que puede haber varias
-- filas historicas con la misma llave.
create index agent_approval_lookup_idx
  on public.agent_approval (hotel_id, tool_name, input_hash, requested_by, expires_at desc);
create index agent_approval_hotel_status_idx on public.agent_approval (hotel_id, status);

create table public.agent_approval_confirmation (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.agent_approval(id) on delete cascade,
  actor text not null,
  -- Rol declarado del aprobador; obligatorio en la app para aprobar dinero (GOB-026: DOS
  -- ROLES distintos, no solo dos actores) -- ver agent-core `decide()`.
  role text,
  decision public.agent_approval_decision not null,
  texto_exacto text not null,
  decided_at timestamptz not null default now()
);
create index agent_approval_confirmation_approval_idx on public.agent_approval_confirmation (approval_id);

-- Advisory lock (mismo patron que `lock_availability`, 0004): serializa request() por
-- (hotel, tool, hash(input), requested_by) para que dos llamadas concurrentes con la
-- MISMA llave de idempotencia nunca creen dos solicitudes duplicadas.
create or replace function public.lock_agent_approval_key(
  _hotel_id uuid, _tool_name text, _input_hash text, _requested_by text
)
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(_hotel_id::text || ':' || _tool_name || ':' || _input_hash || ':' || _requested_by, 0)
  );
end;
$$;

alter table public.agent_approval enable row level security;
alter table public.agent_approval_confirmation enable row level security;

-- SELECT: transparencia total dentro del hotel (cualquier rol de staff puede ver la
-- bandeja de aprobaciones de su hotel, incluida la propia badge de pendientes del header).
create policy "agent_approval_hotel_select" on public.agent_approval for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
-- INSERT: cualquier miembro del staff del hotel puede generar una solicitud (la produce
-- el agente en nombre de una accion que un miembro del staff disparo desde la UI/WhatsApp).
create policy "agent_approval_hotel_insert" on public.agent_approval for insert to authenticated
  with check (hotel_id = any (current_hotel_ids()));
-- UPDATE (decidir/expirar): autoridad de aprobacion reservada a owner/gm -- mismo nivel
-- que "quien puede aprobar dinero" en el resto del sistema (ver `can_access_money`,
-- 0007, que SI incluye frontdesk/reservations/fnb/accountant para operaciones de folio;
-- aqui es mas estricto a proposito porque una aprobacion de agente puede autorizar
-- CUALQUIER tool "external"/"money" registrada, no solo cargos de folio).
create policy "agent_approval_manager_update" on public.agent_approval for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "agent_approval_confirmation_hotel_select" on public.agent_approval_confirmation for select to authenticated
  using (
    exists (
      select 1 from public.agent_approval a
      where a.id = approval_id and a.hotel_id = any (current_hotel_ids())
    )
  );
create policy "agent_approval_confirmation_manager_insert" on public.agent_approval_confirmation for insert to authenticated
  with check (
    exists (
      select 1 from public.agent_approval a
      where a.id = approval_id
        and has_hotel_role(a.hotel_id, array['owner', 'gm']::public.hotel_role[])
    )
  );

grant select, insert, update on public.agent_approval to authenticated;
grant select, insert on public.agent_approval_confirmation to authenticated;
grant execute on function public.lock_agent_approval_key(uuid, text, text, text) to atiende_app, authenticated;

-- ==== 0043_maintenance_ticket.sql ====
-- H6b · REQ-HK-011/013/014: ticket de mantenimiento correctivo. `origin` cubre las
-- fuentes exigidas (huesped/staff/agente/sensor); `estimated_cost`/`actual_cost` +
-- `approval_id` enlazan con `agent_approval` (0042) cuando el costo supera el umbral que
-- decide `apps/api` (tool "autorizar gasto de mantenimiento" en agent-core, needsApproval
-- money). RLS: `maintenance` solo lee/escribe SUS tickets asignados (ni siquiera ve el
-- costo de los de otro tecnico); `housekeeping` puede REPORTAR un ticket (insert) pero no
-- leerlo de vuelta ni cambiar su costo/estado (sin policy de select/update para ese rol,
-- fail-closed); recepcion/gerente ven y administran todos los del hotel.

create type public.maintenance_ticket_origin as enum ('huesped', 'staff', 'agente', 'sensor');
create type public.maintenance_ticket_severity as enum ('alta', 'media', 'baja');
create type public.maintenance_ticket_status as enum ('abierto', 'asignado', 'en_progreso', 'cerrado', 'cancelado');

create table public.maintenance_ticket (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid references public.room(id) on delete set null,
  title text not null,
  description text not null,
  origin public.maintenance_ticket_origin not null default 'staff',
  severity public.maintenance_ticket_severity not null default 'media',
  status public.maintenance_ticket_status not null default 'abierto',
  assigned_to uuid references public.staff_user(id) on delete set null,
  estimated_cost numeric(12, 2) not null default 0 check (estimated_cost >= 0),
  actual_cost numeric(12, 2) check (actual_cost is null or actual_cost >= 0),
  requires_approval boolean not null default false,
  approval_id uuid references public.agent_approval(id) on delete set null,
  part_used text,
  resolution_note text,
  evidence jsonb not null default '[]'::jsonb,
  marks_room_out_of_service boolean not null default false,
  created_by uuid references public.staff_user(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index maintenance_ticket_tenant_hotel_idx on public.maintenance_ticket (tenant_id, hotel_id);
create index maintenance_ticket_room_idx on public.maintenance_ticket (room_id) where room_id is not null;
create index maintenance_ticket_assigned_idx on public.maintenance_ticket (hotel_id, assigned_to, status);

alter table public.maintenance_ticket enable row level security;

-- `or created_by = auth.uid()`: sin esto, un INSERT con RETURNING desde un rol que
-- reporta pero no gestiona (housekeeping) es rechazado por Postgres como violacion de RLS
-- -- `INSERT ... RETURNING` verifica la fila resultante contra la policy de SELECT, no
-- solo contra el WITH CHECK de INSERT (comprobado empiricamente: sin esta clausula, la
-- camarista NUNCA puede crear un ticket, ni siquiera el suyo propio). Quien reporta puede
-- seguir SU PROPIO reporte; sigue sin poder ver ni cambiar el costo de tickets ajenos
-- (adversarial: "camarista no ve tareas de otro hotel ni cambia costo").
create policy "maintenance_ticket_manager_select" on public.maintenance_ticket for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and (
      has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
      or (has_hotel_role(hotel_id, array['maintenance']::public.hotel_role[]) and assigned_to = auth.uid())
      or created_by = auth.uid()
    )
  );
-- Cualquier miembro del staff del hotel puede REPORTAR un ticket (REQ-HK-011: camarista,
-- recepcion, o el propio agente en nombre de un huesped/sensor).
create policy "maintenance_ticket_staff_insert" on public.maintenance_ticket for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'housekeeping', 'maintenance']::public.hotel_role[]
    )
  );
-- UPDATE (incluye costo/estado/cierre): NUNCA housekeeping ni frontdesk -- solo owner/gm
-- o el tecnico de mantenimiento AL QUE ESTA ASIGNADO el ticket (adversarial: "camarista
-- no cambia costo").
create policy "maintenance_ticket_scope_update" on public.maintenance_ticket for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
    or (has_hotel_role(hotel_id, array['maintenance']::public.hotel_role[]) and assigned_to = auth.uid())
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
    or (has_hotel_role(hotel_id, array['maintenance']::public.hotel_role[]) and assigned_to = auth.uid())
  );
create policy "maintenance_ticket_manager_delete" on public.maintenance_ticket for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.maintenance_ticket to authenticated;

-- ==== 0044_conversation_message.sql ====
-- H6b · REQ-HUE-*/REQ-HK-002/013/021: bandeja de mensajeria por huesped (WhatsApp/voz/web)
-- sobre el `MessagingPort` de `packages/mcp-servers/whatsapp` (H9), sin llamar nunca a
-- Meta de verdad en este hito -- `hotel_messaging_config.webhook_secret` es el secreto del
-- ADAPTADOR FAKE por hotel (HMAC del webhook simulado, ver README de ese paquete);
-- `message.simulated=true` deja explicito en el propio dato que la entrega es simulada
-- mientras no haya credenciales reales de Meta (ver README de este hito, "PENDIENTE DE
-- CREDENCIALES"). `message.body` NO se redacta al guardarse (el staff necesita leer el
-- mensaje real del huesped) -- la redaccion de PII aplica a TRAZAS/logs del agente
-- (agent-core `redact()`), no al dato operativo protegido por RLS.

create table public.hotel_messaging_config (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  provider text not null default 'meta-whatsapp',
  webhook_secret text not null,
  tier text not null default 'tier_1k',
  -- Plantillas que la tool "enviar mensaje WhatsApp" puede mandar SIN pasar por
  -- ApprovalQueue (transaccionales: confirmacion de reserva, recordatorio de checkin...).
  -- Cualquier otra plantilla/mensaje libre exige aprobacion humana (needsApproval=true,
  -- effect="external", ver agent-core tools de este hito).
  transactional_templates text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type public.conversation_channel as enum ('whatsapp', 'voz', 'web');
create type public.conversation_status as enum ('abierta', 'cerrada');
create type public.message_direction as enum ('entrante', 'saliente');
create type public.message_delivery_status as enum ('enviado', 'entregado', 'leido', 'fallido');

create table public.conversation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid references public.guest(id) on delete set null,
  channel public.conversation_channel not null default 'whatsapp',
  guest_phone text,
  status public.conversation_status not null default 'abierta',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversation_tenant_hotel_idx on public.conversation (tenant_id, hotel_id);
create unique index conversation_hotel_guest_channel_idx
  on public.conversation (hotel_id, channel, guest_phone)
  where guest_phone is not null;

create table public.message (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  conversation_id uuid not null references public.conversation(id) on delete cascade,
  direction public.message_direction not null,
  channel public.conversation_channel not null,
  template_name text,
  body text not null,
  requires_approval boolean not null default false,
  approval_id uuid references public.agent_approval(id) on delete set null,
  client_message_id text,
  external_message_id text,
  delivery_status public.message_delivery_status,
  -- true mientras el adaptador de WhatsApp sea `FakeWhatsappAdapter` (sin credenciales de
  -- Meta) -- ver README del hito. El frontend usa esta columna para mostrar el estado de
  -- entrega como "simulado" en vez de aparentar una entrega real que nunca ocurrio.
  simulated boolean not null default true,
  created_at timestamptz not null default now()
);
create index message_conversation_idx on public.message (conversation_id, created_at);
create index message_tenant_hotel_idx on public.message (tenant_id, hotel_id);
-- Idempotencia de envio (clientMessageId, contrato MessagingPort) y de recepcion de
-- webhook (externalMessageId) por hotel.
create unique index message_hotel_client_message_idx
  on public.message (hotel_id, client_message_id)
  where client_message_id is not null;
create unique index message_hotel_external_message_idx
  on public.message (hotel_id, external_message_id)
  where external_message_id is not null;

-- Mantiene `conversation.last_message_at/status` en sincronia sin depender de que la capa
-- de aplicacion recuerde actualizarlo en cada INSERT de message (mismo espiritu SECURITY
-- DEFINER que `reservation_log_status_event`, 0006).
create or replace function public.conversation_touch_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversation
  set last_message_at = new.created_at, updated_at = now(), status = 'abierta'
  where id = new.conversation_id;
  return new;
end;
$$;
create trigger conversation_touch_on_message_trg
  after insert on public.message
  for each row execute function public.conversation_touch_on_message();

alter table public.hotel_messaging_config enable row level security;
alter table public.conversation enable row level security;
alter table public.message enable row level security;

create policy "hotel_messaging_config_manager_select" on public.hotel_messaging_config for select to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]));
create policy "hotel_messaging_config_manager_insert" on public.hotel_messaging_config for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_messaging_config_manager_update" on public.hotel_messaging_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

-- SELECT amplio (cualquier staff del hotel) -- la bandeja de mensajeria es transversal
-- (recepcion, gerente, y cualquier agente que necesite dar seguimiento a un huesped).
create policy "conversation_staff_select" on public.conversation for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "conversation_frontdesk_insert" on public.conversation for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "conversation_frontdesk_update" on public.conversation for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));

create policy "message_staff_select" on public.message for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "message_frontdesk_insert" on public.message for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );

grant select, insert, update on public.hotel_messaging_config to authenticated;
grant select, insert, update on public.conversation to authenticated;
grant select, insert on public.message to authenticated;

-- ==== 0045_agent_approval_input_json.sql ====
-- H6b · `agent_approval.input_json`: el input REAL (ya validado por Zod) que recibio la
-- tool, ademas de `input_hash`/`input_summary` (0042). Necesario para que `apps/api`
-- pueda "reproducir" la ejecucion de la tool DESPUES de que la doble confirmacion se
-- completo fuera del bucle de `AgentRunner` (p.ej. un humano decide via
-- POST /aprobaciones/:id/decidir en dos peticiones HTTP separadas, no dentro de una sola
-- corrida de agente) -- `AgentRunner.run()` no lo necesita porque conserva `parsed.data`
-- en memoria durante su propia corrida; `PostgresApprovalQueue` SI lo persiste para que
-- ese flujo fuera-de-banda sea posible. NO forma parte del contrato `ApprovalQueue`
-- (`ApprovalRequest` no gana este campo): es una extension propia de
-- `PostgresApprovalQueue.getStoredInput()`, documentada en agent-core.

alter table public.agent_approval add column input_json jsonb;

-- ==== 0050_experience_catalog_and_public_order.sql ====
-- REQ-TEN-004 (GOB-039): "Toda escritura anónima o de bajo privilegio (registro
-- público de check-in, pedidos de huésped sin cuenta, catálogo de experiencias) debe
-- pasar exclusivamente por una función RPC SECURITY DEFINER que recalcule los valores
-- en servidor, nunca aceptando el valor/precio enviado por el cliente."
--
-- Instancia concreta elegida: catálogo de experiencias + pedido público de huésped SIN
-- cuenta (verificado por código de reserva + apellido, mismo criterio que
-- `cancel_reservation_public`, migración 0013/REQ-RES-005). El precio SIEMPRE se lee
-- del catálogo del servidor (`experience_catalog.price`) -- la función
-- `order_experience_public` no declara ningún parámetro de precio/total: es
-- ESTRUCTURALMENTE imposible que un cliente influya en el monto cobrado, no solo una
-- validación que podría olvidarse (ver tests/adversarial/rpc-security-definer.spec.ts).
--
-- El rate limit por IP (REQ-TEN-004 "con rate limit") ya se aplica de forma GLOBAL a
-- toda ruta de apps/api (`ipRateLimit`, apps/api/src/middleware.ts, montado en
-- apps/api/src/app.ts) -- esta ruta pública no necesita ni declara uno adicional.
--
-- Expand-only sobre migraciones ya mergeadas (REQ-GOB-010): tablas nuevas, ninguna
-- migración existente se edita.

create table public.experience_catalog (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  name text not null,
  description text,
  price numeric(12, 2) not null check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index experience_catalog_tenant_hotel_idx on public.experience_catalog (tenant_id, hotel_id);
create index experience_catalog_hotel_active_idx on public.experience_catalog (hotel_id) where active;

alter table public.experience_catalog enable row level security;

-- Gestión del catálogo: solo owner/gm (mismo criterio que `hotel_tax_config`, 0013 --
-- fijar precios de venta al público es una decisión de negocio, no operativa).
create policy "experience_catalog_tenant_select" on public.experience_catalog for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "experience_catalog_tenant_insert" on public.experience_catalog for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "experience_catalog_tenant_update" on public.experience_catalog for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

-- Pedidos: registro append-only de lo que un huésped SIN cuenta pidió del catálogo,
-- ya con el precio/total recalculado en servidor. `client_request_id` es la llave de
-- idempotencia opcional del propio cliente (huésped) para tolerar reintento de red sin
-- duplicar el cargo -- mismo espíritu que `Idempotency-Key`, ver
-- apps/api/src/lib/idempotency.ts, pero embebida en la función SECURITY DEFINER porque
-- aquí no existe todavía un `tenant_id` conocido antes de verificar identidad.
create table public.experience_order (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete restrict,
  experience_id uuid not null references public.experience_catalog(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 20),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  total_amount numeric(12, 2) not null check (total_amount >= 0),
  folio_charge_id uuid references public.charge(id) on delete set null,
  client_request_id text,
  created_at timestamptz not null default now()
);
create index experience_order_reservation_idx on public.experience_order (reservation_id);
create index experience_order_tenant_hotel_idx on public.experience_order (tenant_id, hotel_id);
-- Idempotencia real: mismo (reservation_id, client_request_id) no puede insertar dos
-- filas -- `order_experience_public` hace SELECT antes de INSERT (ver más abajo), pero
-- este índice es la garantía de fondo bajo concurrencia real (dos requests a la vez).
create unique index experience_order_reservation_client_request_idx
  on public.experience_order (reservation_id, client_request_id)
  where client_request_id is not null;

alter table public.experience_order enable row level security;

-- Solo lectura para roles con acceso a dinero del hotel (mismo criterio que
-- `folio`/`charge`, 0007) -- ninguna policy de insert/update para `authenticated`:
-- toda escritura pasa por `order_experience_public` (SECURITY DEFINER, abajo).
create policy "experience_order_money_role_select" on public.experience_order for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
grant select on public.experience_order to authenticated;
grant select on public.experience_catalog to authenticated;

-- list_experience_catalog_public(): catálogo activo de un hotel, sin autenticación --
-- solo expone nombre/descripción/precio (nunca datos de otro huésped ni de otro
-- hotel), consistente con REQ-HUE-023 "nunca revelar... a terceros".
create or replace function public.list_experience_catalog_public(_hotel_id uuid)
returns table (id uuid, name text, description text, price numeric)
language sql
security definer
set search_path = public
stable
as $$
  select ec.id, ec.name, ec.description, ec.price
  from public.experience_catalog ec
  where ec.hotel_id = _hotel_id and ec.active = true
  order by ec.name;
$$;

revoke all on function public.list_experience_catalog_public(uuid) from public;
grant execute on function public.list_experience_catalog_public(uuid) to atiende_app, authenticated;

-- order_experience_public(): ver cabecera de este archivo. Nótese la AUSENCIA
-- deliberada de cualquier parámetro de precio/total.
create or replace function public.order_experience_public(
  _confirmation_code text,
  _apellido text,
  _experience_id uuid,
  _quantity integer,
  _client_request_id text default null
)
returns table (order_id uuid, unit_price numeric, total_amount numeric, ya_registrado boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res public.reservation;
  v_res_found boolean;
  v_guest_name text;
  v_exp public.experience_catalog;
  v_existing public.experience_order;
  v_order public.experience_order;
  v_folio_id uuid;
  v_charge_id uuid;
begin
  select r.* into v_res
  from public.reservation r
  where r.confirmation_code = upper(trim(_confirmation_code))
  for update of r;
  v_res_found := found;

  if v_res_found then
    select g.full_name into v_guest_name from public.guest g where g.id = v_res.guest_id;
  end if;

  -- Mismo criterio de "sin fuga" que `cancel_reservation_public` (0013): un solo
  -- mensaje de error genérico, nunca revela si el código o el apellido fue la parte
  -- incorrecta.
  if not v_res_found
     or v_guest_name is null
     or length(trim(coalesce(_apellido, ''))) = 0
     or position(lower(trim(_apellido)) in lower(v_guest_name)) = 0 then
    raise exception 'pedido_no_verificado: código de reserva o apellido no coinciden'
      using errcode = 'P0001';
  end if;

  if v_res.status not in ('confirmada', 'check_in', 'en_estancia') then
    raise exception 'reserva_no_activa: la reserva % no admite pedidos en estado %',
      v_res.id, v_res.status
      using errcode = 'P0001';
  end if;

  if _quantity is null or _quantity < 1 or _quantity > 20 then
    raise exception 'cantidad_invalida: la cantidad debe ser entre 1 y 20' using errcode = 'P0001';
  end if;

  if _client_request_id is not null then
    select * into v_existing from public.experience_order
    where reservation_id = v_res.id and client_request_id = _client_request_id;
    if found then
      return query select v_existing.id, v_existing.unit_price, v_existing.total_amount, true;
      return;
    end if;
  end if;

  select * into v_exp from public.experience_catalog
  where id = _experience_id and hotel_id = v_res.hotel_id and active = true;
  if not found then
    raise exception 'experiencia_no_disponible: la experiencia solicitada no existe o no está activa para este hotel'
      using errcode = 'P0001';
  end if;

  -- El monto SIEMPRE sale de `v_exp.price` (leído arriba del catálogo del servidor),
  -- nunca de un parámetro de esta función -- no hay ninguno para precio/total.
  insert into public.experience_order
    (tenant_id, hotel_id, reservation_id, experience_id, quantity, unit_price, total_amount, client_request_id)
  values
    (v_res.tenant_id, v_res.hotel_id, v_res.id, v_exp.id, _quantity, v_exp.price, round(v_exp.price * _quantity, 2), _client_request_id)
  on conflict (reservation_id, client_request_id) where client_request_id is not null do nothing
  returning * into v_order;

  if v_order.id is null then
    -- Carrera resuelta por el índice único: otra sesión ganó el mismo
    -- (reservation_id, client_request_id) entre nuestro SELECT y este INSERT.
    select * into v_order from public.experience_order
    where reservation_id = v_res.id and client_request_id = _client_request_id;
    return query select v_order.id, v_order.unit_price, v_order.total_amount, true;
    return;
  end if;

  select f.id into v_folio_id from public.folio f
  where f.reservation_id = v_res.id and f.is_primary
  limit 1;

  if v_folio_id is not null then
    insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept)
    values (v_res.tenant_id, v_res.hotel_id, v_folio_id,
            'Experiencia: ' || v_exp.name || ' x' || _quantity, v_order.total_amount, 0, 'extras')
    returning id into v_charge_id;
    update public.experience_order set folio_charge_id = v_charge_id where id = v_order.id;
  end if;

  perform public.record_audit_log(
    v_res.tenant_id, v_res.hotel_id, 'experience_order.created', 'experience_order', v_order.id,
    jsonb_build_object('reservationId', v_res.id, 'experienceId', v_exp.id, 'quantity', _quantity, 'totalAmount', v_order.total_amount)
  );

  return query select v_order.id, v_order.unit_price, v_order.total_amount, false;
end;
$$;

revoke all on function public.order_experience_public(text, text, uuid, integer, text) from public;
grant execute on function public.order_experience_public(text, text, uuid, integer, text) to atiende_app, authenticated;

-- ==== 0051_identity_vault.sql ====
-- REQ-REC-011/REQ-SEG-014/REQ-SEG-004 · Bóveda de identidad aislada:
--   - `identity_vault`: datos sensibles del documento (número cifrado en reposo --
--     cifrado en CÓDIGO DE APLICACIÓN con AES-256-GCM, ver
--     apps/api/src/lib/identityEncryption.ts; esta tabla nunca ve el texto plano, solo
--     bytes opacos de ciphertext/iv/authTag). RLS habilitada SIN ningún GRANT a
--     `authenticated`: una consulta directa desde cualquier módulo de negocio con una
--     sesión de staff normal es rechazada con "permission denied", nunca con "0 filas"
--     (más fuerte y menos ambiguo que depender solo de una policy vacía). El ÚNICO
--     acceso posible es a través de las dos funciones SECURITY DEFINER de abajo.
--   - `identity_ref`: el subconjunto MÍNIMO que el resto del sistema puede ver (nombre,
--     nacionalidad, tipo de documento, últimos 4 dígitos) -- REQ-REC-011: "exponiendo
--     al resto del sistema solo nombre, nacionalidad, tipo y últimos 4 dígitos del
--     documento". SÍ tiene SELECT para `authenticated` (rol acotado, ver policy).
--
-- Nunca se persiste la imagen del documento en ningún punto (REQ-REC-011 "borrar la
-- imagen ... tras extraer los campos"): esta migración no tiene NINGUNA columna para
-- bytes de imagen -- estructuralmente no hay dónde guardarla aunque alguien lo
-- intentara desde apps/api.
--
-- Expand-only sobre migraciones ya mergeadas (REQ-GOB-010): tablas nuevas.

create table public.identity_vault (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  document_number_ciphertext bytea not null,
  document_number_iv bytea not null,
  document_number_auth_tag bytea not null,
  created_at timestamptz not null default now(),
  -- Reloj de retención (REQ-SEG-004 "≤30 días post-checkout"): arranca al checkout,
  -- NULL mientras el huésped sigue en casa (nunca se purga a alguien in-house).
  checkout_at timestamptz,
  retention_days integer not null default 30 check (retention_days > 0)
);
create index identity_vault_tenant_hotel_idx on public.identity_vault (tenant_id, hotel_id);
create index identity_vault_reservation_idx on public.identity_vault (reservation_id);
-- Índice para el job de purga (REQ-SEG-004): filas con checkout_at ya fijado (la purga
-- es un DELETE físico real -- ver apps/api/src/jobs/purgeIdentityVault.ts -- no hay
-- marca de "purgado" que mantener: la fila deja de existir).
create index identity_vault_checkout_idx on public.identity_vault (checkout_at) where checkout_at is not null;

alter table public.identity_vault enable row level security;
-- Deliberadamente SIN ninguna policy ni GRANT a `authenticated`: ver cabecera.

create table public.identity_ref (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  vault_id uuid not null references public.identity_vault(id) on delete cascade,
  full_name text not null,
  nationality text not null,
  document_type text not null check (document_type in ('pasaporte', 'ine', 'otro')),
  document_last4 text not null check (document_last4 ~ '^[A-Za-z0-9]{4}$'),
  created_at timestamptz not null default now()
);
create unique index identity_ref_vault_idx on public.identity_ref (vault_id);
create index identity_ref_tenant_hotel_idx on public.identity_ref (tenant_id, hotel_id);
create index identity_ref_reservation_idx on public.identity_ref (reservation_id);

alter table public.identity_ref enable row level security;
-- Lectura: mismo criterio que MANAGE_RESERVATIONS_ROLES de apps/api/src/domain/roles.ts
-- (owner/gm/frontdesk/reservations -- quienes procesan check-in/identidad del
-- huésped). housekeeping/maintenance/fnb nunca necesitan ver esto.
create policy "identity_ref_tenant_select" on public.identity_ref for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
grant select on public.identity_ref to authenticated;
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- `register_identity_document` (SECURITY DEFINER, abajo).

-- register_identity_document(): único punto de escritura de la bóveda. El número de
-- documento YA llega cifrado (apps/api ya corrió parsePassportMrz + AES-256-GCM antes
-- de llamar aquí) -- esta función NUNCA ve texto plano, solo bytes opacos.
create or replace function public.register_identity_document(
  _tenant_id uuid,
  _hotel_id uuid,
  _reservation_id uuid,
  _full_name text,
  _nationality text,
  _document_type text,
  _document_last4 text,
  _document_number_ciphertext bytea,
  _document_number_iv bytea,
  _document_number_auth_tag bytea,
  _retention_days integer default 30
)
returns public.identity_ref
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_vault_id uuid;
  v_ref public.identity_ref;
begin
  v_actor := auth.uid();

  -- Mismo criterio que record_audit_log (migración 0016): valida membresía real del
  -- actor SOLO cuando existe una sesión real -- una llamada admin/CLI (seed, job de
  -- purga, tests) sigue funcionando igual, ya es código de plataforma de confianza.
  if v_actor is not null then
    if not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (register_identity_document)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if not (_hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (register_identity_document)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
    if not has_hotel_role(_hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]) then
      raise exception 'rol_no_autorizado: el actor % no tiene un rol autorizado para registrar identidad en el hotel %', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  if _document_type not in ('pasaporte', 'ine', 'otro') then
    raise exception 'tipo_documento_invalido: "%" no es pasaporte/ine/otro', _document_type using errcode = 'P0001';
  end if;
  if _document_last4 !~ '^[A-Za-z0-9]{4}$' then
    raise exception 'ultimos4_invalidos: debe ser exactamente 4 caracteres alfanuméricos' using errcode = 'P0001';
  end if;

  insert into public.identity_vault (tenant_id, hotel_id, reservation_id, document_number_ciphertext, document_number_iv, document_number_auth_tag, retention_days)
  values (_tenant_id, _hotel_id, _reservation_id, _document_number_ciphertext, _document_number_iv, _document_number_auth_tag, _retention_days)
  returning id into v_vault_id;

  insert into public.identity_ref (tenant_id, hotel_id, reservation_id, vault_id, full_name, nationality, document_type, document_last4)
  values (_tenant_id, _hotel_id, _reservation_id, v_vault_id, _full_name, _nationality, _document_type, _document_last4)
  returning * into v_ref;

  perform public.record_audit_log(_tenant_id, _hotel_id, 'identity_vault.registered', 'identity_ref', v_ref.id,
    jsonb_build_object('reservationId', _reservation_id, 'documentType', _document_type));

  return v_ref;
end;
$$;

revoke all on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer) from public;
grant execute on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer) to atiende_app, authenticated;

-- read_identity_vault_document(): ÚNICO punto de lectura de los bytes cifrados.
-- Restringido a owner/gm (decisión de alcance de este pase: el "doble control" pleno
-- de REQ-SEG-014 -- dos personas distintas aprobando la misma lectura -- NO está
-- implementado todavía; lo que SÍ se garantiza aquí es acceso restringido por rol +
-- bitácora inmutable de cada lectura vía `record_audit_log`/`audit_log`, que ya es
-- append-only con cadena de hash verificable, migraciones 0008/0012/0015/0016).
create or replace function public.read_identity_vault_document(
  _identity_ref_id uuid,
  _reason text
)
returns table (document_number_ciphertext bytea, document_number_iv bytea, document_number_auth_tag bytea)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_ref public.identity_ref;
  v_vault public.identity_vault;
begin
  if _reason is null or length(trim(_reason)) = 0 then
    raise exception 'motivo_requerido: toda lectura de la bóveda de identidad debe documentar un motivo (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  select * into v_ref from public.identity_ref where id = _identity_ref_id;
  if not found then
    raise exception 'identity_ref_no_encontrado: %', _identity_ref_id using errcode = 'P0001';
  end if;

  v_actor := auth.uid();
  if v_actor is not null and not has_hotel_role(v_ref.hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'acceso_boveda_no_autorizado: el actor % no tiene rol owner/gm en el hotel % (REQ-SEG-014)', v_actor, v_ref.hotel_id
      using errcode = '42501';
  end if;

  select * into v_vault from public.identity_vault where id = v_ref.vault_id;

  -- Bitácora inmutable de CADA lectura (REQ-SEG-014 "acceso auditado por rol") --
  -- nunca se omite, incluso si la lectura es legítima.
  perform public.record_audit_log(v_ref.tenant_id, v_ref.hotel_id, 'identity_vault.decrypted', 'identity_ref', v_ref.id,
    jsonb_build_object('reason', _reason));

  return query select v_vault.document_number_ciphertext, v_vault.document_number_iv, v_vault.document_number_auth_tag;
end;
$$;

revoke all on function public.read_identity_vault_document(uuid, text) from public;
grant execute on function public.read_identity_vault_document(uuid, text) to atiende_app, authenticated;

-- set_identity_checkout(): arranca el reloj de retención al checkout (REQ-SEG-004).
-- Se llama desde el mismo flujo que ya transiciona la reserva a `check_out`
-- (routes/reservas.ts) -- edición mínima ahí, ver apps/api.
create or replace function public.set_identity_checkout(_reservation_id uuid, _checkout_at timestamptz default now())
returns integer
language sql
security definer
set search_path = public
as $$
  update public.identity_vault
  set checkout_at = _checkout_at
  where reservation_id = _reservation_id and checkout_at is null;
  select count(*)::integer from public.identity_vault where reservation_id = _reservation_id and checkout_at is not null;
$$;

revoke all on function public.set_identity_checkout(uuid, timestamptz) from public;
grant execute on function public.set_identity_checkout(uuid, timestamptz) to atiende_app, authenticated;

-- ==== 0052_local_knowledge.sql ====
-- REQ-UX-005/REQ-HUE-026 (H08-024): "El sistema debe mantener un panel de
-- 'conocimiento local' (sargazo, clima, cierres de playa, horarios de ferry, eventos)
-- editable por el gerente y reflejado en las respuestas del agente conversacional en
-- <30 s." El agente conversacional de WhatsApp/voz aún no existe en este repo
-- (requiere credenciales reales de Meta/Telnyx, ver docs/cierre-p0/inventario.md §2) --
-- esta migración construye la parte real y verificable sin esa dependencia: la FUENTE
-- DE DATOS real (esta tabla) con lectura inmediata (sin caché) tras cada escritura, que
-- es exactamente lo que un agente consultaría en vivo el día que exista.
--
-- Expand-only (REQ-GOB-010): tabla nueva.

create table public.local_knowledge_entry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  category text not null check (category in ('sargazo', 'clima', 'playa', 'ferry', 'eventos', 'otro')),
  title text not null,
  content text not null,
  updated_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index local_knowledge_entry_tenant_hotel_idx on public.local_knowledge_entry (tenant_id, hotel_id);
create index local_knowledge_entry_category_idx on public.local_knowledge_entry (hotel_id, category);

alter table public.local_knowledge_entry enable row level security;

-- Lectura: cualquier staff del hotel (housekeeping/mantenimiento también consultan
-- "cierres de playa"/"eventos" al atender huéspedes, no es exclusivo de gerencia).
create policy "local_knowledge_entry_tenant_select" on public.local_knowledge_entry for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));

-- Escritura: "panel del GERENTE" (REQ-UX-005) -- owner/gm/frontdesk (frontdesk suele
-- ser quien primero se entera de un cierre de playa/cambio de horario de ferry en el
-- día a día, mismo criterio que MANAGE_RESERVATIONS_ROLES de apps/api).
create policy "local_knowledge_entry_tenant_insert" on public.local_knowledge_entry for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
  );
create policy "local_knowledge_entry_tenant_update" on public.local_knowledge_entry for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]));
create policy "local_knowledge_entry_tenant_delete" on public.local_knowledge_entry for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]));

grant select, insert, update, delete on public.local_knowledge_entry to authenticated;

-- ==== 0053_staff_whatsapp_phone.sql ====
-- REQ-UX-006 (H09-026/BP-010): "Las aprobaciones operativas del gerente (reembolso
-- sobre umbral, upgrade gratuito, compra urgente, respuesta a reseña negativa) deben
-- poder ejecutarse mediante botón directamente en el mensaje de WhatsApp, sin
-- requerir acceso al panel web." Para resolver QUIÉN aprobó desde un webhook de
-- WhatsApp (que no trae un JWT de sesión), se necesita poder mapear el número de
-- WhatsApp remitente a un `staff_user` real -- exactamente el mismo actor/rol que ya
-- usa el endpoint autenticado del panel web (apps/api/src/lib/aprobacionEjecutor.ts).
--
-- Formato E.164 (+ seguido de 8-15 dígitos) -- mismo estándar que usa
-- `SendTemplateMessageInput.to`/`SendTextMessageInput.to` en
-- packages/mcp-servers/whatsapp/src/port.ts. Nullable y único: no todo staff tiene
-- (o necesita) aprobar por WhatsApp.
alter table public.staff_user add column whatsapp_phone text;
alter table public.staff_user add constraint staff_user_whatsapp_phone_unique unique (whatsapp_phone);
alter table public.staff_user add constraint staff_user_whatsapp_phone_formato check (whatsapp_phone is null or whatsapp_phone ~ '^\+[0-9]{8,15}$');

-- Autoservicio: cada staff puede registrar/actualizar SU PROPIO número de WhatsApp
-- (apps/api/src/routes/auth.ts, PATCH /auth/me/whatsapp) -- nunca el de otro. GRANT a
-- nivel de COLUMNA (no toda la fila): `authenticated` sigue sin poder tocar
-- `email`/`full_name`/`password_hash` por este camino, incluso siendo su propia fila
-- (0010 ya solo concede SELECT sobre staff_user; esto añade UPDATE acotado a una sola
-- columna, la policy de abajo restringe además a la fila propia).
grant update (whatsapp_phone) on public.staff_user to authenticated;
create policy "staff_user_self_update_whatsapp" on public.staff_user for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ==== 0054_checkin_online.sql ====
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

-- ==== 0060_reservation_guest_id_fk_compuesta.sql ====
-- auditoria-2/seguridad [ALTO] + auditoria-2/datos [CRITICO, reproducido por API real]:
-- "reservation.guest_id no esta scoped a hotel_id: una reserva puede referenciar al
-- huesped de otro hotel" -- MISMA clase de defecto que D-C1 (room_type_id, cerrado en
-- 0018), nunca generalizada a `guest_id`. Reproducido con sesion RLS real (gm de un
-- hotel, sin rol en un segundo hotel del seed): `POST /hoteles/:hotelId/reservas` con
-- `guestId` de un guest ajeno respondia 201 y la fila quedaba con
-- `hotel_id=hotelPropio, guest_id=<guest de otro hotel>` -- ni la policy de INSERT de
-- `reservation` (solo mira tenant_id/hotel_id/rol del actor) ni ninguna FK lo impedian.
-- Es ademas la causa raiz que habilita el CRITICO de checkin_link (0061): sin este
-- vacio, una reserva de Hotel A jamas podria resolver a un guest de Hotel B.
--
-- Arreglo: mismo patron que 0018 -- FK COMPUESTA (hotel_id, guest_id) references
-- guest(hotel_id, id), impuesta por el ESQUEMA (ninguna sesion, ni siquiera el cliente
-- admin, puede insertar la combinacion cruzada). `guest_id` sigue siendo NULLABLE
-- (MATCH SIMPLE no exige la FK cuando cualquier columna referenciante es NULL) y se
-- conserva el mismo `ON DELETE SET NULL` de la FK simple original -- pero limitado a
-- la columna `guest_id` via la sintaxis `ON DELETE SET NULL (guest_id)` (Postgres 15+,
-- este esquema corre sobre Postgres 18 via embedded-postgres) para que borrar un guest
-- NUNCA intente poner en NULL `reservation.hotel_id` (columna NOT NULL: eso haria
-- fallar el borrado en vez de solo desvincular el guest, cambiando el comportamiento
-- ya establecido).
alter table public.guest
  add constraint guest_hotel_id_id_key unique (hotel_id, id);

alter table public.reservation
  add constraint reservation_guest_hotel_fk
  foreign key (hotel_id, guest_id) references public.guest (hotel_id, id)
  on delete set null (guest_id);

create index reservation_hotel_guest_idx on public.reservation (hotel_id, guest_id);

-- ==== 0061_checkin_link_hotel_fk_y_boveda_usa_reserva.sql ====
-- auditoria-2/seguridad [CRITICO] + auditoria-2/datos [CRITICO, reproducido de punta a
-- punta por API real, embedded-postgres]: "El check-in online cruza de hotel: el
-- documento de identidad de un huesped de Hotel B termina en la boveda de Hotel A".
-- `checkin_link.reservation_id` era una FK SIMPLE a `reservation(id)` -- nada impedia
-- `POST /hoteles/{hotelA}/reservas/{reservationIdDeHotelB}/checkin-link`: la policy de
-- INSERT (0054) solo valida que el actor tenga rol de negocio en `:hotelId` (Hotel A),
-- nunca que `:reservationId` pertenezca a ese hotel. Al completarse el enlace,
-- `complete_checkin_public()` sobrescribia el `guest` REAL de Hotel B y archivaba su
-- documento de identidad en la boveda de HOTEL A. Reproducido por auditoria-2/datos con
-- la app Hono real: 201 en ambos pasos, `guest.full_name` de Hotel B quedo sobrescrito.
--
-- Arreglo (mismo patron que D-C1/0018 y 0060): FK COMPUESTA
-- (hotel_id, reservation_id) references reservation(hotel_id, id) sobre `checkin_link`
-- -- el INSERT de arriba ahora es RECHAZADO por el esquema mismo (ninguna sesion, ni
-- siquiera el cliente admin, puede insertar `hotel_id=hotelA` con una `reservation_id`
-- cuyo `hotel_id` real es distinto), sin depender de que la ruta lo valide primero.
--
-- Defensa en profundidad adicional: `complete_checkin_public()` ya NO usa
-- `v_link.hotel_id`/`v_link.tenant_id` (el hotel/org que EMITIO el enlace) para
-- archivar el documento de identidad ni para el audit_log -- usa `v_res.hotel_id`/
-- `v_res.tenant_id` (el hotel/org REAL de la reserva). Con la FK compuesta de arriba
-- ambos valores siempre coinciden hoy, pero esto evita que un futuro cambio de esquema
-- que debilite la FK (o un `ON DELETE`/migracion de datos) reabra la fuga en silencio
-- -- "la boveda escribe con el hotel de la reserva, nunca del enlace/cliente".
alter table public.reservation
  add constraint reservation_hotel_id_id_key unique (hotel_id, id);

alter table public.checkin_link
  add constraint checkin_link_reservation_hotel_fk
  foreign key (hotel_id, reservation_id) references public.reservation (hotel_id, id) on delete cascade;

create index checkin_link_hotel_reservation_idx on public.checkin_link (hotel_id, reservation_id);

-- El RETURNS TABLE gana dos columnas (hotel_id, tenant_id) -- Postgres no permite
-- CREATE OR REPLACE cuando cambia el tipo de retorno de una funcion existente, hay que
-- DROP primero (mismo cuerpo/permisos se re-crean acto seguido, ninguna migracion ya
-- aplicada se edita: esta migracion es nueva).
drop function if exists public.complete_checkin_public(text, text, text, text, timestamptz, text, text, text, text, text, bytea, bytea, bytea);

create function public.complete_checkin_public(
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
returns table (submission_id uuid, reservation_id uuid, hotel_id uuid, tenant_id uuid)
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
    raise exception 'checkin_link_expirado: este enlace de check-in ya vencio' using errcode = 'P0001';
  end if;

  if _signature_data_url is null or length(trim(_signature_data_url)) = 0 then
    raise exception 'firma_requerida: la firma de registro es obligatoria' using errcode = 'P0001';
  end if;

  select * into v_res from public.reservation where id = v_link.reservation_id;
  if not found then
    raise exception 'reserva_no_encontrada: la reserva del enlace de check-in ya no existe' using errcode = 'P0001';
  end if;

  -- Alias explicito `g` para evitar ambiguedad plpgsql: `hotel_id` es tambien una
  -- columna del RETURNS TABLE de esta funcion (declarada implicitamente como variable
  -- de salida) -- sin alias, "hotel_id" a secas en el WHERE es ambiguo entre esa
  -- variable y la columna de `guest` (errcode 42702, confirmado en pruebas).
  update public.guest g
  set full_name = coalesce(nullif(trim(_full_name), ''), g.full_name),
      email = coalesce(nullif(trim(_email), ''), g.email),
      phone = coalesce(nullif(trim(_phone), ''), g.phone)
  where g.id = v_res.guest_id and g.hotel_id = v_res.hotel_id;

  -- Usa SIEMPRE el hotel/org de la RESERVA (v_res), nunca los del enlace (v_link) --
  -- ver cabecera de esta migracion. Con la FK compuesta de arriba ambos ya coinciden
  -- estructuralmente, esto es defensa en profundidad.
  select r.id into v_identity_ref_id
  from public.register_identity_document(
    v_res.tenant_id, v_res.hotel_id, v_res.id, _full_name, _nationality, _document_type, _document_last4,
    _document_number_ciphertext, _document_number_iv, _document_number_auth_tag, 30
  ) r;

  update public.guest g
  set identity_ref = v_identity_ref_id, document_type = _document_type, document_last4 = _document_last4
  where g.id = v_res.guest_id and g.hotel_id = v_res.hotel_id;

  insert into public.checkin_submission
    (tenant_id, hotel_id, reservation_id, checkin_link_id, eta_estimada, rfc, signature_data_url, identity_ref_id)
  values
    (v_res.tenant_id, v_res.hotel_id, v_res.id, v_link.id, _eta_estimada, _rfc, _signature_data_url, v_identity_ref_id)
  returning id into v_submission_id;

  update public.checkin_link set status = 'completado', completed_at = now() where id = v_link.id;

  perform public.record_audit_log(v_res.tenant_id, v_res.hotel_id, 'checkin_online.completed', 'checkin_link', v_link.id,
    jsonb_build_object('reservationId', v_res.id, 'submissionId', v_submission_id));

  return query select v_submission_id, v_res.id, v_res.hotel_id, v_res.tenant_id;
end;
$$;

revoke all on function public.complete_checkin_public(text, text, text, text, timestamptz, text, text, text, text, text, bytea, bytea, bytea) from public;
grant execute on function public.complete_checkin_public(text, text, text, text, timestamptz, text, text, text, text, text, bytea, bytea, bytea) to atiende_app, authenticated;

-- ==== 0062_mark_charge_reversed_valida_actor.sql ====
-- auditoria-2/seguridad [CRITICO]: "mark_charge_reversed() (SECURITY DEFINER) no
-- valida que el actor pertenezca al hotel del cargo: cualquier staff autenticado
-- reversa un cargo de cualquier hotel". La funcion (0030) solo comprobaba que el cargo
-- existiera y no estuviera ya reversado -- ni `current_tenant_ids()` ni
-- `can_access_money()` se evaluaban, pese a que la propia migracion admitia
-- explicitamente "la autorizacion real ya ocurrio en la capa de aplicacion" (mismo
-- patron que `record_audit_log` ANTES de 0016).
--
-- Arreglo: mismo criterio que 0016/0051 -- valida `tenant_id`/`can_access_money(hotel)`
-- del CARGO REAL (nunca de un parametro que el llamador podria inventar) contra la
-- membresia del actor SOLO cuando existe una sesion real (`auth.uid()` no nulo); una
-- llamada admin/CLI/seed sigue funcionando igual.
create or replace function public.mark_charge_reversed(_charge_id uuid, _reversal_charge_id uuid)
returns public.charge
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.charge;
  v_charge public.charge;
  v_actor uuid;
begin
  select * into v_charge from public.charge where id = _charge_id;
  if not found then
    raise exception 'reverso_invalido: el cargo % no existe o ya fue reversado', _charge_id
      using errcode = 'P0001';
  end if;

  v_actor := auth.uid();
  if v_actor is not null then
    if not (v_charge.tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion del cargo % (mark_charge_reversed)', v_actor, _charge_id
        using errcode = '42501';
    end if;
    if not can_access_money(v_charge.hotel_id) then
      raise exception 'hotel_no_autorizado: el actor % no tiene acceso a dinero en el hotel del cargo % (mark_charge_reversed)', v_actor, _charge_id
        using errcode = '42501';
    end if;
  end if;

  update public.charge
  set reversed_by = _reversal_charge_id
  where id = _charge_id and reversed_by is null
  returning * into v_row;

  if not found then
    raise exception 'reverso_invalido: el cargo % no existe o ya fue reversado', _charge_id
      using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.mark_charge_reversed(uuid, uuid) from public;
grant execute on function public.mark_charge_reversed(uuid, uuid) to atiende_app, authenticated;

-- ==== 0063_night_audit_valida_actor_y_no_reabre.sql ====
-- auditoria-2/seguridad [CRITICO]: "night_audit_claim()/night_audit_finish()
-- (SECURITY DEFINER) filtran y permiten falsificar el cierre de caja de cualquier
-- hotel". Ninguna de las dos funciones (0031) comparaba `_tenant_id`/`_hotel_id`/
-- `_run_id` contra la membresia real del actor, y `night_audit_finish` podia
-- re-terminar una corrida YA `completado` (de cualquier hotel), reemplazando su
-- `summary` -- sin guarda de estado ni de propiedad.
--
-- Arreglo:
--   1. `night_audit_claim`: valida `tenant_id`/`can_access_money(hotel_id)` del actor
--      real ANTES de tomar el advisory lock -- ningun rol sin acceso a dinero de OTRO
--      hotel puede ya ni reclamar ni leer el resumen financiero de una corrida ajena.
--   2. `night_audit_finish`: resuelve primero la corrida real (`v_run`), valida
--      `tenant_id`/`can_access_money(hotel_id)` de ESA corrida (nunca de un parametro
--      libre, la funcion no recibe hotel/tenant como argumento) contra el actor real, y
--      AGREGA la guarda que faltaba (`where status = 'en_progreso'`) para que una
--      corrida ya `completado` nunca pueda reemplazarse -- ni siquiera por un actor
--      legitimo del mismo hotel.
create or replace function public.night_audit_claim(
  _tenant_id uuid,
  _hotel_id uuid,
  _business_date date
)
returns table (run_id uuid, already_completed boolean, summary jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.night_audit_run;
  v_actor uuid;
begin
  v_actor := auth.uid();
  if v_actor is not null then
    if _tenant_id is null or not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (night_audit_claim)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if _hotel_id is null or not can_access_money(_hotel_id) then
      raise exception 'hotel_no_autorizado: el actor % no tiene acceso a dinero en el hotel % (night_audit_claim)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('night_audit:' || _hotel_id::text || ':' || _business_date::text));

  insert into public.night_audit_run (tenant_id, hotel_id, business_date, status)
  values (_tenant_id, _hotel_id, _business_date, 'en_progreso')
  on conflict (hotel_id, business_date) do nothing
  returning * into v_row;

  if found then
    return query select v_row.id, false, v_row.summary;
    return;
  end if;

  select * into v_row from public.night_audit_run
  where hotel_id = _hotel_id and business_date = _business_date;

  return query select v_row.id, (v_row.status = 'completado'), v_row.summary;
end;
$$;

revoke all on function public.night_audit_claim(uuid, uuid, date) from public;
grant execute on function public.night_audit_claim(uuid, uuid, date) to atiende_app, authenticated;

create or replace function public.night_audit_finish(_run_id uuid, _summary jsonb)
returns public.night_audit_run
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.night_audit_run;
  v_run public.night_audit_run;
  v_actor uuid;
begin
  select * into v_run from public.night_audit_run where id = _run_id;
  if not found then
    raise exception 'night_audit_run_no_encontrado: %', _run_id using errcode = 'P0001';
  end if;

  v_actor := auth.uid();
  if v_actor is not null then
    if not (v_run.tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion de la corrida % (night_audit_finish)', v_actor, _run_id
        using errcode = '42501';
    end if;
    if not can_access_money(v_run.hotel_id) then
      raise exception 'hotel_no_autorizado: el actor % no tiene acceso a dinero en el hotel de la corrida % (night_audit_finish)', v_actor, _run_id
        using errcode = '42501';
    end if;
  end if;

  if v_run.status = 'completado' then
    raise exception 'night_audit_run_ya_completado: la corrida % ya fue cerrada, no puede re-terminarse ni reemplazar su resumen', _run_id
      using errcode = 'P0001';
  end if;

  update public.night_audit_run
  set status = 'completado', summary = _summary, completed_at = now()
  where id = _run_id and status = 'en_progreso'
  returning * into v_row;

  if not found then
    raise exception 'night_audit_run_no_encontrado: %', _run_id using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.night_audit_finish(uuid, jsonb) from public;
grant execute on function public.night_audit_finish(uuid, jsonb) to atiende_app, authenticated;

-- ==== 0064_sat_filing_approval_fk_compuesta.sql ====
-- auditoria-2/seguridad [CRITICO]: "sat_filing_approval no valida que su
-- hotel_id/tenant_id correspondan a la fiscal_obligation que aprueba: la aprobacion
-- humana exigida por e.firma se puede forjar desde cualquier hotel". Escenario real
-- (ADR-004, multi-propiedad): un `owner` de Hotel C (sin relacion con Hotel B) inserta
-- una fila de `sat_filing_approval` con `hotel_id=HotelC` (pasa su propia policy de
-- INSERT, que solo mira el `hotel_id` que la fila declara) pero `obligation_id`
-- apuntando a una obligacion REAL de Hotel B; si esa misma persona tiene tambien rol de
-- `accountant` en Hotel B, el trigger `fiscal_obligation_requires_approval` (0033) solo
-- comprueba EXISTENCIA de alguna fila para ese `obligation_id`, sin comparar su
-- hotel_id/tenant_id -- la presentacion de Hotel B queda marcada 'presentada' sin que
-- ningun owner/gm de Hotel B la haya autorizado. (auditoria-2/datos evaluo el mismo
-- vector con actores DISTINTOS sin membresia cruzada y lo encontro inofensivo porque el
-- trigger no es SECURITY DEFINER -- pero la RLS de seleccion de `sat_filing_approval`
-- se evalua contra TODA la membresia del actor, no contra "el hotel que esta operando
-- ahora", asi que un actor con doble membresia real (Hotel B + Hotel C) SI ve su propia
-- fila fabricada de Hotel C al evaluar el trigger desde su sesion de Hotel B.)
--
-- Arreglo: mismo patron que 0018/0060/0061 -- FK COMPUESTA
-- (hotel_id, obligation_id) references fiscal_obligation(hotel_id, id), impuesta por
-- el ESQUEMA. Con esto, `sat_filing_approval.hotel_id` SIEMPRE debe coincidir con el
-- `hotel_id` real de la obligacion que aprueba -- el INSERT cruzado de arriba ahora es
-- estructuralmente imposible (no existe ninguna fiscal_obligation con
-- hotel_id=HotelC e id=<obligacion de Hotel B>), sin depender de que el trigger de
-- defensa en profundidad sea o deje de ser SECURITY DEFINER en el futuro.
alter table public.fiscal_obligation
  add constraint fiscal_obligation_hotel_id_id_key unique (hotel_id, id);

alter table public.sat_filing_approval
  add constraint sat_filing_approval_obligation_hotel_fk
  foreign key (hotel_id, obligation_id) references public.fiscal_obligation (hotel_id, id) on delete cascade;

create index sat_filing_approval_hotel_obligation_idx on public.sat_filing_approval (hotel_id, obligation_id);

-- ==== 0065_set_identity_checkout_valida_actor.sql ====
-- auditoria-2/seguridad [ALTO]: "set_identity_checkout() (SECURITY DEFINER) permite
-- alterar el reloj de retencion de la boveda de identidad de otro hotel". A diferencia
-- de `register_identity_document`/`read_identity_vault_document` (mismo archivo 0051),
-- esta funcion no validaba nada: cualquier `authenticated` podia adelantar el
-- `checkout_at` de la reserva de OTRO hotel, haciendo que el job de purga borre
-- fisicamente un documento de identidad antes de tiempo, sin que el hotel dueno lo
-- autorice ni se entere (y sin rastro: la funcion no dejaba audit_log).
--
-- Arreglo: mismo criterio que 0016/0051/0062/0063 -- resuelve la reserva REAL primero
-- y valida `tenant_id`/`hotel_id` del actor contra ELLA (nunca contra un parametro
-- libre) cuando existe una sesion real; agrega ademas `record_audit_log` (antes no
-- dejaba ningun rastro de quien adelanto el reloj de retencion, ni siquiera en el uso
-- legitimo).
create or replace function public.set_identity_checkout(_reservation_id uuid, _checkout_at timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_res public.reservation;
  v_count integer;
begin
  select * into v_res from public.reservation where id = _reservation_id;
  if not found then
    raise exception 'reserva_no_encontrada: %', _reservation_id using errcode = 'P0001';
  end if;

  v_actor := auth.uid();
  if v_actor is not null then
    if not (v_res.tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion de la reserva % (set_identity_checkout)', v_actor, _reservation_id
        using errcode = '42501';
    end if;
    if not (v_res.hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel de la reserva % (set_identity_checkout)', v_actor, _reservation_id
        using errcode = '42501';
    end if;
  end if;

  update public.identity_vault
  set checkout_at = _checkout_at
  where reservation_id = _reservation_id and checkout_at is null;

  select count(*)::integer into v_count
  from public.identity_vault
  where reservation_id = _reservation_id and checkout_at is not null;

  if v_count > 0 then
    perform public.record_audit_log(v_res.tenant_id, v_res.hotel_id, 'identity_vault.checkout_set', 'reservation', v_res.id,
      jsonb_build_object('checkoutAt', _checkout_at));
  end if;

  return v_count;
end;
$$;

revoke all on function public.set_identity_checkout(uuid, timestamptz) from public;
grant execute on function public.set_identity_checkout(uuid, timestamptz) to atiende_app, authenticated;

-- ==== 0066_folio_cierre_race_lock.sql ====
-- auditoria-2/datos [CRITICO, reproducido 10/10 veces contra embedded-postgres real]:
-- "Un folio se puede cerrar como saldo_cero mientras un cargo nuevo entra por otra
-- peticion: la base no impide escribir charge en un folio cerrado". `POST .../cargos` y
-- `POST .../cerrar` (apps/api/src/routes/folios.ts) cada uno hace "leer estado ->
-- decidir -> escribir" en pasos separados, sin lock -- disparados en paralelo
-- (Promise.all) sobre el mismo folio recien creado en $0, las 10/10 veces ambas
-- peticiones tuvieron exito y el folio quedaba 'cerrado' con un cargo real sin cobrar
-- dentro. Ninguna policy RLS de `charge` mira `folio.status`.
--
-- Arreglo, ENTERAMENTE en la base (no se toca apps/api/src/routes/folios.ts, que
-- pertenece a otro lote de correccion en curso):
--   1. Trigger BEFORE INSERT en `charge` que toma un lock de fila real
--      (`select ... for update`) sobre el `folio` padre y rechaza el INSERT si ya esta
--      'cerrado' -- convierte la invariante de negocio ("un folio cerrado no admite
--      cargos") en una restriccion real del esquema, no solo del chequeo de aplicacion
--      que ya existia (folios.ts:239-240) pero que no tenia ningun lock detras.
--   2. Trigger BEFORE UPDATE en `folio` que, cuando la actualizacion cierra el folio
--      como 'saldo_cero', RECALCULA el saldo real (suma de charge.amount+tax_amount
--      menos payment.amount capturado, MISMA formula que
--      apps/api/src/routes/folios.ts:computeBalance) en el momento exacto en que el
--      UPDATE ya tiene el lock de fila del folio (lock implicito de todo UPDATE) y
--      rechaza el cierre si el saldo actual ya no es cero.
--
-- Por que esto cierra la carrera sin importar el orden de llegada: ambos triggers
-- comparten el MISMO recurso de lock (la fila de `folio`). Si el INSERT de charge gana
-- la carrera, el UPDATE de cierre queda bloqueado hasta que el INSERT comprometa (o
-- aborte); al desbloquearse, su trigger BEFORE UPDATE recalcula el saldo YA con el
-- cargo nuevo visible y rechaza el cierre como 'saldo_cero'. Si el UPDATE de cierre
-- gana la carrera, el INSERT de charge queda bloqueado por el `for update` del primer
-- trigger hasta que el cierre comprometa; al desbloquearse, relee `folio.status`
-- (ya 'cerrado') y rechaza el cargo. En ambos ordenes, el resultado final es
-- consistente: nunca queda un folio 'cerrado' con saldo distinto de cero por esta via.
create or replace function public.charge_reject_on_closed_folio()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.folio_status;
begin
  select status into v_status from public.folio where id = new.folio_id for update;
  if not found then
    raise exception 'folio_no_encontrado: el folio % no existe (charge_reject_on_closed_folio)', new.folio_id
      using errcode = 'P0001';
  end if;

  if v_status = 'cerrado' then
    raise exception 'folio_cerrado_no_admite_cargos: el folio % esta cerrado, no admite nuevos cargos', new.folio_id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger charge_reject_on_closed_folio_trg
  before insert on public.charge
  for each row execute function public.charge_reject_on_closed_folio();

create or replace function public.folio_reject_inconsistent_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_charges numeric(14, 2);
  v_total_payments numeric(14, 2);
  v_balance numeric(14, 2);
begin
  if new.status = 'cerrado' and old.status is distinct from 'cerrado' and new.close_reason = 'saldo_cero' then
    select coalesce(sum(amount + tax_amount), 0) into v_total_charges
    from public.charge where folio_id = new.id;

    select coalesce(sum(amount), 0) into v_total_payments
    from public.payment where folio_id = new.id and status = 'capturado';

    v_balance := round(v_total_charges - v_total_payments, 2);

    if abs(v_balance) > 0.01 then
      raise exception 'cierre_balance_invalido: el folio % no tiene saldo cero (saldo actual %), no puede cerrarse como saldo_cero', new.id, v_balance
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger folio_reject_inconsistent_close_trg
  before update of status on public.folio
  for each row execute function public.folio_reject_inconsistent_close();

-- ==== 0067_identity_vault_retencion_extendida_justificada.sql ====
-- auditoria-2/legal [ALTO]: "Cualquier frontdesk puede fijar 365 dias de retencion de
-- un documento de identidad sin justificar el motivo ni dejarlo en la bitacora".
-- `retencionDias` (1..365) se aceptaba de cualquier rol de `MANAGE_RESERVATIONS_ROLES`
-- (incluye frontdesk) sin exigir motivo, y el audit_log de `register_identity_document`
-- nunca guardaba que retencion se eligio. REQ-SEG-004/REQ-REC-011 fijan "<=30 dias
-- post-checkout salvo obligacion distinta" -- la excepcion presupone una obligacion
-- identificable y documentada, no una eleccion libre sin registro del motivo.
--
-- Arreglo (en la base, defensa en profundidad -- la ruta apps/api sigue pudiendo
-- agregar su propio chequeo de rol adicional, pero el esquema ya no depende solo de
-- eso): `register_identity_document()` ahora exige, cuando `_retention_days > 30`, un
-- `_retention_reason` no vacio Y (cuando hay sesion real) que el actor tenga rol
-- owner/gm -- no basta frontdesk/reservations para extender mas alla del default legal.
-- El motivo elegido queda en la nueva columna `identity_vault.retention_reason` y en el
-- payload de `audit_log` de cada registro (antes solo guardaba reservationId/
-- documentType).
alter table public.identity_vault add column retention_reason text;

create or replace function public.register_identity_document(
  _tenant_id uuid,
  _hotel_id uuid,
  _reservation_id uuid,
  _full_name text,
  _nationality text,
  _document_type text,
  _document_last4 text,
  _document_number_ciphertext bytea,
  _document_number_iv bytea,
  _document_number_auth_tag bytea,
  _retention_days integer default 30,
  _retention_reason text default null
)
returns public.identity_ref
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_vault_id uuid;
  v_ref public.identity_ref;
begin
  v_actor := auth.uid();

  if v_actor is not null then
    if not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (register_identity_document)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if not (_hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (register_identity_document)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
    if not has_hotel_role(_hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]) then
      raise exception 'rol_no_autorizado: el actor % no tiene un rol autorizado para registrar identidad en el hotel %', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  if _document_type not in ('pasaporte', 'ine', 'otro') then
    raise exception 'tipo_documento_invalido: "%" no es pasaporte/ine/otro', _document_type using errcode = 'P0001';
  end if;
  if _document_last4 !~ '^[A-Za-z0-9]{4}$' then
    raise exception 'ultimos4_invalidos: debe ser exactamente 4 caracteres alfanumericos' using errcode = 'P0001';
  end if;

  if coalesce(_retention_days, 30) > 30 then
    if _retention_reason is null or length(trim(_retention_reason)) = 0 then
      raise exception 'motivo_retencion_requerido: una retencion mayor a 30 dias exige justificar el motivo (REQ-SEG-004)'
        using errcode = 'P0001';
    end if;
    if v_actor is not null and not has_hotel_role(_hotel_id, array['owner', 'gm']::public.hotel_role[]) then
      raise exception 'rol_no_autorizado: extender la retencion mas alla de 30 dias requiere rol owner/gm en el hotel %', _hotel_id
        using errcode = '42501';
    end if;
  end if;

  insert into public.identity_vault (tenant_id, hotel_id, reservation_id, document_number_ciphertext, document_number_iv, document_number_auth_tag, retention_days, retention_reason)
  values (_tenant_id, _hotel_id, _reservation_id, _document_number_ciphertext, _document_number_iv, _document_number_auth_tag, coalesce(_retention_days, 30), _retention_reason)
  returning id into v_vault_id;

  insert into public.identity_ref (tenant_id, hotel_id, reservation_id, vault_id, full_name, nationality, document_type, document_last4)
  values (_tenant_id, _hotel_id, _reservation_id, v_vault_id, _full_name, _nationality, _document_type, _document_last4)
  returning * into v_ref;

  perform public.record_audit_log(_tenant_id, _hotel_id, 'identity_vault.registered', 'identity_ref', v_ref.id,
    jsonb_build_object('reservationId', _reservation_id, 'documentType', _document_type, 'retentionDays', coalesce(_retention_days, 30), 'retentionReason', _retention_reason));

  return v_ref;
end;
$$;

revoke all on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer, text) from public;
grant execute on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer, text) to atiende_app, authenticated;

-- La firma anterior (sin _retention_reason) queda sin uso por apps/api tras este
-- cambio -- se elimina para que no queden dos sobrecargas divergentes de la misma
-- funcion (una validando motivo, otra no) alcanzables por error.
drop function if exists public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer);

-- ==== 0068_consentimiento_y_arco.sql ====
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

-- ==== 0069_retencion_conversaciones_configurable.sql ====
-- auditoria-2/legal [ALTO, parte de "opt-in/opt-out de marketing" y del riesgo general
-- de retencion indefinida ya senalado para la boveda de identidad]: "retencion
-- configurable por hotel para conversation/message con purga programada". Antes de esta
-- migracion no existia ningun mecanismo para que un hotel definiera cuanto tiempo
-- conservar el historial de conversaciones/mensajes de WhatsApp, ni ninguna purga
-- programada equivalente a `purgeExpiredIdentityVault` (bóveda de identidad) para este
-- dato -- que tambien es personal (REQ-HUE-*) y tambien deberia tener un limite, no
-- conservarse para siempre por defecto.
--
-- `conversation_retention_days` NULL significa "usa el default de la plataforma"
-- (ver DEFAULT_CONVERSATION_RETENTION_DAYS en apps/api/src/jobs/purgeConversations.ts
-- -- el NUMERO exacto de dias es una decision de negocio/legal pendiente de confirmar
-- con el fundador, marcada `pendiente-decision` en
-- docs/auditoria-2/correccion-A-seguridad-legal.md; el codigo nunca inventa un plazo
-- legal sin marcarlo como tal, mismo criterio que docs/runbooks/incidentes.md).
alter table public.hotel_messaging_config
  add column conversation_retention_days integer check (conversation_retention_days is null or conversation_retention_days > 0);

comment on column public.hotel_messaging_config.conversation_retention_days is
  'Dias de retencion de conversation/message para este hotel antes de la purga programada. NULL = usa el default de la plataforma (pendiente-decision, ver purgeConversations.ts).';

-- ==== 0070_no_show_idempotencia.sql ====
-- B1/auditoria-2 backend CRÍTICO: POST /hoteles/:hotelId/reservas/procesar-no-show
-- podía postear la penalización de no-show DOS veces con solo dos clics/reintento de
-- red -- el filtro `status = 'confirmada'` de runNoShowJob() solo garantiza
-- idempotencia SECUENCIAL (después de que la primera corrida ya hizo commit), no bajo
-- dos transacciones concurrentes que leen el mismo estado ANTES de que cualquiera
-- escriba. Mismo patrón que ya resuelve `charge_folio_stay_date_hospedaje_idx` (0030)
-- para el cargo de hospedaje del night audit: una restricción única en BD, última
-- línea de defensa contra la carrera, sin depender de que la aplicación gane la
-- carrera correctamente.
--
-- `no_show_reservation_id` es NULL para cualquier cargo que no sea una penalización de
-- no-show (no afecta ningún otro camino de `charge`); el índice único parcial
-- garantiza como máximo UN cargo de penalización de no-show por reserva, sin importar
-- cuántas veces se dispare el job/endpoint para esa misma reserva.
alter table public.charge add column no_show_reservation_id uuid references public.reservation(id) on delete set null;

create unique index charge_no_show_reservation_idx
  on public.charge (no_show_reservation_id)
  where no_show_reservation_id is not null;

-- ==== 0071_agent_approval_confirmation_unica.sql ====
-- A3/T3/backend ALTO (auditoria-2): `PostgresApprovalQueue.decide()` no tenia ningun
-- bloqueo de fila ni restriccion en BD que impidiera que un mismo actor confirmara la
-- MISMA aprobacion dos veces bajo una carrera (el codigo ya se corrige con
-- `SELECT ... FOR UPDATE` en agent-core/src/postgresApproval.ts, ver ese archivo) --
-- esta restriccion unica es la segunda linea de defensa en BD, igual que
-- `agent_approval_lookup_idx`/`lock_agent_approval_key` lo son para `request()`: un
-- actor decide UNA sola vez por aprobacion, sin importar cuantas veces se intente el
-- INSERT.
alter table public.agent_approval_confirmation
  add constraint agent_approval_confirmation_actor_unq unique (approval_id, actor);

-- ==== 0072_agent_approval_ejecutada.sql ====
-- A4 (auditoria-2 agentico/tool-calling): una aprobación ya "aprobada" es reutilizable
-- por `request()` (misma tool+input+hotel+requestedBy dentro del TTL, por diseño --
-- para no duplicar la SOLICITUD de aprobación humana) pero nada marcaba que su EFECTO
-- (la tool aprobada) ya se había ejecutado -- un reintento del modelo, o una segunda
-- ejecución fuera de banda (`decidirYEjecutarAprobacion`) sobre la MISMA fila
-- "aprobada", volvía a correr la tool sin ninguna decisión humana nueva.
--
-- `ejecutada_en` se fija UNA sola vez (ver `markExecuted()`,
-- packages/agent-core/src/postgresApproval.ts): `UPDATE ... WHERE ejecutada_en IS
-- NULL RETURNING id` es la reclamación atómica -- solo la llamada que de verdad
-- actualiza la fila (0 o 1 fila afectada) debe ejecutar la tool.
alter table public.agent_approval add column ejecutada_en timestamptz;

-- ==== 0073_message_dato_sensible.sql ====
-- L-tarjeta (auditoria-2 legal CRÍTICO, REQ-HUE-010/H09-027): un huésped confundido
-- puede escribir su número de tarjeta por WhatsApp; el webhook público lo insertaba
-- tal cual en `message.body`, en texto plano, visible a cualquier rol del hotel. La
-- detección/redacción vive en `packages/domain-hotel/src/paymentFreeTextGuard.ts`
-- (Luhn real, no solo "parece una racha de dígitos") -- esta columna es la bandera
-- que le permite al resto del sistema (panel de mensajería, futuros reportes de
-- cumplimiento) saber que un mensaje se redactó por contener un dato de pago, sin
-- tener que volver a correr la detección sobre el texto ya redactado.
alter table public.message add column contiene_dato_sensible boolean not null default false;

-- ==== 0074_agent_budget_lock.sql ====
-- A5 (auditoria-2 agentico ALTO, REQ-AGT-020): el techo de costo mensual por
-- (hotel, agente) se comprobaba con una lectura no bloqueante (`agent_cost_mes()`,
-- SELECT agregado) -- dos ejecuciones casi simultáneas del mismo agente/hotel podían
-- ambas leer "restante > 0" ANTES de que cualquiera insertara su propia fila en
-- `agent_run`, y juntas rebasar el techo configurado (cada una gastando hasta su
-- propio remanente, sin saber cuánto gastaba la otra).
--
-- Mismo patrón ya usado en este código para el mismo problema en otras dos capas
-- (`lock_agent_approval_key`, 0042; `night_audit_claim`, 0031): un advisory lock
-- TRANSACCIONAL serializa las corridas concurrentes del mismo (hotel, agente) -- la
-- segunda espera a que la primera COMITEE (con su costo real ya en `agent_run`) antes
-- de leer `agent_cost_mes()`, así que ve el consumo real actualizado en vez de un
-- valor obsoleto.
create or replace function public.lock_agent_budget(_hotel_id uuid, _agent_name text)
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(_hotel_id::text || ':agent_budget:' || _agent_name, 0));
end;
$$;

revoke all on function public.lock_agent_budget(uuid, text) from public;
grant execute on function public.lock_agent_budget(uuid, text) to atiende_app, authenticated;

-- ==== 0075_aprobacion_delegado.sql ====
-- A6 (auditoria-2 agentico ALTO, GOB-026): la doble confirmación de dinero exige DOS
-- ROLES de staff distintos -- estructuralmente imposible en un hotel con un solo
-- administrador (owner O gm, no ambos), el perfil típico del cliente objetivo (hotel
-- independiente pequeño, el propio caso ancla del blueprint). Antes, cualquier tool
-- effect="money" quedaba permanentemente inutilizable para ese hotel: la solicitud
-- expiraba a los 15 minutos sin ningún camino para completarla, sin ninguna alerta ni
-- sugerencia de acción.
--
-- Política configurable por hotel, con default explícito y documentado: SIN delegado
-- configurado, el comportamiento NO cambia (dos administradores reales siguen siendo
-- el camino normal, y un hotel de un solo administrador sigue sin poder completar
-- aprobaciones de dinero -- exactamente como antes). El owner/gm ÚNICO de un hotel
-- puede DESIGNAR a otro miembro real del staff (de cualquier rol -- housekeeping,
-- frontdesk, accountant, etc.) como "segundo aprobador delegado" para dinero: su rol
-- real ya es distinto del owner/gm que dio la primera confirmación, así que
-- `decide()` (packages/agent-core) sigue exigiendo roles distintos SIN NINGUNA
-- excepción -- lo único que cambia es QUIÉN tiene permiso de decidir sobre
-- `agent_approval`, nunca la regla de negocio de "dos roles distintos" en sí.
create table public.hotel_approval_delegate (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  org_id uuid not null references public.org(id) on delete cascade,
  user_id uuid not null references public.staff_user(id) on delete cascade,
  designated_by uuid not null references public.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hotel_approval_delegate_org_idx on public.hotel_approval_delegate (org_id);

alter table public.hotel_approval_delegate enable row level security;

-- SELECT: transparencia total dentro del hotel (cualquier rol de staff puede ver quién
-- es el delegado vigente, mismo criterio que agent_approval/agent_config).
create policy "hotel_approval_delegate_hotel_select" on public.hotel_approval_delegate for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT/UPDATE/DELETE: designar o revocar al delegado es una decisión de owner/gm,
-- igual que cambiar el gate de un agente o el techo de costo.
create policy "hotel_approval_delegate_manager_insert" on public.hotel_approval_delegate for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_approval_delegate_manager_update" on public.hotel_approval_delegate for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_approval_delegate_manager_delete" on public.hotel_approval_delegate for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.hotel_approval_delegate to authenticated;

-- Extiende (sin debilitar) las policies existentes de agent_approval/
-- agent_approval_confirmation (0042) para aceptar TAMBIÉN al delegado designado del
-- hotel, además de owner/gm -- sin cambios de comportamiento cuando no hay delegado.
drop policy "agent_approval_manager_update" on public.agent_approval;
create policy "agent_approval_manager_update" on public.agent_approval for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
    or exists (
      select 1 from public.hotel_approval_delegate d
      where d.hotel_id = agent_approval.hotel_id and d.user_id = auth.uid()
    )
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
    or exists (
      select 1 from public.hotel_approval_delegate d
      where d.hotel_id = agent_approval.hotel_id and d.user_id = auth.uid()
    )
  );

drop policy "agent_approval_confirmation_manager_insert" on public.agent_approval_confirmation;
create policy "agent_approval_confirmation_manager_insert" on public.agent_approval_confirmation for insert to authenticated
  with check (
    exists (
      select 1 from public.agent_approval a
      where a.id = approval_id
        and (
          has_hotel_role(a.hotel_id, array['owner', 'gm']::public.hotel_role[])
          or exists (
            select 1 from public.hotel_approval_delegate d
            where d.hotel_id = a.hotel_id and d.user_id = auth.uid()
          )
        )
    )
  );

-- ==== 0080_maintenance_ticket_estimated_cost_nullable.sql ====
-- auditoria-2/frontend [ALTO]: `maintenance_ticket.estimated_cost` era
-- `not null default 0` (0043_maintenance_ticket.sql) -- sin ningún campo en el
-- formulario de "Reportar" para capturarlo, TODO ticket nuevo quedaba en 0, y
-- Mantenimiento.tsx renderizaba "Estimado: $0.00 MXN" sin condición: un costo que
-- nadie estimó se veía como una medición real de $0 (viola REQ-UX-002, "nunca simular
-- una cifra"). Se vuelve la columna NULLABLE (mismo patrón que `actual_cost`, ya
-- nullable en la misma tabla) para que el backend pueda distinguir honestamente
-- "sin estimar" (NULL) de "se estimó en cero" (0) -- expand-only, no destructivo: las
-- filas existentes conservan su valor 0 tal cual.
alter table public.maintenance_ticket alter column estimated_cost drop not null;
alter table public.maintenance_ticket alter column estimated_cost drop default;

-- ==== 0081_decisiones_reservadas_fundador.sql ====
-- REQ-GOB-012 (fuentes GOB-051/GOB-052/BP-066/BP-082/BP-145/BP-150/LLM-022/BP-065/
-- H18-004): "existe un catálogo cerrado de decisiones reservadas exclusivamente al
-- fundador humano ... cualquier cambio en estos dominios requiere aprobación explícita
-- registrada del fundador antes de mergear/ejecutar". Hasta esta migración el catálogo
-- vivía SOLO como prosa (`docs/REQUISITOS.md` §3.16, `docs/BLOQUEOS.md`) — ningún cambio
-- real en ninguno de esos dominios estaba bloqueado por nada más que la buena voluntad
-- de quien escribiera el código (`docs/TRAZABILIDAD.md:156`: "formalizarlo como registro
-- de aprobaciones verificable en código es un proyecto propio").
--
-- IMPORTANTE — qué es "el fundador" en este esquema: NINGÚN rol existente (`hotel_role`:
-- owner/gm/frontdesk/... , 0003) lo representa. `owner` es el dueño/gerente de UN
-- hotel-cliente (un tenant/`org` de la plataforma) — un CLIENTE de atiende-hoteles, no
-- quien opera la plataforma. "El fundador" (Javier) es una identidad de PLATAFORMA, por
-- encima de todas las orgs, que hoy no existe en el esquema — se introduce aquí
-- (`founder_identity`) como tabla separada, deliberadamente sin ningún camino de
-- autoservicio para nombrarse a sí mismo (igual que el alta de `org`/`hotel`, ver 0010:
-- "alta de org/hotel es operación de plataforma fuera de alcance de H1, se hace con el
-- rol propietario" — mismo criterio aquí).
--
-- Diseño (3 piezas):
--   1. `founder_reserved_category` (enum): el catálogo CERRADO en sí — 24 categorías,
--      una por cada dominio listado en REQ-GOB-012/ACEPTACION.md, citado en el comentario
--      de cada valor. Cerrado de verdad: Postgres rechaza cualquier valor fuera de esta
--      lista con un error real (`invalid input value for enum`), no una validación de
--      aplicación que un camino nuevo pueda saltarse.
--   2. `founder_identity` + `is_founder()`: quién SÍ es el fundador (0..n filas, en la
--      práctica 1). Sin GRANT de insert/update/delete a `authenticated` — nombrar a un
--      fundador nunca es alcanzable desde ninguna sesión de aplicación, solo con el rol
--      admin/superusuario del motor (igual que alta de org/hotel).
--   3. `founder_decision_approval` (registro, inmutable salvo revocar) +
--      `has_founder_decision_approval()`/`require_founder_decision_approval()`: el gate
--      genérico reutilizable por cualquier tabla/función del dominio. Alcance por
--      (categoría, org_id NULL=plataforma completa, hotel_id NULL=toda la org).
--
-- Dos superficies REALES ya existentes quedan gateadas por esto en esta misma migración
-- (verificación con datos reales, no solo el mecanismo abstracto):
--   - `register_identity_document()` (0067): extender retención de identidad >30 días
--     hoy solo exige rol owner/gm + motivo — REQ-GOB-012 lista "retención de identidad
--     >30 días" explícitamente como decisión reservada al fundador, no al owner/gm de un
--     hotel-cliente. Se añade el requisito de aprobación del fundador SOBRE el requisito
--     existente (no lo reemplaza).
--   - `agent_config` (0025): pasar el agente de revenue/cierre (`auditor_nocturno`) a
--     `autopilot` hoy solo exige rol owner/gm — REQ-GOB-012 lista "paso de revenue de
--     shadow a autopilot" explícitamente. Se añade un trigger que exige la aprobación
--     ANTES de aceptar ese cambio de gate para ESE agente (los demás agentes, sin tocar
--     revenue directamente, siguen gobernados solo por owner/gm como hasta ahora).
-- Para el resto de las categorías (sin tabla de dominio propia hoy — marca/dominio,
-- proveedor de modelo/telefonía/BD, partner PMS/CM, etc.) se introduce
-- `founder_reserved_setting`: una tabla de configuración genérica por categoría cuyo
-- propio trigger de escritura exige la misma aprobación — el mismo mecanismo, aplicable
-- de inmediato a cualquiera de las 24 categorías sin esperar a que cada una tenga su
-- propia tabla de dominio.

-- 1) Catálogo cerrado -----------------------------------------------------------------
create type public.founder_reserved_category as enum (
  'precios_de_lista',                            -- precios de lista
  'contratos_terceros',                          -- contratos con terceros
  'flujos_dinero_terceros_o_efirma',              -- flujos de dinero de terceros/e.firma
  'retencion_o_biometria',                       -- retención/biometría (política general)
  'outbound_internacional',                      -- outbound internacional
  'modo_autonomo_sensible',                      -- modo autónomo sensible (reseñas ≤3★/reembolsos/reclutamiento/compras sobre umbral/tarifas)
  'cambio_proveedor_modelo_telefonia_bd',        -- cambio de proveedor de modelo/telefonía/BD
  'migracion_livekit_selfhost',                  -- migración a LiveKit self-host
  'borrado_destructivo_o_force_push',            -- borrado destructivo/force-push
  'marca_dominio_o_legal',                       -- marca/dominio/legal
  'impacto_reputacional_externo',                -- acciones con impacto reputacional externo
  'contratacion_despido_o_compensacion',         -- contratación/despido/compensación
  'control_fisico_ac_cerraduras_llaves',         -- control físico AC/cerraduras/llaves
  'shadow_a_autopilot_revenue',                  -- paso de revenue de shadow a autopilot
  'datos_de_otros_hoteles_cliente',              -- uso de datos de otros hoteles-cliente
  'retencion_identidad_mayor_30_dias',           -- retención de identidad >30 días
  'cobro_vcc_disputas_o_declaraciones_fiscales', -- cobro de VCC/disputas/declaraciones fiscales
  'partner_pms_o_cm',                            -- programas de partner PMS/CM
  'compra_de_hardware_o_esco',                   -- compra/financiamiento de hardware/ESCO
  'estructura_de_exito_compartido',              -- estructura de éxito compartido
  'modo_sin_recepcion_nocturna',                 -- modo "sin recepción nocturna"
  'reduccion_de_plantilla',                      -- reducción de plantilla
  'protocolos_de_huracan',                       -- protocolos de huracán
  'abandono_de_lovable_o_convivencia_con_repo'   -- abandono de Lovable o convivencia con el repositorio de código
);

-- 2) Identidad del fundador -------------------------------------------------------------
create table public.founder_identity (
  user_id uuid primary key references public.staff_user(id) on delete restrict,
  full_name text not null,
  created_at timestamptz not null default now()
);

alter table public.founder_identity enable row level security;
-- Transparencia mínima (cualquier sesión puede verificar QUIÉN es el fundador), nunca
-- escritura: alta/baja de fundador es una operación de plataforma que solo el rol
-- admin/superusuario del motor puede hacer (fuera de RLS), igual que alta de org/hotel.
create policy "founder_identity_select" on public.founder_identity for select to authenticated
  using (true);

grant select on public.founder_identity to authenticated;
-- Deliberadamente SIN insert/update/delete a `authenticated`: ni siquiera un owner
-- puede nombrarse (o nombrar a otro) fundador desde ningún camino de la aplicación.

create or replace function public.is_founder()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.founder_identity where user_id = auth.uid())
$$;

revoke all on function public.is_founder() from public;
grant execute on function public.is_founder() to atiende_app, authenticated;

-- 3) Registro de aprobaciones (el gate genérico) ----------------------------------------
create table public.founder_decision_approval (
  id uuid primary key default gen_random_uuid(),
  category public.founder_reserved_category not null,
  -- NULL = aplica a TODA la plataforma (todas las orgs); un valor = solo esa org.
  org_id uuid references public.org(id) on delete cascade,
  -- NULL = aplica a TODOS los hoteles del alcance de arriba; un valor = solo ese hotel.
  hotel_id uuid references public.hotel(id) on delete cascade,
  decided_by uuid not null references public.staff_user(id),
  decided_at timestamptz not null default now(),
  -- GOB-026: texto EXACTO que el fundador aprobó (nunca un resumen/paráfrasis posterior
  -- de otra persona) -- mismo criterio que `agent_approval.texto_mostrado` (0042).
  texto_exacto text not null check (length(trim(texto_exacto)) > 0),
  detail jsonb not null default '{}'::jsonb,
  revoked_at timestamptz,
  revoked_by uuid references public.staff_user(id),
  created_at timestamptz not null default now(),
  check (hotel_id is null or org_id is not null),
  check ((revoked_at is null) = (revoked_by is null))
);
create index founder_decision_approval_lookup_idx
  on public.founder_decision_approval (category, org_id, hotel_id)
  where revoked_at is null;

create or replace function public.founder_decision_approval_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_hotel_org uuid;
begin
  v_actor := auth.uid();

  if new.hotel_id is not null then
    if new.org_id is null then
      raise exception 'hotel_sin_org: no se puede aprobar una decision a nivel de un solo hotel sin especificar org_id'
        using errcode = 'P0001';
    end if;
    select org_id into v_hotel_org from public.hotel where id = new.hotel_id;
    if v_hotel_org is null or v_hotel_org <> new.org_id then
      raise exception 'hotel_no_pertenece_a_org: el hotel % no pertenece a la organizacion %', new.hotel_id, new.org_id
        using errcode = '23514';
    end if;
  end if;

  if TG_OP = 'INSERT' then
    if v_actor is not null then
      -- decided_by nunca lo controla el cliente cuando hay sesion real -- se deriva del
      -- actor autenticado, igual que `record_audit_log` deriva `actor_user_id` (0008).
      new.decided_by := v_actor;
    end if;
    if new.revoked_at is not null or new.revoked_by is not null then
      raise exception 'aprobacion_no_puede_nacer_revocada: revoked_at/revoked_by deben ser NULL al insertar'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- TG_OP = 'UPDATE': la UNICA escritura permitida sobre una fila existente es
  -- revocarla (revoked_at/revoked_by) -- inmutable en todo lo demas, igual que
  -- audit_log. Un fundador que cambio de opinion registra una revocacion (y, si aplica,
  -- una fila NUEVA con la decision correcta) en vez de reescribir la historia.
  if new.category is distinct from old.category
    or new.org_id is distinct from old.org_id
    or new.hotel_id is distinct from old.hotel_id
    or new.decided_by is distinct from old.decided_by
    or new.decided_at is distinct from old.decided_at
    or new.texto_exacto is distinct from old.texto_exacto
    or new.detail is distinct from old.detail
  then
    raise exception 'aprobacion_inmutable: una aprobacion del fundador ya registrada solo puede revocarse (revoked_at/revoked_by), nunca reescribirse'
      using errcode = 'P0001';
  end if;
  if v_actor is not null then
    new.revoked_by := v_actor;
  end if;
  return new;
end;
$$;

create trigger founder_decision_approval_guard_trg
  before insert or update on public.founder_decision_approval
  for each row execute function public.founder_decision_approval_guard();

alter table public.founder_decision_approval enable row level security;

create policy "founder_decision_approval_select" on public.founder_decision_approval for select to authenticated
  using (org_id is null or org_id = any (current_tenant_ids()) or public.is_founder());

-- INSERT/UPDATE: EXCLUSIVAMENTE el fundador -- es la forma mas literal de "cualquier
-- cambio en estos dominios sin aprobacion registrada del fundador es bloqueado": ni
-- owner ni gm de ninguna org (sin importar el rol que tengan en su propio hotel) puede
-- registrar NI revocar una aprobacion de este catalogo.
create policy "founder_decision_approval_insert" on public.founder_decision_approval for insert to authenticated
  with check (public.is_founder());
create policy "founder_decision_approval_update" on public.founder_decision_approval for update to authenticated
  using (public.is_founder())
  with check (public.is_founder());
-- Sin policy de delete: inmutable, igual que audit_log -- una aprobacion se revoca
-- (revoked_at), nunca se borra.

grant select, insert, update on public.founder_decision_approval to authenticated;

create or replace function public.has_founder_decision_approval(
  _category public.founder_reserved_category,
  _org_id uuid default null,
  _hotel_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Una aprobacion cubre el intento cuando su alcance es igual o MAS AMPLIO que el
  -- intento: org_id NULL (plataforma) cubre cualquier org; hotel_id NULL (toda la org)
  -- cubre cualquier hotel de esa org. Nunca al reves (una aprobacion mas ESTRECHA que
  -- el intento no lo cubre).
  select exists (
    select 1
    from public.founder_decision_approval a
    where a.category = _category
      and a.revoked_at is null
      and (a.org_id is null or a.org_id = _org_id)
      and (a.hotel_id is null or a.hotel_id = _hotel_id)
  )
$$;

revoke all on function public.has_founder_decision_approval(public.founder_reserved_category, uuid, uuid) from public;
grant execute on function public.has_founder_decision_approval(public.founder_reserved_category, uuid, uuid) to atiende_app, authenticated;

create or replace function public.require_founder_decision_approval(
  _category public.founder_reserved_category,
  _org_id uuid default null,
  _hotel_id uuid default null
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_founder_decision_approval(_category, _org_id, _hotel_id) then
    raise exception 'aprobacion_fundador_requerida: la categoria "%" (REQ-GOB-012, catalogo cerrado de decisiones reservadas al fundador) no tiene una aprobacion del fundador registrada y vigente para este alcance', _category
      using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.require_founder_decision_approval(public.founder_reserved_category, uuid, uuid) from public;
grant execute on function public.require_founder_decision_approval(public.founder_reserved_category, uuid, uuid) to atiende_app, authenticated;

-- 4) Superficie genérica para categorías sin tabla de dominio propia -------------------
-- Config por (categoria, alcance, key) -- ej. category='cambio_proveedor_modelo_telefonia_bd',
-- key='model_provider'. Cualquier INSERT/UPDATE pasa por el trigger de abajo, que exige
-- la aprobacion vigente ANTES de aceptar el valor nuevo -- el mismo mecanismo sirve para
-- las 24 categorias sin esperar a que cada una tenga su propia tabla de dominio.
create table public.founder_reserved_setting (
  id uuid primary key default gen_random_uuid(),
  category public.founder_reserved_category not null,
  org_id uuid references public.org(id) on delete cascade,
  hotel_id uuid references public.hotel(id) on delete cascade,
  key text not null check (length(trim(key)) > 0),
  value jsonb not null,
  updated_by uuid references public.staff_user(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (hotel_id is null or org_id is not null)
);
-- Unicidad por (categoria, alcance, key) tratando NULL como un valor de alcance mas
-- (coalesce a un sentinel) -- una unique constraint normal no lo lograria (NULL <> NULL
-- en Postgres, dos filas org_id=NULL "no chocarian" bajo una unique constraint comun).
create unique index founder_reserved_setting_scope_key_idx
  on public.founder_reserved_setting (
    category,
    coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(hotel_id, '00000000-0000-0000-0000-000000000000'::uuid),
    key
  );

create or replace function public.founder_reserved_setting_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hotel_org uuid;
begin
  if new.hotel_id is not null then
    if new.org_id is null then
      raise exception 'hotel_sin_org: founder_reserved_setting.hotel_id no puede fijarse sin org_id'
        using errcode = 'P0001';
    end if;
    select org_id into v_hotel_org from public.hotel where id = new.hotel_id;
    if v_hotel_org is null or v_hotel_org <> new.org_id then
      raise exception 'hotel_no_pertenece_a_org: el hotel % no pertenece a la organizacion %', new.hotel_id, new.org_id
        using errcode = '23514';
    end if;
  end if;

  perform public.require_founder_decision_approval(new.category, new.org_id, new.hotel_id);

  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger founder_reserved_setting_guard_trg
  before insert or update on public.founder_reserved_setting
  for each row execute function public.founder_reserved_setting_guard();

alter table public.founder_reserved_setting enable row level security;

create policy "founder_reserved_setting_select" on public.founder_reserved_setting for select to authenticated
  using (org_id is null or org_id = any (current_tenant_ids()) or public.is_founder());

-- Escritura: el fundador siempre puede (es quien aprobo la categoria); un owner/gm de
-- UN hotel especifico puede aplicar el valor una vez que la aprobacion ya existe (el
-- trigger de arriba la exige de todos modos) pero solo para configuracion de SU hotel
-- -- nunca para una fila a nivel de plataforma/org completa (hotel_id NULL), que exige
-- ser el fundador.
create policy "founder_reserved_setting_insert" on public.founder_reserved_setting for insert to authenticated
  with check (
    public.is_founder()
    or (hotel_id is not null and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  );
create policy "founder_reserved_setting_update" on public.founder_reserved_setting for update to authenticated
  using (
    public.is_founder()
    or (hotel_id is not null and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  )
  with check (
    public.is_founder()
    or (hotel_id is not null and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  );

grant select, insert, update on public.founder_reserved_setting to authenticated;

-- 5) Superficies REALES ya existentes, gateadas ahora por el catalogo -------------------

-- 5a) `register_identity_document()` (0067): extender retencion de identidad >30 dias
-- ya exigia rol owner/gm + motivo; REQ-GOB-012 la lista explicitamente como decision
-- reservada al FUNDADOR (no al owner/gm de un hotel-cliente cualquiera) -- se añade el
-- requisito ENCIMA del que ya existia (defensa en profundidad, ninguno reemplaza al
-- otro). Misma firma que 0067: ninguna ruta que ya la invoca cambia.
create or replace function public.register_identity_document(
  _tenant_id uuid,
  _hotel_id uuid,
  _reservation_id uuid,
  _full_name text,
  _nationality text,
  _document_type text,
  _document_last4 text,
  _document_number_ciphertext bytea,
  _document_number_iv bytea,
  _document_number_auth_tag bytea,
  _retention_days integer default 30,
  _retention_reason text default null
)
returns public.identity_ref
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_vault_id uuid;
  v_ref public.identity_ref;
begin
  v_actor := auth.uid();

  if v_actor is not null then
    if not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (register_identity_document)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if not (_hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (register_identity_document)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
    if not has_hotel_role(_hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]) then
      raise exception 'rol_no_autorizado: el actor % no tiene un rol autorizado para registrar identidad en el hotel %', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  if _document_type not in ('pasaporte', 'ine', 'otro') then
    raise exception 'tipo_documento_invalido: "%" no es pasaporte/ine/otro', _document_type using errcode = 'P0001';
  end if;
  if _document_last4 !~ '^[A-Za-z0-9]{4}$' then
    raise exception 'ultimos4_invalidos: debe ser exactamente 4 caracteres alfanumericos' using errcode = 'P0001';
  end if;

  if coalesce(_retention_days, 30) > 30 then
    if _retention_reason is null or length(trim(_retention_reason)) = 0 then
      raise exception 'motivo_retencion_requerido: una retencion mayor a 30 dias exige justificar el motivo (REQ-SEG-004)'
        using errcode = 'P0001';
    end if;
    if v_actor is not null then
      if not has_hotel_role(_hotel_id, array['owner', 'gm']::public.hotel_role[]) then
        raise exception 'rol_no_autorizado: extender la retencion mas alla de 30 dias requiere rol owner/gm en el hotel %', _hotel_id
          using errcode = '42501';
      end if;
      -- REQ-GOB-012: "retencion de identidad >30 dias" es decision reservada al
      -- fundador -- owner/gm del hotel-cliente ya no basta por si solo.
      perform public.require_founder_decision_approval('retencion_identidad_mayor_30_dias', _tenant_id, _hotel_id);
    end if;
  end if;

  insert into public.identity_vault (tenant_id, hotel_id, reservation_id, document_number_ciphertext, document_number_iv, document_number_auth_tag, retention_days, retention_reason)
  values (_tenant_id, _hotel_id, _reservation_id, _document_number_ciphertext, _document_number_iv, _document_number_auth_tag, coalesce(_retention_days, 30), _retention_reason)
  returning id into v_vault_id;

  insert into public.identity_ref (tenant_id, hotel_id, reservation_id, vault_id, full_name, nationality, document_type, document_last4)
  values (_tenant_id, _hotel_id, _reservation_id, v_vault_id, _full_name, _nationality, _document_type, _document_last4)
  returning * into v_ref;

  perform public.record_audit_log(_tenant_id, _hotel_id, 'identity_vault.registered', 'identity_ref', v_ref.id,
    jsonb_build_object('reservationId', _reservation_id, 'documentType', _document_type, 'retentionDays', coalesce(_retention_days, 30), 'retentionReason', _retention_reason));

  return v_ref;
end;
$$;

revoke all on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer, text) from public;
grant execute on function public.register_identity_document(uuid, uuid, uuid, text, text, text, text, bytea, bytea, bytea, integer, text) to atiende_app, authenticated;

-- 5b) `agent_config` (0025): pasar `auditor_nocturno` (el UNICO agente etiquetado
-- "revenue/cierre" en el catalogo, `packages/agent-core/src/agents.ts`) a `autopilot`
-- es exactamente "shadow -> autopilot de revenue" -- se exige la aprobacion ANTES de
-- aceptar ese valor. Los demas agentes (`recepcion_virtual`, `enrutador_mensajes`) NO
-- tocan revenue directamente y siguen gobernados solo por la RLS owner/gm existente
-- (0025) -- ver tests/integration/api/agentes.spec.ts y
-- tests/adversarial/agentes-aislamiento.spec.ts, que ya suben `recepcion_virtual` a
-- autopilot sin pasar por este trigger; no se alteran.
create or replace function public.agent_config_shadow_a_autopilot_revenue_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.agent_name = 'auditor_nocturno' and new.gate = 'autopilot' then
    perform public.require_founder_decision_approval('shadow_a_autopilot_revenue', new.org_id, new.hotel_id);
  end if;
  return new;
end;
$$;

create trigger agent_config_shadow_a_autopilot_revenue_guard_trg
  before insert or update on public.agent_config
  for each row execute function public.agent_config_shadow_a_autopilot_revenue_guard();

-- ==== 0082_revenue_engine_gate.sql ====
-- REQ-REV-003 (P0/GOB, fuentes BP-053/BP-054/BP-056/H02-003/H07-007/BP-016): el motor de
-- revenue (recomendación/ejecución de tarifas BAR) debe operar en "shadow" (solo
-- registra lo que habría hecho, nunca ejecuta) un mínimo de 90 días, con backtesting
-- walk-forward obligatorio que exija mejora vs. baseline antes de habilitar autopilot;
-- después de shadow pasa a "propone y ejecuta" (con aprobación — reutilizable el
-- adaptador de mensajería ya simulado de REQ-UX-006, `agent_approval`/
-- `PostgresApprovalQueue`, este esquema no lo reimplementa) con un límite de variación
-- ±10-15% hasta autopilot pleno.
--
-- Distinción con `agent_config` (0025): esa tabla gobierna el gate del AGENTE LLM
-- `auditor_nocturno` (narra/revisa el cierre, `packages/agent-core`); esta tabla
-- gobierna el gate del MOTOR DETERMINISTA de tarifas en sí — una superficie de negocio
-- distinta, con sus propias reglas de promoción (90 días mínimos + backtest walk-forward
-- + aprobación del fundador), no solo un techo de costo mensual. Reutiliza el mismo
-- enum `public.agent_gate` (0024) para mantener el vocabulario shadow/propone/autopilot
-- consistente en todo el esquema (mismo criterio documentado en
-- `packages/domain-hotel/src/revenue/revenueEngineGate.ts`).
--
-- Autoridad real: el trigger `revenue_engine_gate_transition_guard_trg` de abajo, no la
-- aplicación — ninguna sesión (ni siquiera owner/gm, que sí pueden escribir la fila por
-- RLS) puede saltarse el mínimo de 90 días, el backtest, o la aprobación del fundador
-- escribiendo directamente a esta tabla.

-- 1) Estado del gate por hotel ----------------------------------------------------------
create table public.revenue_engine_gate (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  gate public.agent_gate not null default 'shadow',
  -- Momento en que el hotel entró (o volvió a entrar, tras una democión) en shadow.
  shadow_started_at timestamptz not null default now(),
  propone_started_at timestamptz,
  autopilot_started_at timestamptz,
  -- REQ-REV-003 "límite de variación (±10-15%)" vigente mientras gate = 'propone'.
  propone_max_variation_pct numeric(4, 1) not null default 15.0
    check (propone_max_variation_pct >= 10.0 and propone_max_variation_pct <= 15.0),
  updated_by uuid references public.staff_user(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (hotel_id),
  check (hotel_id is not null)
);

create index revenue_engine_gate_org_idx on public.revenue_engine_gate (org_id);

-- 2) Backtests walk-forward corridos por hotel ------------------------------------------
-- Un registro por corrida (histórico completo, nunca se sobrescribe) — el trigger de
-- arriba solo mira la más reciente para decidir si autopilot es elegible, pero conservar
-- el historial permite auditar por qué una promoción se aprobó (o se bloqueó) en su
-- momento, mismo criterio que `revenue_backtest_run` nunca se actualiza in-place.
create table public.revenue_backtest_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- Espejo de `CounterfactualMethod` (walkForwardBacktest.ts) — un CHECK de catálogo
  -- cerrado, no texto libre, para que un método inventado sobre la marcha (nunca
  -- documentado) no pueda colarse como si fuera uno de los 3 métodos honestos del
  -- dominio.
  counterfactual_method text not null
    check (counterfactual_method in ('misma_tarifa_periodo_anterior', 'tarifa_estatica_pre_motor', 'modelo_elasticidad_declarado')),
  windows_evaluated integer not null check (windows_evaluated >= 0),
  windows_engine_won integer not null check (windows_engine_won >= 0 and windows_engine_won <= windows_evaluated),
  engine_total_revenue numeric(14, 2) not null,
  baseline_total_revenue numeric(14, 2) not null,
  improvement_pct numeric(8, 3) not null,
  passes boolean not null,
  -- Códigos de falla (espejo de `WalkForwardBacktestResult.failureReasons`) — '[]' si
  -- `passes = true`.
  failure_reasons jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  run_by uuid references public.staff_user(id),
  run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check ((passes = true) = (failure_reasons = '[]'::jsonb))
);

create index revenue_backtest_run_hotel_idx on public.revenue_backtest_run (hotel_id, run_at desc);

-- 3) Guard de pertenencia hotel/org, reutilizado por ambas tablas -----------------------
create or replace function public.revenue_engine_validate_hotel_org(_hotel_id uuid, _org_id uuid)
returns void
language plpgsql
stable
as $$
declare
  v_hotel_org uuid;
begin
  select org_id into v_hotel_org from public.hotel where id = _hotel_id;
  if v_hotel_org is null or v_hotel_org <> _org_id then
    raise exception 'hotel_no_pertenece_a_org: el hotel % no pertenece a la organizacion %', _hotel_id, _org_id
      using errcode = '23514';
  end if;
end;
$$;

-- 4) Trigger de transición del gate (la máquina de estados REAL) ------------------------
create or replace function public.revenue_engine_gate_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_order_from integer;
  v_order_to integer;
  v_days_in_shadow integer;
  v_latest_backtest record;
begin
  perform public.revenue_engine_validate_hotel_org(new.hotel_id, new.org_id);

  if TG_OP = 'INSERT' then
    -- BP-016: ningún hotel entra en un gate distinto de shadow por omisión ni por
    -- inserción directa — la única forma de llegar a "propone"/"autopilot" es
    -- promover una fila ya existente a través de este mismo trigger.
    if new.gate <> 'shadow' then
      raise exception 'gate_inicial_invalido: todo hotel nuevo debe comenzar en "shadow" (REQ-REV-003/BP-016), no en "%"', new.gate
        using errcode = 'P0001';
    end if;
    new.shadow_started_at := coalesce(new.shadow_started_at, v_now);
    new.propone_started_at := null;
    new.autopilot_started_at := null;
    new.updated_by := auth.uid();
    new.updated_at := v_now;
    return new;
  end if;

  -- TG_OP = 'UPDATE' -----------------------------------------------------------------
  if new.gate = old.gate then
    -- Sin cambio de fase: los timestamps de fase son inmutables fuera de una
    -- transición real (evita que alguien "reescriba" cuánto tiempo lleva en shadow sin
    -- pasar por una transición de gate de verdad).
    if new.shadow_started_at is distinct from old.shadow_started_at
      or new.propone_started_at is distinct from old.propone_started_at
      or new.autopilot_started_at is distinct from old.autopilot_started_at
    then
      raise exception 'timestamps_de_fase_inmutables: shadow_started_at/propone_started_at/autopilot_started_at solo los fija este trigger durante una transición real de gate'
        using errcode = 'P0001';
    end if;
    new.updated_by := auth.uid();
    new.updated_at := v_now;
    return new;
  end if;

  v_order_from := case old.gate when 'shadow' then 0 when 'propone' then 1 when 'autopilot' then 2 end;
  v_order_to := case new.gate when 'shadow' then 0 when 'propone' then 1 when 'autopilot' then 2 end;

  if v_order_to < v_order_from then
    -- DEMOCIÓN ("freno de emergencia"): siempre permitida, sin ninguna de las
    -- condiciones de abajo — mismo criterio que aprobacionEjecutor.ts documenta para
    -- el agente LLM ("un gerente que baja el agente a shadow ... no tenía ninguna
    -- garantía de que se detuviera"). Volver a shadow reinicia el reloj de 90 días
    -- (es un shadow NUEVO, no una pausa); volver a propone desde autopilot conserva
    -- (o fija, si faltaba) su propio started_at pero exige un backtest NUEVO (posterior
    -- a ese started_at) para volver a subir.
    if new.gate = 'shadow' then
      new.shadow_started_at := v_now;
      new.propone_started_at := null;
      new.autopilot_started_at := null;
    elsif new.gate = 'propone' then
      new.propone_started_at := v_now;
      new.autopilot_started_at := null;
    end if;
    new.updated_by := auth.uid();
    new.updated_at := v_now;
    return new;
  end if;

  if v_order_to > v_order_from + 1 then
    raise exception 'transicion_no_permitida: no se puede saltar directamente de "%" a "%" (REQ-REV-003 exige pasar por "propone")', old.gate, new.gate
      using errcode = 'P0001';
  end if;

  -- PROMOCIÓN shadow -> propone: mínimo 90 días en shadow.
  if old.gate = 'shadow' and new.gate = 'propone' then
    v_days_in_shadow := floor(extract(epoch from (v_now - old.shadow_started_at)) / 86400);
    if v_days_in_shadow < 90 then
      raise exception 'shadow_insuficiente: se requieren 90 dias en shadow antes de pasar a "propone" (REQ-REV-003), van % dias', v_days_in_shadow
        using errcode = 'P0001';
    end if;
    new.propone_started_at := v_now;
    new.autopilot_started_at := null;
  end if;

  -- PROMOCIÓN propone -> autopilot: backtest walk-forward vigente que pase + aprobación
  -- registrada del fundador (REQ-GOB-012, categoría 'shadow_a_autopilot_revenue', ya
  -- definida en 0081 -- se reutiliza tal cual, nunca se duplica el catálogo).
  if old.gate = 'propone' and new.gate = 'autopilot' then
    select * into v_latest_backtest
      from public.revenue_backtest_run
      where hotel_id = new.hotel_id
      order by run_at desc
      limit 1;

    if v_latest_backtest is null or v_latest_backtest.passes is not true then
      raise exception 'backtest_no_supera_baseline: no existe un backtest walk-forward vigente que demuestre mejora vs. baseline para el hotel % (REQ-REV-003)', new.hotel_id
        using errcode = 'P0001';
    end if;
    if old.propone_started_at is not null and v_latest_backtest.run_at < old.propone_started_at then
      raise exception 'backtest_obsoleto: el ultimo backtest walk-forward es anterior a que este hotel entrara en modo "propone" -- se requiere uno corrido durante/despues de "propone"'
        using errcode = 'P0001';
    end if;

    perform public.require_founder_decision_approval('shadow_a_autopilot_revenue', new.org_id, new.hotel_id);

    new.autopilot_started_at := v_now;
  end if;

  new.updated_by := auth.uid();
  new.updated_at := v_now;
  return new;
end;
$$;

create trigger revenue_engine_gate_transition_guard_trg
  before insert or update on public.revenue_engine_gate
  for each row execute function public.revenue_engine_gate_transition_guard();

-- 5) Guard de pertenencia hotel/org para revenue_backtest_run ---------------------------
create or replace function public.revenue_backtest_run_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.revenue_engine_validate_hotel_org(new.hotel_id, new.org_id);
  new.run_by := coalesce(new.run_by, auth.uid());
  return new;
end;
$$;

create trigger revenue_backtest_run_guard_trg
  before insert on public.revenue_backtest_run
  for each row execute function public.revenue_backtest_run_guard();

-- 6) RLS ----------------------------------------------------------------------------
alter table public.revenue_engine_gate enable row level security;

-- SELECT: cualquier rol de staff del hotel puede ver el gate vigente (transparencia,
-- mismo criterio que agent_config/agent_approval).
create policy "revenue_engine_gate_hotel_select" on public.revenue_engine_gate for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT/UPDATE: cambiar el gate del motor de revenue (o su límite de variación) es una
-- decisión de gobierno reservada a owner/gm (mismo nivel que agent_config, 0025) — el
-- trigger de arriba impone además las condiciones REALES de promoción/aprobación, esto
-- solo decide quién puede intentarlo.
create policy "revenue_engine_gate_manager_insert" on public.revenue_engine_gate for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "revenue_engine_gate_manager_update" on public.revenue_engine_gate for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.revenue_engine_gate to authenticated;

alter table public.revenue_backtest_run enable row level security;

-- SELECT: igual transparencia que el gate — cualquier rol de staff del hotel puede ver
-- el historial de backtests (es la evidencia de por qué el gate está donde está).
create policy "revenue_backtest_run_hotel_select" on public.revenue_backtest_run for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT: registrar la corrida de un backtest requiere el mismo nivel que decidir el
-- gate (owner/gm) o accountant (rol que ya opera night audit/cierre, REQ-REV-013) —
-- nunca frontdesk/housekeeping/maintenance/fnb, que no tienen ninguna injerencia sobre
-- revenue. Sin policy de UPDATE/DELETE: cada corrida es inmutable, igual que audit_log.
create policy "revenue_backtest_run_manager_insert" on public.revenue_backtest_run for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[]));

grant select, insert on public.revenue_backtest_run to authenticated;

-- ==== 0084_fnb_order.sql ====
-- H? · REQ-AB-004 (P0/GOB): pedido de F&B con alergia/restricción alimentaria
-- declarada -- la orden SIEMPRE requiere confirmación humana de un cocinero (rol
-- 'fnb') antes de que cualquier capa del sistema pueda asegurar al huésped que el
-- platillo es seguro. Superficie MÍNIMA para esta regla: NO implementa el enrutamiento
-- a KDS/cocina, SLA de entrega, ni cargo a folio del REQ-AB-002 (ver
-- docs/TRAZABILIDAD.md -- ese requisito sigue pendiente-credenciales de PMS/POS y no
-- se duplica aquí).
--
-- Defensa en dos capas (mismo principio que 0062/0063/0065, "valida actor"):
-- `packages/domain-hotel/src/fnbAllergyGuard.ts` es la primera barrera (aplicación),
-- pero el último CHECK de abajo es la barrera ESTRUCTURAL real -- ninguna fila puede
-- persistir en un estado donde `safety_assurance_sent_at` esté lleno para un pedido
-- con alergia declarada sin que `kitchen_confirmed_at` también lo esté, sin importar
-- qué código (incluido un bug futuro que se salte la guarda de aplicación) intente el
-- UPDATE.

create table public.fnb_order (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid references public.room(id) on delete set null,
  items jsonb not null default '[]'::jsonb,
  notes text,
  allergy_declared boolean not null default false,
  -- 'estructurado' = el huésped/staff marcó el campo explícito; 'texto_libre' = la
  -- red de seguridad de `resolveAllergyDeclared()` lo detectó en una nota libre.
  allergy_declared_via text check (allergy_declared_via in ('estructurado', 'texto_libre')),
  kitchen_confirmed_by uuid references public.staff_user(id) on delete set null,
  kitchen_confirmed_at timestamptz,
  kitchen_confirmation_note text,
  -- Auditoría de la ÚNICA acción que "asegura" al huésped que el platillo es seguro
  -- (`POST .../asegurar-seguridad`) -- si esta columna nunca se llena para un pedido,
  -- es evidencia estructural de que el sistema nunca emitió esa afirmación.
  safety_assurance_sent_by uuid references public.staff_user(id) on delete set null,
  safety_assurance_sent_at timestamptz,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (allergy_declared = (allergy_declared_via is not null)),
  check ((kitchen_confirmed_by is null) = (kitchen_confirmed_at is null)),
  check (
    safety_assurance_sent_at is null
    or not allergy_declared
    or kitchen_confirmed_at is not null
  )
);
create index fnb_order_tenant_hotel_idx on public.fnb_order (tenant_id, hotel_id);
create index fnb_order_room_idx on public.fnb_order (room_id) where room_id is not null;
create index fnb_order_allergy_pendiente_idx on public.fnb_order (hotel_id, allergy_declared)
  where allergy_declared and kitchen_confirmed_at is null;

alter table public.fnb_order enable row level security;

-- Visibilidad: solo los roles con motivo operativo para ver pedidos de F&B (dirección,
-- recepción que los toma, y el propio F&B/cocina) -- housekeeping/mantenimiento/
-- reservaciones/contabilidad no tienen necesidad de leer esta tabla.
create policy "fnb_order_staff_select" on public.fnb_order for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'fnb']::public.hotel_role[])
  );

create policy "fnb_order_staff_insert" on public.fnb_order for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'fnb']::public.hotel_role[])
  );

-- UPDATE cubre TANTO "confirmar-cocina" (kitchen_confirmed_*) COMO "asegurar-seguridad"
-- (safety_assurance_sent_*) -- deliberadamente restringido a quien puede saber de
-- verdad si la cocina revisó el platillo (owner/gm de respaldo, o 'fnb' mismo). NUNCA
-- frontdesk: puede tomar el pedido (insert), pero no confirmar ni afirmar seguridad en
-- nombre de la cocina -- ampliar esto a más roles es una decisión de producto explícita
-- para cuando exista el canal de mensajería real hacia el huésped (REQ-AB-002).
create policy "fnb_order_kitchen_update" on public.fnb_order for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]));

create policy "fnb_order_manager_delete" on public.fnb_order for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.fnb_order to authenticated;

-- ==== 0085_identity_vault_doble_control.sql ====
-- REQ-SEG-014 (cierre del pendiente declarado en 0051/docs/REQUISITOS.md): "doble
-- control" pleno para la bóveda de identidad -- una lectura sensible (revelar el
-- número de documento completo) debe requerir la aprobación de una SEGUNDA persona
-- antes de exponerse, no solo el rol owner/gm de quien la pide.
--
-- Hasta esta migración, `read_identity_vault_document()` (0051) exigía rol owner/gm +
-- motivo + bitácora, pero UNA sola persona con ese rol podía revelar el documento sin
-- que nadie más lo supiera de antemano ni lo autorizara -- exactamente el hueco que la
-- cabecera de 0051 y `docs/REQUISITOS.md` (REQ-SEG-014) documentan como NO
-- implementado.
--
-- Flujo nuevo (tres funciones SECURITY DEFINER, mismo patrón que el resto de la
-- bóveda -- ningún acceso directo a la tabla nueva para escribir, ver policies abajo):
--   1. `request_identity_vault_access(identity_ref_id, reason)` -- un owner/gm
--      solicita acceso; la solicitud queda `pendiente`.
--   2. `decide_identity_vault_access(request_id, decision)` -- un owner/gm DISTINTO de
--      quien solicitó aprueba o rechaza; auto-aprobación explícitamente rechazada
--      (`autoaprobacion_no_permitida`) -- este es el núcleo del doble control.
--   3. `reveal_identity_vault_document(request_id)` -- SOLO quien solicitó puede
--      consumir una solicitud ya `aprobada`; de un solo uso (`consumed_at`), dentro de
--      la ventana de vigencia de la solicitud (30 minutos, igual orden de magnitud que
--      `agent_approval`, 0042).
--
-- Cada paso dejá su propio evento en `audit_log` (`identity_vault.access_requested`/
-- `access_approved`/`access_rejected`/`decrypted`) -- la bitácora ya no solo registra
-- QUIÉN reveló, sino también QUIÉN lo pidió y QUIÉN lo autorizó.
--
-- Límite conocido (mismo problema que 0075 documenta para la doble confirmación de
-- dinero): un hotel con un solo actor real en rol owner/gm no tiene una segunda
-- persona que pueda aprobar -- sus solicitudes de acceso a la bóveda quedarán sin
-- poder completarse (expiran a los 30 minutos) hasta que exista un segundo owner/gm.
-- A diferencia de GOB-026/dinero, REQ-SEG-014 no declara explícitamente un mecanismo
-- de delegado para este caso, así que no se agrega aquí -- documentado para que no se
-- lea como un descuido.
--
-- Expand-only sobre migraciones ya mergeadas (REQ-GOB-010): tabla nueva + funciones
-- reemplazadas vía `create or replace function`/`drop function` (mismo patrón que
-- 0065/0067 sobre esta misma bóveda).

create type public.identity_vault_access_status as enum ('pendiente', 'aprobada', 'rechazada', 'expirada', 'consumida');

create table public.identity_vault_access_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  identity_ref_id uuid not null references public.identity_ref(id) on delete cascade,
  requested_by uuid not null references public.staff_user(id) on delete restrict,
  reason text not null,
  status public.identity_vault_access_status not null default 'pendiente',
  approved_by uuid references public.staff_user(id) on delete restrict,
  decided_at timestamptz,
  consumed_at timestamptz,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- El aprobador nunca puede ser quien solicitó -- esto es además una invariante de
  -- fila (defensa en profundidad sobre la validación en `decide_identity_vault_access`).
  constraint identity_vault_access_request_approver_distinto check (approved_by is null or approved_by <> requested_by)
);
create index identity_vault_access_request_hotel_status_idx on public.identity_vault_access_request (hotel_id, status);
create index identity_vault_access_request_ref_idx on public.identity_vault_access_request (identity_ref_id);

alter table public.identity_vault_access_request enable row level security;
-- SELECT: transparencia dentro del hotel para owner/gm (misma bandeja que
-- `agent_approval`, 0042) -- ver quién solicitó, quién decidió y en qué estado está.
-- housekeeping/maintenance/fnb/frontdesk/reservations/accountant nunca necesitan ver
-- esto (mismo criterio de acceso que `identity_ref`, más estricto: aquí ni siquiera
-- frontdesk/reservations, que sí pueden REGISTRAR identidad, pueden ver solicitudes de
-- revelado -- revelar el documento completo siempre fue exclusivo de owner/gm).
create policy "identity_vault_access_request_manager_select" on public.identity_vault_access_request for select to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
-- Sin ninguna policy de insert/update/delete para `authenticated`: toda escritura pasa
-- por las funciones SECURITY DEFINER de abajo (mismo criterio que `identity_vault`).
grant select on public.identity_vault_access_request to authenticated;

-- request_identity_vault_access(): paso 1 -- un owner/gm solicita acceso a un
-- `identity_ref` concreto, documentando el motivo. Nunca ve ni toca la bóveda misma.
create or replace function public.request_identity_vault_access(
  _identity_ref_id uuid,
  _reason text
)
returns public.identity_vault_access_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_ref public.identity_ref;
  v_row public.identity_vault_access_request;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'actor_requerido: solicitar acceso a la bóveda de identidad exige una sesión real (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  if _reason is null or length(trim(_reason)) = 0 then
    raise exception 'motivo_requerido: toda solicitud de acceso a la bóveda de identidad debe documentar un motivo (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  select * into v_ref from public.identity_ref where id = _identity_ref_id;
  if not found then
    raise exception 'identity_ref_no_encontrado: %', _identity_ref_id using errcode = 'P0001';
  end if;

  if not has_hotel_role(v_ref.hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'rol_no_autorizado: el actor % no tiene rol owner/gm en el hotel % (REQ-SEG-014)', v_actor, v_ref.hotel_id
      using errcode = '42501';
  end if;

  insert into public.identity_vault_access_request (tenant_id, hotel_id, identity_ref_id, requested_by, reason)
  values (v_ref.tenant_id, v_ref.hotel_id, _identity_ref_id, v_actor, _reason)
  returning * into v_row;

  perform public.record_audit_log(v_ref.tenant_id, v_ref.hotel_id, 'identity_vault.access_requested', 'identity_ref', v_ref.id,
    jsonb_build_object('requestId', v_row.id, 'reason', _reason));

  return v_row;
end;
$$;

revoke all on function public.request_identity_vault_access(uuid, text) from public;
grant execute on function public.request_identity_vault_access(uuid, text) to atiende_app, authenticated;

-- decide_identity_vault_access(): paso 2 -- núcleo del doble control. Un owner/gm
-- DISTINTO del solicitante aprueba o rechaza. Nunca ve ni toca la bóveda misma
-- (solo cambia el estado de la solicitud).
create or replace function public.decide_identity_vault_access(
  _request_id uuid,
  _decision text
)
returns public.identity_vault_access_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_row public.identity_vault_access_request;
  v_new_status public.identity_vault_access_status;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'actor_requerido: decidir una solicitud de la bóveda de identidad exige una sesión real (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  if _decision not in ('aprobar', 'rechazar') then
    raise exception 'decision_invalida: "%" no es aprobar/rechazar', _decision using errcode = 'P0001';
  end if;

  select * into v_row from public.identity_vault_access_request where id = _request_id;
  if not found then
    raise exception 'solicitud_no_encontrada: %', _request_id using errcode = 'P0001';
  end if;

  if not has_hotel_role(v_row.hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'rol_no_autorizado: el actor % no tiene rol owner/gm en el hotel % (REQ-SEG-014)', v_actor, v_row.hotel_id
      using errcode = '42501';
  end if;

  if v_row.status <> 'pendiente' then
    raise exception 'solicitud_no_pendiente: la solicitud % ya está en estado % (REQ-SEG-014)', _request_id, v_row.status
      using errcode = 'P0001';
  end if;

  if now() > v_row.expires_at then
    update public.identity_vault_access_request set status = 'expirada', updated_at = now() where id = _request_id;
    raise exception 'solicitud_expirada: la solicitud % venció el % (REQ-SEG-014)', _request_id, v_row.expires_at
      using errcode = 'P0001';
  end if;

  -- Doble control: el aprobador debe ser una persona DISTINTA de quien solicitó --
  -- nunca la misma persona auto-aprobándose (aunque tenga el rol correcto).
  if v_actor = v_row.requested_by then
    raise exception 'autoaprobacion_no_permitida: quien solicita el acceso no puede aprobar su propia solicitud (REQ-SEG-014)'
      using errcode = '42501';
  end if;

  v_new_status := case _decision
    when 'aprobar' then 'aprobada'::public.identity_vault_access_status
    else 'rechazada'::public.identity_vault_access_status
  end;

  update public.identity_vault_access_request
  set status = v_new_status, approved_by = v_actor, decided_at = now(), updated_at = now()
  where id = _request_id
  returning * into v_row;

  perform public.record_audit_log(v_row.tenant_id, v_row.hotel_id,
    case _decision when 'aprobar' then 'identity_vault.access_approved' else 'identity_vault.access_rejected' end,
    'identity_ref', v_row.identity_ref_id,
    jsonb_build_object('requestId', v_row.id, 'requestedBy', v_row.requested_by));

  return v_row;
end;
$$;

revoke all on function public.decide_identity_vault_access(uuid, text) from public;
grant execute on function public.decide_identity_vault_access(uuid, text) to atiende_app, authenticated;

-- reveal_identity_vault_document(): paso 3 -- reemplaza a `read_identity_vault_document`
-- (0051) como único punto de lectura de los bytes cifrados. Ahora exige una solicitud
-- ya `aprobada` por una segunda persona, consumida exactamente una vez, y solo por
-- quien la solicitó originalmente.
create or replace function public.reveal_identity_vault_document(
  _request_id uuid
)
returns table (document_number_ciphertext bytea, document_number_iv bytea, document_number_auth_tag bytea)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_row public.identity_vault_access_request;
  v_ref public.identity_ref;
  v_vault public.identity_vault;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'actor_requerido: exponer un documento de la bóveda de identidad exige una sesión real (REQ-SEG-014)'
      using errcode = 'P0001';
  end if;

  select * into v_row from public.identity_vault_access_request where id = _request_id;
  if not found then
    raise exception 'solicitud_no_encontrada: %', _request_id using errcode = 'P0001';
  end if;

  if not has_hotel_role(v_row.hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'rol_no_autorizado: el actor % no tiene rol owner/gm en el hotel % (REQ-SEG-014)', v_actor, v_row.hotel_id
      using errcode = '42501';
  end if;

  -- Solo quien solicitó el acceso puede consumir la aprobación -- el aprobador (la
  -- segunda persona) autoriza, pero no adquiere por eso el derecho a leer el documento.
  if v_actor <> v_row.requested_by then
    raise exception 'actor_no_autorizado: solo quien solicitó el acceso puede exponer el documento de la solicitud % (REQ-SEG-014)', _request_id
      using errcode = '42501';
  end if;

  if v_row.status = 'consumida' then
    raise exception 'solicitud_ya_consumida: la solicitud % ya se usó para exponer el documento -- cada aprobación autoriza una sola lectura (REQ-SEG-014)', _request_id
      using errcode = 'P0001';
  end if;

  if v_row.status <> 'aprobada' then
    raise exception 'solicitud_no_aprobada: la solicitud % debe ser aprobada por una segunda persona antes de exponer el documento (REQ-SEG-014)', _request_id
      using errcode = 'P0001';
  end if;

  if now() > v_row.expires_at then
    update public.identity_vault_access_request set status = 'expirada', updated_at = now() where id = _request_id;
    raise exception 'solicitud_expirada: la solicitud % venció el % (REQ-SEG-014)', _request_id, v_row.expires_at
      using errcode = 'P0001';
  end if;

  select * into v_ref from public.identity_ref where id = v_row.identity_ref_id;
  select * into v_vault from public.identity_vault where id = v_ref.vault_id;

  update public.identity_vault_access_request
  set status = 'consumida', consumed_at = now(), updated_at = now()
  where id = _request_id;

  -- Bitácora inmutable de CADA lectura (REQ-SEG-014 "acceso auditado por rol") --
  -- nunca se omite, incluso si la lectura es legítima. Ahora también deja constancia
  -- de quién pidió y quién aprobó, no solo de quién ejecutó la lectura final.
  perform public.record_audit_log(v_row.tenant_id, v_row.hotel_id, 'identity_vault.decrypted', 'identity_ref', v_ref.id,
    jsonb_build_object('reason', v_row.reason, 'requestId', v_row.id, 'approvedBy', v_row.approved_by));

  return query select v_vault.document_number_ciphertext, v_vault.document_number_iv, v_vault.document_number_auth_tag;
end;
$$;

revoke all on function public.reveal_identity_vault_document(uuid) from public;
grant execute on function public.reveal_identity_vault_document(uuid) to atiende_app, authenticated;

-- read_identity_vault_document() (0051) queda reemplazada por el flujo de tres pasos de
-- arriba -- permitía revelar el documento con una sola persona (rol owner/gm) sin que
-- nadie más lo aprobara antes, exactamente el hueco que REQ-SEG-014 pedía cerrar. Se
-- elimina (no se deja como alias/atajo) para que no quede un bypass directo del doble
-- control alcanzable por error o por un caller que no se haya actualizado.
drop function if exists public.read_identity_vault_document(uuid, text);

-- ==== 0090_staff_schedule.sql ====
-- REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): horario programado por empleado, contra el
-- cual `packages/domain-hotel` cruza lo REALMENTE trabajado (attendance_log, migracion
-- 0091) para detectar horas extra no autorizadas. Es MUTABLE a proposito -- un gerente
-- puede reprogramar un turno futuro sin restriccion -- porque lo que la ley exige
-- inalterable es el REGISTRO DE ASISTENCIA (lo trabajado), no el horario planeado.
create table public.staff_schedule (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  staff_user_id uuid not null references public.staff_user(id) on delete cascade,
  work_date date not null,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  -- Horas extra PRE-AUTORIZADAS para este turno (ej. por el GM, al programarlo). El
  -- cruce en packages/domain-hotel solo marca "no autorizada" la porcion de tiempo
  -- trabajado de mas que EXCEDE este margen -- nunca todo el excedente a ciegas.
  authorized_overtime_minutes integer not null default 0,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, staff_user_id, work_date),
  constraint staff_schedule_rango_valido check (scheduled_end > scheduled_start),
  constraint staff_schedule_overtime_no_negativo check (authorized_overtime_minutes >= 0)
);
create index staff_schedule_hotel_date_idx on public.staff_schedule (hotel_id, work_date);
create index staff_schedule_staff_idx on public.staff_schedule (staff_user_id);

-- upsert_staff_schedule(): unica via de escritura (SECURITY DEFINER). Valida DOS cosas
-- que jamas confia al cliente: (a) que quien llama sea owner/gm de ESE hotel (mismo
-- criterio de administracion que el resto del modulo), y (b) que `_staff_user_id`
-- pertenezca de verdad al `hotel_staff` de `_hotel_id` -- sin esto, un owner de un hotel
-- podria programar un "horario" para un empleado de otro hotel/organizacion.
create or replace function public.upsert_staff_schedule(
  _hotel_id uuid,
  _staff_user_id uuid,
  _work_date date,
  _scheduled_start timestamptz,
  _scheduled_end timestamptz,
  _authorized_overtime_minutes integer default 0
)
returns public.staff_schedule
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff_schedule;
begin
  if not public.has_hotel_role(_hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'rol_no_autorizado: solo owner/gm puede programar horarios de asistencia' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.hotel_staff where hotel_id = _hotel_id and user_id = _staff_user_id
  ) then
    raise exception 'staff_no_pertenece_al_hotel: el empleado no pertenece a este hotel' using errcode = 'P0001';
  end if;

  if _scheduled_end <= _scheduled_start then
    raise exception 'rango_invalido: scheduled_end debe ser posterior a scheduled_start' using errcode = 'P0001';
  end if;

  if coalesce(_authorized_overtime_minutes, 0) < 0 then
    raise exception 'overtime_invalido: authorized_overtime_minutes no puede ser negativo' using errcode = 'P0001';
  end if;

  insert into public.staff_schedule (
    hotel_id, staff_user_id, work_date, scheduled_start, scheduled_end, authorized_overtime_minutes, created_by
  )
  values (
    _hotel_id, _staff_user_id, _work_date, _scheduled_start, _scheduled_end,
    coalesce(_authorized_overtime_minutes, 0), auth.uid()
  )
  on conflict (hotel_id, staff_user_id, work_date)
  do update set
    scheduled_start = excluded.scheduled_start,
    scheduled_end = excluded.scheduled_end,
    authorized_overtime_minutes = excluded.authorized_overtime_minutes,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.upsert_staff_schedule(uuid, uuid, date, timestamptz, timestamptz, integer) from public;
grant execute on function public.upsert_staff_schedule(uuid, uuid, date, timestamptz, timestamptz, integer)
  to atiende_app, authenticated;

alter table public.staff_schedule enable row level security;
-- SELECT: el propio empleado ve su horario; owner/gm (administracion) ven el de
-- cualquiera del hotel. Mismo criterio de privacidad que attendance_log (0091): datos de
-- jornada laboral individual, no "transparencia total" como audit_log/agent_run.
create policy "staff_schedule_self_or_admin_select" on public.staff_schedule for select to authenticated
  using (
    staff_user_id = auth.uid()
    or public.has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- upsert_staff_schedule() (SECURITY DEFINER); no hay borrado (un turno reprogramado se
-- sobrescribe via upsert, nunca desaparece sin dejar el valor previo visible en el propio
-- upsert -- si se necesitara historial de reprogramaciones, seria un modulo aparte).

grant select on public.staff_schedule to authenticated;

-- ==== 0091_attendance_log.sql ====
-- REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): checador/registro de asistencia
-- INALTERABLE (append-only) y exportable a STPS. Mismo patron append-only + hash
-- encadenado con "cabeza de cadena" bloqueada por FOR UPDATE que audit_log
-- (0008/0012/0015) -- se aplica aqui la version YA CORREGIDA desde el inicio (0015
-- documenta por que un simple `order by ... desc limit 1`, o incluso un advisory lock
-- por si solo, bifurca la cadena bajo escritura concurrente real).
--
-- La cadena se encadena POR EMPLEADO (staff_user_id), no por tenant/hotel: un checador
-- real es, por diseno, el historial propio de cada trabajador ante la autoridad laboral
-- (la inspeccion de la STPS es "el registro de ESTE trabajador"), y encadenar por
-- empleado evita que la escritura concurrente de decenas de empleados de un mismo hotel
-- compita por una sola cabeza de cadena sin necesidad -- la garantia de inmutabilidad en
-- si es por FILA (el trigger de bloqueo de abajo), no por el alcance de la cadena.
create type public.attendance_event_type as enum ('entrada', 'salida');

create table public.attendance_log (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotel(id) on delete restrict,
  staff_user_id uuid not null references public.staff_user(id) on delete restrict,
  event_type public.attendance_event_type not null,
  recorded_at timestamptz not null default now(),
  source text not null default 'app',
  note text,
  seq bigint generated always as identity,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
create unique index attendance_log_seq_idx on public.attendance_log (seq);
create index attendance_log_staff_seq_idx on public.attendance_log (staff_user_id, seq);
create index attendance_log_hotel_recorded_idx on public.attendance_log (hotel_id, recorded_at);

-- Cabeza de cadena por empleado, bloqueada con FOR UPDATE dentro del trigger -- ver
-- 0015_audit_log_advisory_lock.sql para el razonamiento completo de por que esto (y no
-- un `order by seq desc limit 1` ni un advisory lock aislado) es lo unico que no
-- bifurca la cadena bajo escritura concurrente real.
create table public.attendance_log_chain_head (
  staff_user_id uuid primary key references public.staff_user(id) on delete cascade,
  hash text
);
revoke all on public.attendance_log_chain_head from public;
alter table public.attendance_log_chain_head enable row level security;
-- Sin ninguna policy: `authenticated` queda sin SELECT/INSERT/UPDATE/DELETE directo,
-- solo el trigger de abajo (corre con el privilegio de quien define la funcion via
-- SECURITY DEFINER de record_attendance_event) la toca.

create or replace function public.attendance_log_set_hash()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
  v_recorded_at timestamptz;
  v_canonical text;
begin
  insert into public.attendance_log_chain_head (staff_user_id, hash)
  values (new.staff_user_id, null)
  on conflict (staff_user_id) do nothing;

  select hash into v_prev_hash
  from public.attendance_log_chain_head
  where staff_user_id = new.staff_user_id
  for update;

  v_recorded_at := coalesce(new.recorded_at, now());

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.hotel_id::text
    || '|' || new.staff_user_id::text
    || '|' || new.event_type::text
    || '|' || v_recorded_at::text
    || '|' || new.source
    || '|' || coalesce(new.note, '');

  new.prev_hash := v_prev_hash;
  new.recorded_at := v_recorded_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  update public.attendance_log_chain_head set hash = new.hash where staff_user_id = new.staff_user_id;

  return new;
end;
$$;

create trigger attendance_log_set_hash_trg
  before insert on public.attendance_log
  for each row execute function public.attendance_log_set_hash();

create or replace function public.attendance_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'attendance_log_append_only: % no esta permitido sobre attendance_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger attendance_log_block_update_trg
  before update on public.attendance_log
  for each row execute function public.attendance_log_block_mutation();

create trigger attendance_log_block_delete_trg
  before delete on public.attendance_log
  for each row execute function public.attendance_log_block_mutation();

-- record_attendance_event(): unica via de insercion (SECURITY DEFINER). SIEMPRE registra
-- al propio `auth.uid()` como `staff_user_id` -- nunca un id que el cliente pudiera
-- mandar en el body -- checador de autoservicio: nadie puede fichar la entrada/salida de
-- OTRO empleado, cerrando por diseno el vector de fraude mas comun de un checador (un
-- companero marca la asistencia de quien todavia no ha llegado).
create or replace function public.record_attendance_event(
  _hotel_id uuid,
  _event_type public.attendance_event_type,
  _source text default 'app',
  _note text default null
)
returns public.attendance_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.attendance_log;
begin
  if not public.is_hotel_staff(_hotel_id) then
    raise exception 'hotel_no_autorizado: no perteneces al staff de este hotel' using errcode = '42501';
  end if;

  insert into public.attendance_log (hotel_id, staff_user_id, event_type, source, note)
  values (_hotel_id, auth.uid(), _event_type, coalesce(nullif(trim(_source), ''), 'app'), _note)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_attendance_event(uuid, public.attendance_event_type, text, text) from public;
grant execute on function public.record_attendance_event(uuid, public.attendance_event_type, text, text)
  to atiende_app, authenticated;

alter table public.attendance_log enable row level security;
-- SELECT: el propio empleado ve su historial; owner/gm (los responsables ante una
-- inspeccion de la STPS) ven el de cualquiera del hotel. A diferencia de audit_log
-- (transparencia total intra-hotel) esto es dato personal de jornada laboral, con el
-- mismo criterio de minimizacion que boveda_identidad/consentimiento (0068).
create policy "attendance_log_self_or_admin_select" on public.attendance_log for select to authenticated
  using (
    staff_user_id = auth.uid()
    or public.has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
-- Sin policy de insert/update/delete para `authenticated`: unica via es
-- record_attendance_event() (SECURITY DEFINER); UPDATE/DELETE ademas bloqueados por
-- trigger para CUALQUIER rol, incluido el dueno de la migracion (defensa en profundidad,
-- mismo criterio que audit_log/0008) -- esto es lo que hace el registro "inalterable"
-- exigido por LFT art.132 fr.XXXIV, no solo la ausencia de una policy de escritura.

grant select on public.attendance_log to authenticated;

-- ==== 0095_fraude_alerta.sql ====
-- H16-014 · REQ-REC-014 (P1/SEG): tabla de alertas de fraude interno detectado
-- cruzando PMS (folio/charge/payment/audit_log, ya reales en este esquema) + POS
-- (F&B -- insumo explícito de quien escanea, sin integración POS real todavía,
-- ADR-007/0031_night_audit.sql "sin_pos_configurado"). Cuatro patrones
-- (public.fraud_pattern, espejo de packages/domain-hotel/src/fraude/deteccion.ts):
-- descuentos fuera de política, folios reabiertos después de auditado, cargos F&B no
-- posteados, reembolsos a una tarjeta distinta de la del cargo. Expand-only sobre el
-- esquema existente (REQ-GOB-011): ninguna migración ya aplicada se edita.

create type public.fraud_pattern as enum (
  'descuento_fuera_de_politica',
  'folio_reabierto_post_auditoria',
  'cargo_fnb_no_posteado',
  'reembolso_tarjeta_distinta'
);

create table public.fraud_alert (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  pattern public.fraud_pattern not null,
  folio_id uuid references public.folio(id) on delete set null,
  charge_id uuid references public.charge(id) on delete set null,
  payment_id uuid references public.payment(id) on delete set null,
  severity text not null default 'alta' check (severity in ('alta')),
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  -- Lista de public.hotel_role destinatarios (REQ-REC-014: "alerta al destinatario
  -- correspondiente"). Se guarda como jsonb (no como `public.hotel_role[]`) a
  -- propósito: este esquema no tiene NINGUNA otra columna de tipo arreglo, y ADR-003
  -- ya documentó que no todo comportamiento de Postgres es idéntico entre PGlite y
  -- embedded-postgres (ver comentario de 0001 sobre pgcrypto) -- jsonb vía
  -- `JSON.stringify` es el mismo patrón, ya probado, que usa `payload`/`evidence` en
  -- audit_log/outbox, sin introducir una superficie nueva sin precedente.
  recipient_roles jsonb not null default '[]'::jsonb,
  -- Clave determinista de idempotencia de escaneo (deteccion.ts, `dedupeKey`):
  -- re-escanear los mismos datos NUNCA duplica la alerta ya generada.
  dedupe_key text not null,
  created_at timestamptz not null default now()
);
create unique index fraud_alert_dedupe_idx on public.fraud_alert (hotel_id, dedupe_key);
create index fraud_alert_tenant_hotel_created_idx on public.fraud_alert (tenant_id, hotel_id, created_at desc);

alter table public.fraud_alert enable row level security;

-- Solo owner/gm/accountant ven TODAS las alertas de fraude (son quienes responden por
-- fraude interno frente al dueño del hotel, mismo criterio que `NIGHT_AUDIT_ROLES` de
-- routes/night-audit.ts); fnb ve además las de su propio patrón operativo
-- (`cargo_fnb_no_posteado`) -- el mismo criterio de "destinatario correspondiente"
-- que exige REQ-REC-014 se aplica aquí también como control de acceso, no solo como
-- enrutamiento de notificación.
create policy "fraud_alert_select" on public.fraud_alert for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and (
      has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
      or (pattern = 'cargo_fnb_no_posteado' and has_hotel_role(hotel_id, array['fnb']::public.hotel_role[]))
    )
  );
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- record_fraud_alert() (SECURITY DEFINER), mismo patrón que record_audit_log (0008) --
-- append-only, ni siquiera el dueño de la fila puede editarla/borrarla directo.

grant select on public.fraud_alert to authenticated;

-- record_fraud_alert(): valida al actor real (cuando existe sesión) contra su propia
-- membresía de tenant/hotel ANTES de insertar -- mismo arreglo que record_audit_log()
-- ya tiene desde 0016 (el CRÍTICO original ahí era exactamente un SECURITY DEFINER
-- que permitía falsificar filas de OTRA organización). `on conflict` sobre
-- `fraud_alert_dedupe_idx`: un re-escaneo del mismo hallazgo NUNCA inserta una
-- segunda fila -- el llamador usa `is_new` para decidir si además despacha una
-- notificación nueva (nunca reenvía la misma alerta dos veces).
create or replace function public.record_fraud_alert(
  _tenant_id uuid,
  _hotel_id uuid,
  _pattern public.fraud_pattern,
  _folio_id uuid,
  _charge_id uuid,
  _payment_id uuid,
  _reason text,
  _evidence jsonb,
  _recipient_roles jsonb,
  _dedupe_key text
)
returns table (id uuid, is_new boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_id uuid;
begin
  v_actor := auth.uid();
  if v_actor is not null then
    if _tenant_id is null or not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (record_fraud_alert)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if _hotel_id is null or not (_hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (record_fraud_alert)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  insert into public.fraud_alert
    (tenant_id, hotel_id, pattern, folio_id, charge_id, payment_id, reason, evidence, recipient_roles, dedupe_key)
  values
    (_tenant_id, _hotel_id, _pattern, _folio_id, _charge_id, _payment_id, _reason, _evidence, _recipient_roles, _dedupe_key)
  on conflict (hotel_id, dedupe_key) do nothing
  returning fraud_alert.id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;

  select fa.id into v_id from public.fraud_alert fa where fa.hotel_id = _hotel_id and fa.dedupe_key = _dedupe_key;
  return query select v_id, false;
end;
$$;

revoke all on function public.record_fraud_alert(uuid, uuid, public.fraud_pattern, uuid, uuid, uuid, text, jsonb, jsonb, text) from public;
grant execute on function public.record_fraud_alert(uuid, uuid, public.fraud_pattern, uuid, uuid, uuid, text, jsonb, jsonb, text) to atiende_app, authenticated;

-- ==== 0096_waitlist.sql ====
-- REQ-RES-006/H01-010,H02-011 (P1/F): lista de espera automática -- cuando una
-- cancelación libera inventario, el sistema ofrece esa habitación al PRIMER contacto
-- en cola (FIFO por `created_at`), al precio directo (canal 'directo', SIN comisión de
-- OTA -- mismo criterio ya documentado en routes/reservas.ts sobre `channel`: hoy
-- siempre vale 'directo', ninguna variedad de canal externo se simula en H4).
--
-- La oferta NO reserva automáticamente la habitación: queda en estado 'ofertada' con
-- una ventana de expiración (`offer_expires_at`, ver
-- domain-hotel/src/reservas/waitlist.ts `WAITLIST_OFFER_WINDOW_HOURS`) -- el huésped
-- debe confirmarla (POST .../aceptar, apps/api/src/routes/listaEspera.ts) antes de que
-- se cree la reserva real. Si expira o el staff la retira, el contacto NUNCA vuelve a
-- 'esperando' automáticamente (se documenta como decisión deliberada: un contacto que
-- ya recibió su turno y no respondió no debe bloquear indefinidamente a los demás en
-- una futura cancelación que vuelva a coincidir) -- fuera de alcance de H4: reintentar
-- notificación o reinscripción manual del mismo contacto.
create table public.hotel_waitlist_entry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_type_id uuid not null references public.room_type(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  check_in_date date not null,
  check_out_date date not null,
  status text not null default 'esperando'
    check (status in ('esperando', 'ofertada', 'expirada', 'confirmada', 'cancelada')),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  -- Precio directo cotizado en el momento de la oferta (mismo motor que
  -- `quoteNetAmount()` usa para crear cualquier reserva directa) -- se congela aquí en
  -- vez de recalcularse al aceptar para que una tarifa que cambie ENTRE la oferta y la
  -- aceptación nunca le cobre al contacto un monto distinto del que se le ofreció.
  offer_amount numeric(12, 2),
  reservation_id uuid references public.reservation(id) on delete set null,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out_date > check_in_date),
  -- Implicación en UN SOLO sentido a propósito (nunca equivalencia): una vez que una
  -- fila pasó por 'ofertada', `offered_at`/`offer_expires_at`/`offer_amount` quedan
  -- como evidencia histórica de esa oferta aunque el estado avance después a
  -- 'confirmada'/'expirada' — exigir aquí que esos campos se limpien al salir de
  -- 'ofertada' destruiría esa evidencia sin ganar nada (a diferencia del check de
  -- `reservation_id` de abajo, que SÍ es una equivalencia real: nunca hay una razón
  -- legítima para que `reservation_id` quede huérfano de un estado que no sea
  -- 'confirmada').
  check (status <> 'ofertada' or (offered_at is not null and offer_expires_at is not null and offer_amount is not null)),
  check ((status = 'confirmada') = (reservation_id is not null))
);

-- Índice de cola: toda consulta real (¿quién sigue de FIFO para este room_type +
-- rango de fechas?) filtra por estos 5 campos y ordena por `created_at` -- ver
-- apps/api/src/pms/waitlistOffer.ts.
create index hotel_waitlist_entry_queue_idx on public.hotel_waitlist_entry
  (hotel_id, room_type_id, check_in_date, check_out_date, status, created_at);
create index hotel_waitlist_entry_tenant_hotel_idx on public.hotel_waitlist_entry (tenant_id, hotel_id);
create index hotel_waitlist_entry_guest_idx on public.hotel_waitlist_entry (guest_id);

alter table public.hotel_waitlist_entry enable row level security;

-- Mismos roles que ya gestionan reservaciones (`MANAGE_RESERVATIONS_ROLES` en
-- apps/api/src/domain/roles.ts): inscribir/ver/ofertar/aceptar una lista de espera es
-- una operación de reservaciones, no de housekeeping/mantenimiento/F&B/contabilidad.
create policy "hotel_waitlist_entry_staff_select" on public.hotel_waitlist_entry for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );

create policy "hotel_waitlist_entry_staff_insert" on public.hotel_waitlist_entry for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );

-- UPDATE cubre TANTO la oferta automática disparada por una cancelación (marca
-- 'ofertada' bajo la sesión del staff que canceló) COMO la aceptación/expiración
-- manual -- ambas corren bajo un rol de reservaciones ya autenticado, nunca bajo el
-- huésped directamente (H4 no tiene sesión de huésped real, mismo criterio que
-- `cancel_reservation_public` para la cancelación pública).
create policy "hotel_waitlist_entry_staff_update" on public.hotel_waitlist_entry for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));

create policy "hotel_waitlist_entry_manager_delete" on public.hotel_waitlist_entry for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.hotel_waitlist_entry to authenticated;

-- ==== 0097_guest_review_reputacion.sql ====
-- REQ-CRM-002 (P1/F): clasificación automática de reseñas/encuestas por tema y
-- sentimiento, disparando la acción correspondiente (ticket, mensaje proactivo,
-- compensación reglada). Confirmado por grep antes de esta migración: no existía
-- ninguna tabla de reseñas/encuestas en este esquema (REQ-CRM-001, el inbox real de
-- Google/Booking/TripAdvisor, sigue "pendiente-credenciales" -- esta tabla NO asume
-- esa integración: `source`/`external_id` quedan listos para cuando exista, pero hoy
-- se alimenta típicamente de una encuesta propia capturada por el staff, ADR-007).
--
-- Dos tablas:
--   `guest_review`        -- la reseña/encuesta + su clasificación (temas/sentimiento).
--   `guest_review_action` -- cada acción que la clasificación disparó. El ticket de
--                            mantenimiento SÍ se ejecuta de inmediato (no depende de
--                            ninguna integración externa, `createMaintenanceTicketTool`
--                            ya existe); mensaje proactivo y compensación reglada
--                            quedan en `status='pendiente'` para ejecución HUMANA --
--                            enviar un WhatsApp real requiere una plantilla aprobada de
--                            Meta (ADR-007, ver messagingTools.ts) y aplicar una
--                            compensación mueve dinero (GOB-026: SIEMPRE aprobación
--                            humana) -- ninguna de las dos cosas es un problema de
--                            credenciales de ESTE requisito, por eso su dependencia en
--                            REQUISITOS.md es "ninguna": la clasificación + la creación
--                            del registro de la acción correcta no necesitan nada más.
-- Expand-only sobre el esquema existente (REQ-GOB-011): ninguna migración ya aplicada
-- se edita.

create type public.guest_review_source as enum ('google', 'booking', 'tripadvisor', 'expedia', 'encuesta_propia', 'otro');
create type public.guest_review_sentiment as enum ('muy_negativo', 'negativo', 'neutral', 'positivo', 'muy_positivo');
create type public.guest_review_stay_state as enum ('en_estancia', 'post_estancia', 'desconocido');

create table public.guest_review (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- `on delete set null`: si el huésped se borra (privacidad/ARCO, REQ-REC-011) la
  -- reseña YA CLASIFICADA se conserva (evidencia de la acción disparada), pierde solo
  -- el enlace directo a la identidad -- mismo criterio que `maintenance_ticket.created_by`.
  guest_id uuid references public.guest(id) on delete set null,
  folio_id uuid references public.folio(id) on delete set null,
  source public.guest_review_source not null,
  -- Id de la reseña en la plataforma de origen (Google/Booking/...) -- NULL para una
  -- encuesta propia capturada directamente (no tiene un id externo que deduplicar).
  external_id text,
  texto text not null check (char_length(texto) between 1 and 4000),
  idioma text not null default 'es',
  calificacion smallint check (calificacion between 1 and 5),
  stay_state public.guest_review_stay_state not null default 'desconocido',
  is_public boolean not null default true,
  -- Salida de `detectarTemas()` (packages/domain-hotel): [{topic, esConocido, menciones, palabrasClave}].
  topics jsonb not null default '[]'::jsonb,
  sentiment public.guest_review_sentiment not null,
  sentiment_score numeric(5, 3) not null check (sentiment_score between -1 and 1),
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
-- Idempotencia de ingesta por plataforma: la MISMA reseña externa nunca se clasifica
-- ni se dispara dos veces para el mismo hotel (parcial: una encuesta propia sin
-- `external_id` no tiene con qué deduplicar, cada envío es una fila nueva a propósito).
create unique index guest_review_source_external_idx
  on public.guest_review (hotel_id, source, external_id)
  where external_id is not null;
create index guest_review_tenant_hotel_created_idx on public.guest_review (tenant_id, hotel_id, created_at desc);
create index guest_review_guest_idx on public.guest_review (guest_id) where guest_id is not null;

alter table public.guest_review enable row level security;

-- Quién captura/clasifica una reseña y quién puede verla: owner/gm siempre (dueños del
-- resultado del negocio), frontdesk/reservations porque son quienes hoy capturan una
-- encuesta propia en el mostrador o por WhatsApp -- mismo subconjunto de
-- MANAGE_RESERVATIONS_ROLES (apps/api/src/domain/roles.ts) que ya gestiona al huésped.
create policy "guest_review_select" on public.guest_review for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations', 'accountant']::public.hotel_role[])
  );
create policy "guest_review_insert" on public.guest_review for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
-- Sin policy de update/delete para `authenticated`: una clasificación ya hecha es
-- append-only (mismo criterio que fraud_alert/audit_log) -- re-clasificar significa
-- insertar una fila nueva, nunca editar la de antes.

grant select, insert on public.guest_review to authenticated;

create type public.guest_review_action_type as enum ('ticket_mantenimiento', 'mensaje_proactivo', 'compensacion_reglada');
create type public.guest_review_action_status as enum ('pendiente', 'ejecutada', 'descartada');

create table public.guest_review_action (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  review_id uuid not null references public.guest_review(id) on delete cascade,
  action_type public.guest_review_action_type not null,
  status public.guest_review_action_status not null default 'pendiente',
  -- Solo poblado cuando `action_type = 'ticket_mantenimiento'` (el único caso que se
  -- ejecuta de inmediato, ver comentario de archivo) -- referencia al ticket real ya
  -- creado en `maintenance_ticket` por el mismo request que clasificó la reseña.
  ticket_id uuid references public.maintenance_ticket(id) on delete set null,
  -- Para 'mensaje_proactivo': {mensajeSugerido}. Para 'compensacion_reglada':
  -- {tema, compensacion:{tipo,valor,unidad}}. Estructura de `AccionReputacion`
  -- (packages/domain-hotel/src/reputacion/clasificador.ts), guardada tal cual.
  detail jsonb not null default '{}'::jsonb,
  reason text not null,
  resolved_by uuid references public.staff_user(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index guest_review_action_review_idx on public.guest_review_action (review_id);
create index guest_review_action_tenant_hotel_status_idx
  on public.guest_review_action (tenant_id, hotel_id, status);

alter table public.guest_review_action enable row level security;

-- Mismos roles que ven la reseña de origen pueden ver y resolver (marcar
-- ejecutada/descartada) la acción pendiente -- accountant se agrega explícitamente en
-- el UPDATE porque `compensacion_reglada` es dinero, mismo criterio que
-- `NIGHT_AUDIT_ROLES`/`FRAUD_SCAN_ROLES` en sus respectivas rutas.
create policy "guest_review_action_select" on public.guest_review_action for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations', 'accountant']::public.hotel_role[])
  );
create policy "guest_review_action_insert" on public.guest_review_action for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "guest_review_action_update" on public.guest_review_action for update to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  )
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  );

grant select, insert, update on public.guest_review_action to authenticated;

-- ==== 0098_guest_ticket_sla_escalacion.sql ====
-- REQ-HUE-014 (docs/REQUISITOS.md/docs/ACEPTACION.md): "Cada mensaje/petición del
-- huésped debe convertirse en un ticket con departamento, habitación, prioridad y SLA
-- [...]; un ticket sin cierre dentro del SLA debe escalar automáticamente."
--
-- `guest_ticket` es una tabla NUEVA y separada de `maintenance_ticket` (0043) y
-- `housekeeping_task` (0041) a propósito: esas dos ya cubren el flujo OPERATIVO
-- especializado de sus propios REQ (costo/aprobación de mantenimiento REQ-HK-011,
-- checklist/inspección de camarista REQ-HK-001) y esta migración no las toca. Este
-- `guest_ticket` es la capa de TRIAGE genérica que exige REQ-HUE-014: registra que un
-- mensaje/petición del huésped (por CUALQUIER canal -- WhatsApp/voz cuando exista esa
-- credencial, QR/formulario propio o transcripción de staff hoy) se convirtió en un
-- ticket con departamento/habitación/prioridad/SLA, y quién debe atenderlo.
--
-- `department` reutiliza `public.hotel_role` (REQ-TEN-003, "8 roles hoteleros exactos",
-- 0003_membership_and_rls_helpers.sql) en vez de una taxonomía de departamento paralela
-- -- el mismo "modelo de tenencia contradictorio" que docs/auditoria-0/documentos.md ya
-- encontró una vez con una tabla `hotel` duplicada.
--
-- `channel`: 'qr' (formulario/QR en habitación) y 'staff' (recepción transcribe una
-- petición por teléfono/mostrador) son canales REALES verificables hoy sin ninguna
-- credencial externa. 'whatsapp'/'voz' quedan declarados en el enum para cuando el
-- canal conversacional real exista (REQ-HUE-001/002/004, credenciales Meta/Telnyx,
-- "pendiente-credenciales" en docs/TRAZABILIDAD.md) -- ningún código de este pase
-- produce un `guest_ticket.channel` de esos dos valores sin ese canal real conectado; se
-- documentan de antemano para no requerir otra migración destructiva el día que el canal
-- exista (expand-only, ADR-008).
create type public.guest_ticket_priority as enum ('alta', 'media', 'baja');
create type public.guest_ticket_status as enum ('abierto', 'en_progreso', 'cerrado', 'escalado', 'cancelado');
create type public.guest_ticket_channel as enum ('qr', 'staff', 'whatsapp', 'voz');

create table public.guest_ticket (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid references public.room(id) on delete set null,
  department public.hotel_role not null,
  priority public.guest_ticket_priority not null default 'media',
  status public.guest_ticket_status not null default 'abierto',
  channel public.guest_ticket_channel not null default 'staff',
  guest_message text not null,
  -- SLA resuelto y congelado AL CREAR el ticket (packages/domain-hotel/src/tickets/
  -- slaPolicy.ts::resolveSlaMinutes/computeSlaDueAt) -- cambiar despues la politica de
  -- `ticket_sla_policy` nunca mueve el vencimiento de un ticket ya abierto, solo el de
  -- los que se creen despues (mismo criterio que una tarifa ya cotizada no cambia sola).
  sla_minutes integer not null check (sla_minutes > 0),
  sla_due_at timestamptz not null,
  assigned_to uuid references public.staff_user(id) on delete set null,
  escalated_at timestamptz,
  -- Roles destinatarios de la escalacion (mismo patron `recipient_roles` jsonb que
  -- `fraud_alert`, 0095_fraude_alerta.sql, en vez de public.hotel_role[] -- ADR-003
  -- documenta que no todo comportamiento de Postgres es identico entre PGlite y
  -- embedded-postgres, y este esquema ya usa jsonb para listas de roles en todos lados).
  escalated_to_roles jsonb not null default '[]'::jsonb,
  resolution_note text,
  closed_at timestamptz,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_ticket_closed_at_coherente check (
    (status in ('cerrado', 'cancelado') and closed_at is not null)
    or (status not in ('cerrado', 'cancelado') and closed_at is null)
  ),
  constraint guest_ticket_escalated_at_coherente check (
    (status = 'escalado') = (escalated_at is not null)
  )
);
create index guest_ticket_tenant_hotel_idx on public.guest_ticket (tenant_id, hotel_id);
create index guest_ticket_room_idx on public.guest_ticket (room_id) where room_id is not null;
-- Escaneo de escalacion (apps/api/src/jobs/ticketEscalation.ts): tickets ABIERTOS cuyo
-- SLA ya vencio -- parcial sobre `status` para no escanear cerrados/cancelados/ya
-- escalados en cada corrida del planificador.
create index guest_ticket_open_sla_idx on public.guest_ticket (hotel_id, sla_due_at)
  where status in ('abierto', 'en_progreso');

alter table public.guest_ticket enable row level security;

-- Mismo criterio que `maintenance_ticket` (0043): owner/gm/frontdesk ven/administran
-- TODOS los tickets del hotel (son quienes reciben la peticion del huesped primero);
-- el departamento asignado ve/gestiona los suyos; quien reporto (created_by, tipicamente
-- quien atendio al huesped) puede seguir SU PROPIO reporte -- sin esta ultima clausula,
-- un INSERT ... RETURNING desde un rol que solo reporta (p.ej. housekeeping reportando
-- un ticket de fnb) se rechazaria por RLS al validar la fila resultante contra la policy
-- de SELECT (comprobado empiricamente en 0043, mismo comentario alli).
create policy "guest_ticket_scope_select" on public.guest_ticket for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and (
      has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
      or has_hotel_role(hotel_id, array[department])
      or created_by = auth.uid()
    )
  );
-- Cualquier miembro del staff del hotel puede REGISTRAR un ticket a partir de una
-- peticion de huesped (REQ-HUE-014: "cada mensaje/peticion"), sin importar su propio rol
-- -- quien contesta el QR de la habitacion 204 puede ser cualquier departamento.
create policy "guest_ticket_staff_insert" on public.guest_ticket for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant']::public.hotel_role[]
    )
  );
-- UPDATE (incluye cierre/reasignacion/escalacion manual): owner/gm/frontdesk de
-- cualquier ticket del hotel, o el departamento asignado del suyo propio. La escalacion
-- AUTOMATICA por SLA (apps/api/src/jobs/ticketEscalation.ts) corre sobre la conexion
-- admin del proceso (superusuario, igual que night audit/purgas), no bajo esta policy.
create policy "guest_ticket_scope_update" on public.guest_ticket for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
    or has_hotel_role(hotel_id, array[department])
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
    or has_hotel_role(hotel_id, array[department])
  );
create policy "guest_ticket_manager_delete" on public.guest_ticket for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.guest_ticket to authenticated;

-- Politica de SLA CONFIGURABLE por hotel (REQ-HUE-014: "SLA configurado"): una fila por
-- (hotel, departamento, prioridad) que sobreescribe
-- `DEFAULT_SLA_MINUTES_BY_PRIORITY` de packages/domain-hotel/src/tickets/slaPolicy.ts
-- cuando existe. Sin fila -> se usa el default por prioridad (documentado como
-- placeholder de negocio en ese archivo, igual que otros defaults de este esquema).
create table public.ticket_sla_policy (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  department public.hotel_role not null,
  priority public.guest_ticket_priority not null,
  sla_minutes integer not null check (sla_minutes > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, department, priority)
);
create index ticket_sla_policy_hotel_idx on public.ticket_sla_policy (hotel_id);

alter table public.ticket_sla_policy enable row level security;

-- Solo owner/gm ESCRIBEN el SLA del hotel, pero CUALQUIER staff que pueda crear un
-- `guest_ticket` (guest_ticket_staff_insert, arriba) necesita LEER esta tabla -- es
-- justo lo que `crear_ticket_huesped` (packages/agent-core/src/tools/ticketTools.ts)
-- consulta para resolver el SLA a congelar en el ticket que esa MISMA persona está
-- creando. Restringir el SELECT a owner/gm únicamente rompía la resolución de SLA
-- configurado para cualquier ticket creado por otro rol (detectado por
-- tests/integration/tickets/sla-escalado.spec.ts: el SLA configurado se ignoraba en
-- silencio y siempre caía al default). No es dato sensible (solo minutos por
-- departamento/prioridad), así que ampliar el SELECT no expone nada que ese staff no
-- pueda ya inferir de sus propios tickets.
create policy "ticket_sla_policy_staff_select" on public.ticket_sla_policy for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant']::public.hotel_role[]
    )
  );
create policy "ticket_sla_policy_manager_insert" on public.ticket_sla_policy for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "ticket_sla_policy_manager_update" on public.ticket_sla_policy for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "ticket_sla_policy_manager_delete" on public.ticket_sla_policy for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.ticket_sla_policy to authenticated;

-- ==== 0099_marketing_optin_gate.sql ====
-- REQ-HUE-021/REQ-SEG-007 (P0/GOB): "diferenciar mensajes transaccionales (utility, sin
-- opt-in de marketing requerido) de mensajes de marketing (requieren opt-in explícito,
-- registrado con fecha/canal/texto) antes de cualquier envío promocional."
--
-- La infraestructura de opt-in YA EXISTE desde 0068_consentimiento_y_arco.sql (tabla
-- `consent`, `consent_kind` ya incluye 'marketing', `channel` ya incluye 'whatsapp',
-- `record_consent()` ya persiste fecha=created_at/canal=channel/texto=aviso_version) --
-- ese mismo archivo deja escrito explícitamente que el "bloqueo" en el envío de
-- plantillas de WhatsApp (`packages/agent-core/src/tools/messagingTools.ts`) "pertenece
-- a ese otro lote" y queda `pendiente-coordinacion`. Esta migración es exactamente esa
-- coordinación: solo agrega lo que falta para que la tool de envío pueda CONSULTAR qué
-- plantillas son de marketing (nunca inventa una tabla de consentimiento nueva).
--
-- `marketing_templates` es una lista de permitidos EXPLÍCITA (igual patrón que
-- `transactional_templates`, migración 0044) -- default vacía: ninguna plantilla exige
-- opt-in hasta que el hotel la marque como de marketing. Deny-by-default en la otra
-- dirección (la CONSULTA de opt-in) vive en el código de la tool, no aquí: sin huésped
-- identificado por teléfono, o sin fila `consent` con `granted = true`, se trata como
-- "sin opt-in".
alter table public.hotel_messaging_config
  add column marketing_templates text[] not null default '{}';

comment on column public.hotel_messaging_config.marketing_templates is
  'Plantillas de WhatsApp clasificadas como marketing/promocionales para este hotel (REQ-HUE-021/REQ-SEG-007): enviarlas exige una fila `consent` previa (channel=whatsapp, consent_kind=marketing, granted=true) para el huésped destinatario, o el envío se bloquea (0 mensajes creados). Cualquier plantilla fuera de esta lista se trata como transaccional/utility y nunca requiere opt-in.';

-- Soporta la consulta de opt-in en el camino caliente de cada intento de envío de
-- marketing (join guest.phone -> consent.guest_id, filtrado por hotel/canal/tipo/
-- otorgado) -- mismo criterio de "índice para el patrón de consulta real" que el resto
-- de las migraciones de este repo, no un índice genérico.
create index consent_marketing_optin_idx on public.consent (hotel_id, guest_id, channel, consent_kind)
  where granted = true;

-- ==== 0110_pl_usali.sql ====
-- REQ-BO-010 (P0/BP-024/BP-041/BP-071/H16-016/H16-017/H07-032/H17-002/H04-023): P&L
-- diario/mensual en formato-resumen USALI 12ª edición por departamento, punto de
-- equilibrio dinámico (recalculado con costos/ADR reales), owner's report y
-- proyección de caja a 13 semanas.
--
-- Alcance real de "formato USALI 12ª edición" en este esquema: el Summary Operating
-- Statement (jerarquía Ingresos por departamento -> Utilidad departamental -> Gastos
-- no distribuidos -> GOP -> cuota de administración -> EBITDA -> gastos no operativos
-- -> Utilidad neta), NO los 11 Schedules departamentales completos del manual USALI
-- (eso exigiría un catálogo contable completo fuera de alcance de este sistema hoy).
-- Documentado explícitamente para no sobre-prometer, mismo criterio que
-- `packages/domain-hotel/src/mrz.ts`/0051 documentan sus propios límites.
--
-- Los INGRESOS por departamento YA existen en el esquema (`charge.concept`, 0030):
-- 'hospedaje' -> Rooms, 'ab' -> Food & Beverage, 'extras'/'otro' -> Otros
-- Departamentos Operados, 'ajuste'/'descuento' se atribuyen a Rooms (limitación
-- conocida: la API de folios no registra a qué departamento aplica un descuento/ajuste
-- genérico, ver apps/api/src/domain/plUsali.ts), 'reverso' se resuelve al departamento
-- del cargo original vía `reverses_charge_id`, y 'propina' se EXCLUYE por completo (no
-- es contraprestación del hotel, mismo criterio que `folioEngine.ts` ya aplica para
-- impuestos). Esta migración solo agrega lo que NO existe todavía: el lado de GASTOS
-- reales por departamento -- sin esto, cualquier P&L sería ingresos reales contra
-- costos inventados ("P&L de mentiras"), que es exactamente lo que
-- docs/cierre-p0/inventario.md documentó como la razón de NO implementar antes.
--
-- Expand-only (REQ-GOB-011): ninguna migración ya aplicada se edita.

create type public.usali_department as enum (
  -- Departamentos operados (tienen ingreso propio via charge.concept).
  'rooms',
  'food_beverage',
  'otros_departamentos',
  -- Gastos no distribuidos (Undistributed Operating Expenses, sin ingreso propio).
  'admin_general',
  'ventas_marketing',
  'operacion_mantenimiento',
  'utilities',
  -- Debajo de GOP.
  'cuota_administracion',
  'no_operativo'
);

create type public.usali_expense_category as enum ('costo_ventas', 'nomina', 'otros_gastos');

create table public.expense_entry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  department public.usali_department not null,
  category public.usali_expense_category not null,
  description text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  expense_date date not null,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index expense_entry_hotel_date_idx on public.expense_entry (hotel_id, expense_date);
create index expense_entry_hotel_department_date_idx on public.expense_entry (hotel_id, department, expense_date);

alter table public.expense_entry enable row level security;

-- Ver/registrar el lado de gastos del P&L es más sensible que un cargo de folio
-- (revela costos/nómina/márgenes del negocio, no solo un cobro al huésped) -- por eso
-- NO reutiliza `can_access_money()` (0007, que incluye frontdesk/reservations/fnb),
-- sino un rol propio, mismo criterio de "destinatario correspondiente" que
-- `fraud_alert` (0095) ya aplicó para datos financieros sensibles.
create or replace function public.can_access_pl(_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_hotel_role(_hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
$$;

revoke all on function public.can_access_pl(uuid) from public;
grant execute on function public.can_access_pl(uuid) to atiende_app, authenticated;

create policy "expense_entry_pl_role_select" on public.expense_entry for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_pl(hotel_id));
create policy "expense_entry_pl_role_insert" on public.expense_entry for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and can_access_pl(hotel_id));

-- 0010_grants_and_lockdown.sql revocó TODO privilegio de tabla por default sobre el
-- esquema `public` -- una tabla nueva creada después de esa migración no hereda ningún
-- grant, y la RLS de arriba sola no basta (RLS filtra FILAS, Postgres exige además el
-- privilegio base sobre la TABLA). Mismo patrón que `fraud_alert` (0095) ya aplicó.
grant select, insert on public.expense_entry to authenticated;
-- Sin policy de update/delete: un gasto registrado no se edita ni se borra -- se
-- corrige con una contrapartida nueva (misma disciplina append-only que `charge`,
-- REQ-REC-004), evitando que el P&L de un periodo ya cerrado cambie por debajo del
-- reporte ya emitido al owner.

-- ==== 0111_marketing_template_linter.sql ====
-- REQ-SEG-007 (P0/SEG): "todo mensaje de marketing incluye opción de baja" -- verificado
-- con "mensaje sin opción de baja -> rechazado por el linter de plantillas". La
-- infraestructura de OPT-IN (fecha/canal/texto antes de enviar) ya existe desde la
-- migración 0099 (`marketing_templates`, `isMarketingSendBlocked`, REQ-HUE-021); esta
-- migración agrega lo que faltaba para la segunda mitad del requisito: el TEXTO real de
-- cada plantilla de marketing, para que `lintMarketingTemplateBody()`
-- (packages/domain-hotel) pueda verificar que ese texto incluye una opción de baja
-- explícita ANTES de que la plantilla pueda clasificarse como marketing
-- (`PATCH .../mensajeria/config`, apps/api/src/routes/mensajeria.ts) -- y para que el
-- mensaje REAL que se envía (`createSendWhatsappTemplateTool`/`getMarketingTemplateBody`,
-- packages/agent-core) use ese mismo texto ya verificado como cuerpo persistido, en vez
-- de un resumen genérico que nunca pasó por el linter.
--
-- Clave = nombre de plantilla (mismo valor que un elemento de `marketing_templates`),
-- valor = texto completo que se envía al huésped (incluida la opción de baja). Default
-- vacío: ningún hotel existente queda con una plantilla de marketing "huérfana" de texto
-- por defecto (`marketing_templates` también default vacío desde 0099) -- la ruta de
-- configuración exige y valida el texto de CUALQUIER plantilla nueva que se agregue a
-- `marketing_templates` a partir de esta migración, pero nunca reinterpreta ni rechaza
-- retroactivamente una fila ya existente sin tocarla.
alter table public.hotel_messaging_config
  add column marketing_template_bodies jsonb not null default '{}'::jsonb;

comment on column public.hotel_messaging_config.marketing_template_bodies is
  'Texto real (incluida una opción de baja explícita) de cada plantilla clasificada como marketing en `marketing_templates`, indexado por nombre de plantilla (REQ-SEG-007). `PATCH /mensajeria/config` exige y valida este texto con el linter de plantillas (`lintMarketingTemplateBody`, packages/domain-hotel) antes de permitir que una plantilla se agregue a `marketing_templates`; el envío real (`getMarketingTemplateBody`, packages/agent-core) reutiliza este mismo texto ya verificado como cuerpo del mensaje persistido.';

-- ==== 0112_roi_baseline_cobro_resultado.sql ====
-- REQ-REV-018/REQ-GOB-016 (P0/OBS-GOB, fuentes BP-015/BP-131/BP-171/BP-150/GOB-037/
-- GOB-012/H17-001/H17-002/H02-019/H12-007/H17-003): "El sistema debe registrar, para
-- cada agente/módulo con impacto económico, una línea base firmada en la semana 1 ...;
-- ningún cobro por resultado se activa sin línea base firmada." (BP-015: "Sin línea base
-- firmada por el dueño en la semana 1 no se activa ningún cobro por éxito"; BP-131:
-- "sin línea base no hay cobro por éxito ('medición honesta')").
--
-- `packages/db/migrations/0026_roi_event.sql` YA captura el evento (`monto_verificado`/
-- `monto_estimado`/`metodo_contrafactual`/`confianza`) -- esta migración construye la
-- pieza que 0026 dejó documentada como pendiente ("la lógica de línea base firmada ...
-- queda pendiente de un hito posterior"): (1) `roi_baseline`, el registro en sí de la
-- línea base por (hotel, agente/módulo), con la ventana "semana 1" (7 días desde que el
-- agente/módulo se activó para ese hotel) impuesta por trigger, no por la aplicación; y
-- (2) `cobro_resultado_activacion`, el punto de activación REAL de un cobro por
-- resultado, cuyo trigger rechaza el INSERT si no existe una `roi_baseline` FIRMADA para
-- ese mismo (hotel, agente) -- exactamente el "verificado: intento de cobro sin línea
-- base → bloqueado" que exige `docs/ACEPTACION.md`.
--
-- Defensa en profundidad adicional (BP-150 "todo cambio de precio o de estructura de
-- éxito compartido por hotel requiere decisión reservada al fundador"; GOB-052): activar
-- un cobro por resultado es, por definición, fijar la "estructura de éxito compartido"
-- de ese hotel -- el trigger de `cobro_resultado_activacion` exige ADEMÁS una aprobación
-- vigente del fundador para la categoría `estructura_de_exito_compartido` (catálogo
-- cerrado de 0081), mismo patrón que `0082_revenue_engine_gate.sql` exige
-- `shadow_a_autopilot_revenue` antes de autopilot. Ninguna de las dos condiciones
-- (línea base firmada / aprobación del fundador) sustituye a la otra.
--
-- Mismo criterio de catálogo abierto que `roi_event.tipo_evento` (0026): `agent_name`
-- (aquí también "o módulo", p.ej. un motor determinista como `motor_revenue`, no solo un
-- agente LLM de `agent-core`) y `modelo_cobro` son texto libre, no un enum cerrado -- las
-- fórmulas de valor de H17 siguen evolucionando.

-- 1) Línea base por (hotel, agente/módulo) -----------------------------------------------
create table public.roi_baseline (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  agent_name text not null check (length(trim(agent_name)) > 0),
  -- Qué se mide (p.ej. 'reservas_directas_mensuales', 'kwh_por_habitacion_noche',
  -- 'comisiones_ota_mensuales') -- catálogo abierto, mismo criterio que roi_event.
  metrica text not null check (length(trim(metrica)) > 0),
  valor_base numeric(14, 2) not null check (valor_base >= 0),
  unidad text not null check (length(trim(unidad)) > 0),
  -- Cómo se obtuvo el valor_base (p.ej. "promedio de 12 meses de histórico PMS
  -- importados en onboarding, H18-002") -- texto libre igual que
  -- roi_event.metodo_contrafactual: la metodología debe quedar legible para el dueño,
  -- nunca un código interno opaco.
  metodo_captura text not null check (length(trim(metodo_captura)) > 0),
  periodo_desde date not null,
  periodo_hasta date not null check (periodo_hasta >= periodo_desde),
  -- Momento en que el agente/módulo se activó para este hotel -- inicio del reloj de
  -- "semana 1" que exige BP-015/BP-131. Lo fija la aplicación al crear el borrador
  -- (normalmente "ahora"), nunca se recalcula después.
  activado_en timestamptz not null default now(),
  -- NULL mientras la línea base sigue en borrador (BP-131: "acordada por escrito"). El
  -- trigger de abajo es la única vía real para poblar este campo, y exige que quede
  -- dentro de los 7 días siguientes a `activado_en`.
  firmado_en timestamptz,
  firmado_por uuid references public.staff_user(id),
  notas text,
  created_by uuid references public.staff_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Una línea base vigente por (hotel, agente) -- corregirla tras firmada exige un
  -- registro nuevo (inmutabilidad, ver trigger), no un UPDATE sobre esta fila.
  unique (hotel_id, agent_name),
  check ((firmado_en is null) = (firmado_por is null))
);

create index roi_baseline_hotel_idx on public.roi_baseline (hotel_id);

-- Máquina de estados REAL (borrador -> firmada -> inmutable) -- autoridad del trigger,
-- no de la aplicación, mismo criterio que `revenue_engine_gate_transition_guard`
-- (0082): ninguna sesión (ni owner/gm, que sí puede escribir la fila por RLS) puede
-- firmar fuera de la semana 1 ni modificar una línea base ya firmada escribiendo SQL a
-- mano.
create or replace function public.roi_baseline_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_dias_para_firmar numeric;
begin
  if TG_OP = 'INSERT' then
    new.activado_en := coalesce(new.activado_en, v_now);
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_at := v_now;
    if new.firmado_en is not null then
      -- Comparación truncada a milisegundo: `activado_en` puede llevar precisión de
      -- microsegundo (default `now()` de Postgres) mientras `firmado_en` normalmente
      -- llega como un `Date` de JavaScript (precisión de milisegundo) -- sin este
      -- truncado, firmar en el MISMO instante de la activación podía leerse como "unos
      -- microsegundos antes" y rechazarse por un artefacto de precisión, no por una
      -- violación real de la regla.
      if date_trunc('milliseconds', new.firmado_en) < date_trunc('milliseconds', new.activado_en) then
        raise exception 'firma_anterior_a_activacion: la linea base del agente/modulo "%" no puede firmarse (%) antes de que se activara (%)',
          new.agent_name, new.firmado_en, new.activado_en
          using errcode = 'P0001';
      end if;
      v_dias_para_firmar := extract(epoch from (new.firmado_en - new.activado_en)) / 86400;
      if v_dias_para_firmar > 7 then
        raise exception 'linea_base_fuera_de_semana_1: la linea base del agente/modulo "%" debe firmarse dentro de los primeros 7 dias desde su activacion (REQ-REV-018/BP-015/BP-131), transcurrieron % dias',
          new.agent_name, round(v_dias_para_firmar, 1)
          using errcode = 'P0001';
      end if;
      new.firmado_por := coalesce(new.firmado_por, auth.uid());
    end if;
    return new;
  end if;

  -- TG_OP = 'UPDATE' ---------------------------------------------------------------
  if old.firmado_en is not null then
    -- Ya firmada: inmutable por completo (append-only, mismo criterio que
    -- roi_event/audit_log) -- corregir un dato exige un registro NUEVO, nunca reescribir
    -- el que el dueño ya vio y firmó.
    if new.agent_name is distinct from old.agent_name
      or new.metrica is distinct from old.metrica
      or new.valor_base is distinct from old.valor_base
      or new.unidad is distinct from old.unidad
      or new.metodo_captura is distinct from old.metodo_captura
      or new.periodo_desde is distinct from old.periodo_desde
      or new.periodo_hasta is distinct from old.periodo_hasta
      or new.activado_en is distinct from old.activado_en
      or new.firmado_en is distinct from old.firmado_en
      or new.firmado_por is distinct from old.firmado_por
      or new.notas is distinct from old.notas
    then
      raise exception 'linea_base_firmada_inmutable: la linea base del agente/modulo "%" ya fue firmada el % -- no se puede modificar, un ajuste requiere un registro nuevo',
        old.agent_name, old.firmado_en
        using errcode = 'P0001';
    end if;
    new.updated_at := v_now;
    return new;
  end if;

  -- old.firmado_en IS NULL: sigue en borrador.
  if new.firmado_en is not null then
    -- Acción de FIRMAR: en el MISMO update no se admite cambiar ningún otro campo --
    -- evita "firmar y de paso ajustar la cifra" en una sola sentencia.
    if new.agent_name is distinct from old.agent_name
      or new.metrica is distinct from old.metrica
      or new.valor_base is distinct from old.valor_base
      or new.unidad is distinct from old.unidad
      or new.metodo_captura is distinct from old.metodo_captura
      or new.periodo_desde is distinct from old.periodo_desde
      or new.periodo_hasta is distinct from old.periodo_hasta
      or new.activado_en is distinct from old.activado_en
    then
      raise exception 'no_se_puede_modificar_al_firmar: al firmar la linea base del agente/modulo "%" no se puede cambiar ningun otro campo en el mismo momento -- edita el borrador antes de firmarlo',
        old.agent_name
        using errcode = 'P0001';
    end if;
    -- Comparación truncada a milisegundo: `activado_en` puede llevar precisión de
    -- microsegundo (default `now()` de Postgres) mientras `firmado_en` normalmente
    -- llega como un `Date` de JavaScript (precisión de milisegundo) -- sin este
    -- truncado, firmar en el MISMO instante de la activación podía leerse como "unos
    -- microsegundos antes" y rechazarse por un artefacto de precisión, no por una
    -- violación real de la regla.
    if date_trunc('milliseconds', new.firmado_en) < date_trunc('milliseconds', new.activado_en) then
      raise exception 'firma_anterior_a_activacion: la linea base del agente/modulo "%" no puede firmarse (%) antes de que se activara (%)',
        new.agent_name, new.firmado_en, new.activado_en
        using errcode = 'P0001';
    end if;
    v_dias_para_firmar := extract(epoch from (new.firmado_en - new.activado_en)) / 86400;
    if v_dias_para_firmar > 7 then
      raise exception 'linea_base_fuera_de_semana_1: la linea base del agente/modulo "%" debe firmarse dentro de los primeros 7 dias desde su activacion (REQ-REV-018/BP-015/BP-131), transcurrieron % dias',
        new.agent_name, round(v_dias_para_firmar, 1)
        using errcode = 'P0001';
    end if;
    new.firmado_por := coalesce(new.firmado_por, auth.uid());
  end if;
  new.updated_at := v_now;
  return new;
end;
$$;

create trigger roi_baseline_guard_trg
  before insert or update on public.roi_baseline
  for each row execute function public.roi_baseline_guard();

alter table public.roi_baseline enable row level security;

-- SELECT: transparencia -- cualquier rol de staff del hotel puede ver la línea base
-- vigente y si ya está firmada (mismo criterio que agent_config/roi_event).
create policy "roi_baseline_hotel_select" on public.roi_baseline for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT/UPDATE (crear el borrador y firmarlo) es una decisión de gobierno reservada a
-- owner/gm (mismo nivel que agent_config/revenue_engine_gate) -- el trigger de arriba
-- impone además las condiciones REALES de la ventana de semana 1 e inmutabilidad.
create policy "roi_baseline_manager_insert" on public.roi_baseline for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "roi_baseline_manager_update" on public.roi_baseline for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
-- Sin policy de DELETE: append-only, mismo criterio que roi_event/agent_config.

grant select, insert, update on public.roi_baseline to authenticated;

-- 2) Activación real de un cobro por resultado --------------------------------------------
-- Un registro por (hotel, agente/módulo): el momento en que el hotel empieza a cobrarse
-- por resultado sobre los `roi_event` de ese agente. Append-only (activar es una
-- decisión de un solo sentido en este esquema; desactivar/renegociar queda para un hito
-- posterior, ver comentario de archivo de 0026).
create table public.cobro_resultado_activacion (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  agent_name text not null check (length(trim(agent_name)) > 0),
  -- La línea base concreta que sustenta esta activación -- referencia real, nunca solo
  -- "hubo alguna línea base alguna vez" (evita que una línea base de OTRO agente, o ya
  -- reemplazada, se use para justificar el cobro de este).
  roi_baseline_id uuid not null references public.roi_baseline(id) on delete restrict,
  -- Modelo de cobro (p.ej. 'porcentaje_reservas_directas_incrementales',
  -- 'porcentaje_ahorro_energetico_verificado_ipmvp', 'fijo_por_evento') -- texto libre,
  -- mismo criterio de catálogo abierto que roi_event.tipo_evento (BP-015 cita al menos 3
  -- modelos distintos y en evolución).
  modelo_cobro text not null check (length(trim(modelo_cobro)) > 0),
  activado_por uuid references public.staff_user(id),
  activado_en timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (hotel_id, agent_name)
);

create index cobro_resultado_activacion_hotel_idx on public.cobro_resultado_activacion (hotel_id);

-- El GATE real (REQ-REV-018 + BP-150/GOB-052 en profundidad): rechaza la activación si
-- (a) la línea base referenciada no existe, (b) no corresponde a este mismo
-- hotel/agente, (c) no está firmada, o (d) no hay una aprobación vigente del fundador
-- para `estructura_de_exito_compartido` en este alcance (hotel u org). Ninguna de las
-- dos condiciones de fondo (a-c / d) sustituye a la otra -- mismo espíritu que
-- `revenue_engine_gate_transition_guard` exige backtest Y aprobación del fundador, no
-- solo uno de los dos.
create or replace function public.cobro_resultado_activacion_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_baseline public.roi_baseline%rowtype;
begin
  select * into v_baseline from public.roi_baseline where id = new.roi_baseline_id;

  if v_baseline.id is null then
    raise exception 'linea_base_no_encontrada: el id de linea base % no existe -- no se puede activar cobro por resultado sin una linea base real', new.roi_baseline_id
      using errcode = 'P0001';
  end if;

  if v_baseline.hotel_id <> new.hotel_id or v_baseline.agent_name <> new.agent_name then
    raise exception 'linea_base_no_corresponde: la linea base % pertenece a otro hotel o a otro agente/modulo distinto del que se intenta activar', new.roi_baseline_id
      using errcode = 'P0001';
  end if;

  if v_baseline.firmado_en is null then
    raise exception 'linea_base_no_firmada: no se puede activar cobro por resultado para el agente/modulo "%" -- no existe una linea base FIRMADA para este hotel (REQ-REV-018/BP-015/BP-131: "sin linea base firmada por el dueño en la semana 1 no se activa ningun cobro por exito")',
      new.agent_name
      using errcode = 'P0001';
  end if;

  perform public.require_founder_decision_approval('estructura_de_exito_compartido', new.org_id, new.hotel_id);

  new.activado_por := coalesce(new.activado_por, auth.uid());
  new.activado_en := coalesce(new.activado_en, now());
  return new;
end;
$$;

create trigger cobro_resultado_activacion_guard_trg
  before insert on public.cobro_resultado_activacion
  for each row execute function public.cobro_resultado_activacion_guard();

alter table public.cobro_resultado_activacion enable row level security;

-- SELECT: transparencia, mismo criterio que roi_baseline/roi_event.
create policy "cobro_resultado_activacion_hotel_select" on public.cobro_resultado_activacion for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT: activar un cobro por resultado es, por definición, fijar la "estructura de
-- éxito compartido" del hotel (BP-150) -- reservado a owner/gm para siquiera intentarlo;
-- el trigger de arriba exige además que exista línea base firmada Y aprobación vigente
-- del fundador. Sin policy de UPDATE/DELETE: append-only.
create policy "cobro_resultado_activacion_manager_insert" on public.cobro_resultado_activacion for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert on public.cobro_resultado_activacion to authenticated;

-- ==== 0113_guardrails_conversacionales.sql ====
-- REQ-HUE-023 (P0/SEG): "guardrails de seguridad conversacional: [...] exigir OTP al
-- canal original ante cambios de contacto [...] y no generar notas discriminatorias."
--
-- Dos superficies NUEVAS (confirmado por grep antes de este archivo: ni "cambio de
-- contacto"/"otp" ni ninguna tabla de notas de huésped existían en el repositorio):
--
-- 1) `guest_contact_change_request`: registra una solicitud de cambio de
--    teléfono/correo de un huésped y el ciclo de vida de su verificación por OTP.
--    `otp_sent_to_phone` congela el CANAL ORIGINAL (el `guest.phone` ya registrado
--    ANTES del cambio) en el momento de crear la solicitud -- el OTP SIEMPRE se envía
--    ahí, nunca al valor nuevo solicitado (`requested_value`), sin importar si el campo
--    que se está cambiando es el propio teléfono o el correo. Solo se guarda el HASH
--    del código (mismo esquema `scrypt` que `staff_user.password_hash`, reutilizando
--    `hashPassword`/`verifyPassword` de `@atiende-hoteles/db` desde
--    `apps/api/src/routes/huespedes.ts` -- nunca un segundo esquema de hashing en este
--    repo), nunca el código en texto plano.
--
-- 2) `guest_note`: nota interna asociada a un huésped (p. ej. redactada por el agente
--    conversacional o transcrita por staff) -- `packages/domain-hotel/src/
--    conversationalGuardrails.ts::containsDiscriminatoryContent` se evalúa ANTES de
--    cualquier INSERT en esta tabla (`apps/api/src/routes/huespedes.ts`); una nota que
--    hace match se rechaza por completo (0 filas insertadas), nunca se guarda una
--    versión "suavizada".
create type public.guest_contact_field as enum ('email', 'telefono');
create type public.guest_contact_change_status as enum (
  'pendiente', 'confirmado', 'rechazado_expirado', 'rechazado_intentos_agotados', 'cancelado'
);

create table public.guest_contact_change_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  field public.guest_contact_field not null,
  requested_value text not null,
  -- Canal ORIGINAL (telefono ya registrado ANTES del cambio) al que se envio el OTP --
  -- ver cabecera de este archivo. Nunca nulo: crear la solicitud se rechaza en la app
  -- (no en esta tabla) si el huesped no tiene telefono registrado todavia, porque no
  -- existiria ningun canal original contra el cual verificar (packages/domain-hotel/src/
  -- guestContactChangeOtp.ts documenta la regla; el rechazo real vive en la ruta HTTP,
  -- que es la unica que INSERTa aqui).
  otp_sent_to_phone text not null,
  otp_code_hash text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  status public.guest_contact_change_status not null default 'pendiente',
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  requested_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_contact_change_request_max_attempts_positivo check (max_attempts > 0),
  constraint guest_contact_change_request_attempts_no_negativo check (attempts >= 0)
);
create index guest_contact_change_request_guest_idx on public.guest_contact_change_request (guest_id);
create index guest_contact_change_request_hotel_idx on public.guest_contact_change_request (hotel_id);
-- Consulta de "solicitudes pendientes vencidas" (limpieza/observabilidad futura) --
-- parcial sobre status, mismo criterio que guest_ticket_open_sla_idx (0098).
create index guest_contact_change_request_pendiente_idx on public.guest_contact_change_request (hotel_id, expires_at)
  where status = 'pendiente';

alter table public.guest_contact_change_request enable row level security;

-- Mismo patron de roles que guest_ticket (0098): owner/gm/frontdesk/reservations
-- gestionan cambios de contacto de cualquier huesped del hotel -- son quienes reciben
-- la peticion del huesped (telefono/mostrador/WhatsApp) y la tramitan.
create policy "guest_contact_change_request_scope_select" on public.guest_contact_change_request for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "guest_contact_change_request_scope_insert" on public.guest_contact_change_request for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
-- UPDATE cubre incrementar `attempts` y fijar el `status` final tras cada intento de
-- confirmacion (packages/domain-hotel/src/guestContactChangeOtp.ts::evaluateOtpConfirmation) --
-- mismos roles que pueden verla/crearla.
create policy "guest_contact_change_request_scope_update" on public.guest_contact_change_request for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));

grant select, insert, update on public.guest_contact_change_request to authenticated;

create table public.guest_note (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  body text not null,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index guest_note_guest_idx on public.guest_note (guest_id);
create index guest_note_hotel_idx on public.guest_note (hotel_id);

alter table public.guest_note enable row level security;

-- Mismo patron amplio que guest_ticket_staff_insert (0098): cualquier miembro del staff
-- del hotel puede registrar una nota (quien atiende al huesped puede ser cualquier
-- departamento), pero solo owner/gm/frontdesk/reservations la LEEN de vuelta -- una nota
-- interna sobre un huesped no es informacion operativa de housekeeping/mantenimiento/fnb.
create policy "guest_note_scope_select" on public.guest_note for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "guest_note_staff_insert" on public.guest_note for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant']::public.hotel_role[]
    )
  );
create policy "guest_note_manager_delete" on public.guest_note for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, delete on public.guest_note to authenticated;
