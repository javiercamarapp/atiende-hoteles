-- ORIGEN: packages/db/migrations/0002_org_location_hotel.sql sha256:49caa7d5c0aa4092396efd1c2c0007242809041f885923d1d361c5cffd511eae
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

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
