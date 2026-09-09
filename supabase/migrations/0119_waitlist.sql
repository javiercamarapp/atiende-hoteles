-- ORIGEN: packages/db/migrations/0119_waitlist.sql sha256:df41a0f61ce9803f7174779bad8f2a440069ffd7c17784df081cc1c3f56b3d02
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-RES-006/H01-010,H02-011 (P1/F): lista de espera automática -- cuando una
-- cancelación libera inventario, el sistema ofrece esa habitación al PRIMER contacto
-- en cola (FIFO por `created_at`), al precio directo (canal 'directo', SIN comisión de
-- OTA -- mismo criterio ya documentado en routes/reservas.ts sobre `channel`: hoy
-- siempre vale 'directo', ninguna variedad de canal externo se simula en H4).
--
-- La oferta NO reserva automáticamente la habitación: queda en estado 'ofertada' con
-- una ventana de expiración (`offer_expires_at`, ver
-- domain-hotel/src/reservas/waitlist.ts `WAITLIST_OFFER_WINDOW_HOURS`) -- el huésped
-- debe confirmarla (POST .../aceptar, apps/api/src/routes/listaEspera.ts) antes de que
-- se cree la reserva real. Si expira o el staff la retira, el contacto NUNCA vuelve a
-- 'esperando' automáticamente (se documenta como decisión deliberada: un contacto que
-- ya recibió su turno y no respondió no debe bloquear indefinidamente a los demás en
-- una futura cancelación que vuelva a coincidir) -- fuera de alcance de H4: reintentar
-- notificación o reinscripción manual del mismo contacto.
create table public.hotel_waitlist_entry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_type_id uuid not null references public.room_type(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  check_in_date date not null,
  check_out_date date not null,
  status text not null default 'esperando'
    check (status in ('esperando', 'ofertada', 'expirada', 'confirmada', 'cancelada')),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  -- Precio directo cotizado en el momento de la oferta (mismo motor que
  -- `quoteNetAmount()` usa para crear cualquier reserva directa) -- se congela aquí en
  -- vez de recalcularse al aceptar para que una tarifa que cambie ENTRE la oferta y la
  -- aceptación nunca le cobre al contacto un monto distinto del que se le ofreció.
  offer_amount numeric(12, 2),
  reservation_id uuid references public.reservation(id) on delete set null,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out_date > check_in_date),
  -- Implicación en UN SOLO sentido a propósito (nunca equivalencia): una vez que una
  -- fila pasó por 'ofertada', `offered_at`/`offer_expires_at`/`offer_amount` quedan
  -- como evidencia histórica de esa oferta aunque el estado avance después a
  -- 'confirmada'/'expirada' — exigir aquí que esos campos se limpien al salir de
  -- 'ofertada' destruiría esa evidencia sin ganar nada (a diferencia del check de
  -- `reservation_id` de abajo, que SÍ es una equivalencia real: nunca hay una razón
  -- legítima para que `reservation_id` quede huérfano de un estado que no sea
  -- 'confirmada').
  check (status <> 'ofertada' or (offered_at is not null and offer_expires_at is not null and offer_amount is not null)),
  check ((status = 'confirmada') = (reservation_id is not null))
);

-- Índice de cola: toda consulta real (¿quién sigue de FIFO para este room_type +
-- rango de fechas?) filtra por estos 5 campos y ordena por `created_at` -- ver
-- apps/api/src/pms/waitlistOffer.ts.
create index hotel_waitlist_entry_queue_idx on public.hotel_waitlist_entry
  (hotel_id, room_type_id, check_in_date, check_out_date, status, created_at);
create index hotel_waitlist_entry_tenant_hotel_idx on public.hotel_waitlist_entry (tenant_id, hotel_id);
create index hotel_waitlist_entry_guest_idx on public.hotel_waitlist_entry (guest_id);

alter table public.hotel_waitlist_entry enable row level security;

-- Mismos roles que ya gestionan reservaciones (`MANAGE_RESERVATIONS_ROLES` en
-- apps/api/src/domain/roles.ts): inscribir/ver/ofertar/aceptar una lista de espera es
-- una operación de reservaciones, no de housekeeping/mantenimiento/F&B/contabilidad.
create policy "hotel_waitlist_entry_staff_select" on public.hotel_waitlist_entry for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );

create policy "hotel_waitlist_entry_staff_insert" on public.hotel_waitlist_entry for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );

-- UPDATE cubre TANTO la oferta automática disparada por una cancelación (marca
-- 'ofertada' bajo la sesión del staff que canceló) COMO la aceptación/expiración
-- manual -- ambas corren bajo un rol de reservaciones ya autenticado, nunca bajo el
-- huésped directamente (H4 no tiene sesión de huésped real, mismo criterio que
-- `cancel_reservation_public` para la cancelación pública).
create policy "hotel_waitlist_entry_staff_update" on public.hotel_waitlist_entry for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));

create policy "hotel_waitlist_entry_manager_delete" on public.hotel_waitlist_entry for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.hotel_waitlist_entry to authenticated;
