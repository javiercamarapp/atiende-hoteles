-- ORIGEN: packages/db/migrations/0005_guest.sql sha256:f7d43136aefbb85c3afc639ba9a4579d59701aff98ae68667c771ef27ce94374
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

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
