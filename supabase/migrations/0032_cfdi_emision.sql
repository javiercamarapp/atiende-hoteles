-- ORIGEN: packages/db/migrations/0032_cfdi_emision.sql sha256:c6030e9a3e3f35cbb24aff84eea79c6d3cdcededd0b8615b6ccae1c048c3fe7e
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

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
