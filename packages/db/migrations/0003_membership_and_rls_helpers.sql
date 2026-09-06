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
