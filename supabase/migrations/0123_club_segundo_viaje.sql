-- ORIGEN: packages/db/migrations/0123_club_segundo_viaje.sql sha256:1c4fbfc7385985803a5aa9f8ac8603851ab8304d0e43332eca94af6428923299
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-RES-010 (P1/F): "club de segundo viaje" -- programa de reserva directa con
-- registro con CONSENTIMIENTO EXPLÍCITO, emisión de un código de miembro, y aplicación
-- automática del beneficio (descuento configurable por hotel) en reservas DIRECTAS
-- subsecuentes del mismo huésped. La lógica de "cuándo aplica el descuento" vive en
-- `packages/domain-hotel/src/reservas/clubSegundoViaje.ts` (pura, sin I/O); esta
-- migración solo agrega las 2 tablas de estado real.

-- Descuento configurable por hotel (mismo patrón que hotel_cancellation_policy, 0013):
-- una fila por hotel, con default sensato para que el programa tenga algo real que
-- ofrecer desde el primer arranque.
create table public.hotel_loyalty_program_config (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  discount_pct numeric(5, 2) not null default 10 check (discount_pct between 0 and 100),
  updated_at timestamptz not null default now()
);

-- Membresía por (hotel, huésped): un huésped se inscribe UNA vez por hotel (unique
-- abajo). `member_code` sigue el mismo criterio que `reservation.confirmation_code`
-- (0013): un huésped que llama solo conoce su código de miembro, no de qué tenant es,
-- así que el índice de búsqueda por código es GLOBAL (no indexado por tenant primero).
-- `consent_aviso_version` es NOT NULL (mismo criterio que `record_consent()`, 0064): un
-- registro sin versión de aviso registrada no es un consentimiento válido -- nunca se
-- inserta una fila "a medias".
create table public.hotel_loyalty_member (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  member_code text not null default ('SV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  status text not null default 'activo' check (status in ('activo', 'revocado')),
  consent_aviso_version text not null check (length(trim(consent_aviso_version)) > 0),
  enrolled_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (hotel_id, guest_id)
);
create unique index hotel_loyalty_member_code_idx on public.hotel_loyalty_member (member_code);
create index hotel_loyalty_member_hotel_idx on public.hotel_loyalty_member (tenant_id, hotel_id);
-- FK compuesta (mismo criterio que consent_guest_hotel_fk, 0064): una membresía de
-- Hotel A nunca puede apuntar a un guest de Hotel B.
alter table public.hotel_loyalty_member
  add constraint hotel_loyalty_member_guest_hotel_fk
  foreign key (hotel_id, guest_id) references public.guest (hotel_id, id) on delete cascade;

alter table public.hotel_loyalty_program_config enable row level security;
alter table public.hotel_loyalty_member enable row level security;

-- Configuración de dinero del hotel: solo owner/gm (mismo criterio que
-- hotel_cancellation_policy/hotel_channel_commission).
create policy "hotel_loyalty_program_config_tenant_select" on public.hotel_loyalty_program_config for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "hotel_loyalty_program_config_tenant_insert" on public.hotel_loyalty_program_config for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "hotel_loyalty_program_config_tenant_update" on public.hotel_loyalty_program_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

-- Inscripción de miembro: cualquier rol que ya gestiona reservas (owner/gm/frontdesk/
-- reservations, `MANAGE_RESERVATIONS_ROLES`) puede inscribir a un huésped -- es
-- captura de consentimiento en el momento de atenderlo, no configuración financiera.
create policy "hotel_loyalty_member_tenant_select" on public.hotel_loyalty_member for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "hotel_loyalty_member_tenant_insert" on public.hotel_loyalty_member for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "hotel_loyalty_member_tenant_update" on public.hotel_loyalty_member for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));

grant select, insert, update on public.hotel_loyalty_program_config to authenticated;
grant select, insert, update on public.hotel_loyalty_member to authenticated;
