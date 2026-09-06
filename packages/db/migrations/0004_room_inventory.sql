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
