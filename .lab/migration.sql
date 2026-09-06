-- Minimal RLS + tenant isolation experiment, modeled on atiende-restaurantes'
-- supabase/tests/enterprise_tenant_isolation.sql pattern (request.jwt.claim.sub,
-- set local role authenticated, is_staff() security definer helper).

create role authenticated;
create role anon;

create table hotels (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table hotel_staff (
  hotel_id uuid not null references hotels(id),
  user_id uuid not null,
  role text not null,
  primary key (hotel_id, user_id)
);

create table reservations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references hotels(id),
  guest_name text not null,
  idempotency_key text not null,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  unique (hotel_id, idempotency_key)
);

-- security definer helper, same shape as is_restaurant_staff()
create or replace function is_hotel_staff(_user uuid, _hotel uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from hotel_staff
    where user_id = _user and hotel_id = _hotel
  )
$$;

-- trigger: bump version + updated_at on update (concurrency bookkeeping)
create or replace function bump_version()
returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

create trigger reservations_bump_version
  before update on reservations
  for each row execute function bump_version();

alter table hotels enable row level security;
alter table hotel_staff enable row level security;
alter table reservations enable row level security;

create policy "staff can see own hotel" on hotels for select to authenticated
  using (is_hotel_staff(current_setting('request.jwt.claim.sub', true)::uuid, id));

create policy "staff can see own membership" on hotel_staff for select to authenticated
  using (is_hotel_staff(current_setting('request.jwt.claim.sub', true)::uuid, hotel_id));

create policy "tenant staff can see reservations" on reservations for select to authenticated
  using (is_hotel_staff(current_setting('request.jwt.claim.sub', true)::uuid, hotel_id));

create policy "tenant staff can insert reservations" on reservations for insert to authenticated
  with check (is_hotel_staff(current_setting('request.jwt.claim.sub', true)::uuid, hotel_id));

create policy "tenant staff can update reservations" on reservations for update to authenticated
  using (is_hotel_staff(current_setting('request.jwt.claim.sub', true)::uuid, hotel_id))
  with check (is_hotel_staff(current_setting('request.jwt.claim.sub', true)::uuid, hotel_id));

grant select, insert, update on hotels, hotel_staff, reservations to authenticated;
grant usage on schema public to authenticated;

-- idempotent upsert helper exercising ON CONFLICT + advisory lock, mirroring
-- order_idempotency.sql's pattern for safe concurrent order creation.
create or replace function create_reservation_idempotent(
  _hotel uuid, _guest text, _key text
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  _id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(_hotel::text || ':' || _key, 0));
  insert into reservations (hotel_id, guest_name, idempotency_key)
  values (_hotel, _guest, _key)
  on conflict (hotel_id, idempotency_key) do update
    set guest_name = excluded.guest_name
  returning id into _id;
  return _id;
end;
$$;

grant execute on function create_reservation_idempotent(uuid, text, text) to authenticated;

-- seed two tenants
insert into hotels (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Hotel A'),
  ('22222222-2222-2222-2222-222222222222', 'Hotel B');

insert into hotel_staff (hotel_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-00000000000a', 'admin'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-00000000000b', 'admin');

insert into reservations (hotel_id, guest_name, idempotency_key) values
  ('11111111-1111-1111-1111-111111111111', 'Guest A1', 'seed-a-1'),
  ('22222222-2222-2222-2222-222222222222', 'Guest B1', 'seed-b-1');
