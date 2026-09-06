-- ORIGEN: packages/db/migrations/0033_calendario_fiscal.sql sha256:9468ddda2c9754cdcc3ad1db6cec721ebbc39ef3fefa4e31a7b874d027f50e9e
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

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
