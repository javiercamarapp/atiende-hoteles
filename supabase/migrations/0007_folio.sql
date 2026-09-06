-- ORIGEN: packages/db/migrations/0007_folio.sql sha256:b8161f9398dcdc85b37825d2e425698653d4e6480150c4b53fd145910b6fad27
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

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
