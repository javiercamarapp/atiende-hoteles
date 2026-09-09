-- REQ-RES-020 (P1/F): registrar y reportar, por reserva, el canal/agente de origen
-- (directo, OTA, agente de IA externo) para atribución de comisión y reporting de
-- room-nights directas. La columna `reservation.channel` (migración 0014) ya existe y
-- hoy siempre vale 'directo' -- REQ-RES-022/REQ-REV-008 (H15-006) prohíben construir
-- conectividad OTA propia durante esta fase, así que ningún escritor de este repo
-- produce todavía un valor distinto. Esta migración solo agrega la tabla de
-- CONFIGURACIÓN de comisión por canal (hotel_channel_commission) para que el reporte
-- de atribución (`GET /hoteles/:hotelId/reportes/atribucion-canal`,
-- apps/api/src/routes/atribucionCanal.ts) calcule comisión real desde datos reales en
-- cuanto exista un channel manager certificado o el servidor MCP de REQ-RES-021
-- empiece a escribir 'agente_ia_externo' -- sin necesitar otra migración ese día.
--
-- 'directo' NUNCA se configura aquí (nunca paga comisión por definición del negocio,
-- ver `packages/domain-hotel/src/reservas/atribucionCanal.ts`): el CHECK de abajo lo
-- impide a nivel de esquema, no solo en la aplicación.
create table public.hotel_channel_commission (
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  channel text not null check (channel <> 'directo' and length(trim(channel)) > 0),
  commission_pct numeric(5, 2) not null check (commission_pct between 0 and 100),
  updated_at timestamptz not null default now(),
  primary key (hotel_id, channel)
);

alter table public.hotel_channel_commission enable row level security;

-- Mismo criterio de "quién configura dinero del hotel" que
-- `hotel_cancellation_policy`/`hotel_tax_config` (0013): solo owner/gm.
create policy "hotel_channel_commission_tenant_select" on public.hotel_channel_commission for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "hotel_channel_commission_tenant_insert" on public.hotel_channel_commission for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "hotel_channel_commission_tenant_update" on public.hotel_channel_commission for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_channel_commission_tenant_delete" on public.hotel_channel_commission for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.hotel_channel_commission to authenticated;
