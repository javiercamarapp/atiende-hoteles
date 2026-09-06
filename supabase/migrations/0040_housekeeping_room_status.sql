-- ORIGEN: packages/db/migrations/0040_housekeeping_room_status.sql sha256:0968eecd96ee7405a22d2be50708c9c74db723730696f0be1111f25b6dbea4b7
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H6b · REQ-HK-001/003/004: estado de LIMPIEZA de una habitacion, distinto del estado de
-- disponibilidad/reserva (`room.status`, 0004 -- disponible/ocupada/sucia/fuera_de_servicio/
-- mantenimiento, que gobierna venta/inventario). Una habitacion puede estar "disponible"
-- para venta y "sucia" para housekeeping al mismo tiempo (recien liberada por checkout,
-- antes de que la camarista la limpie) -- por eso es una columna nueva, no una reutilizacion
-- del enum existente. Con historial append-only, mismo patron que
-- `reservation_status_event` (0006): la columna viva en `room` para lectura simple, la
-- bitacora inmutable en una tabla aparte via trigger SECURITY DEFINER.

create type public.housekeeping_room_status as enum ('sucia', 'limpia', 'inspeccionada', 'fuera_de_servicio');

alter table public.room
  add column housekeeping_status public.housekeeping_room_status not null default 'sucia';

create table public.room_housekeeping_status_event (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.room(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  from_status public.housekeeping_room_status,
  to_status public.housekeeping_room_status not null,
  actor_user_id uuid,
  note text,
  created_at timestamptz not null default now()
);
create index room_hk_status_event_room_idx on public.room_housekeeping_status_event (room_id, created_at);
create index room_hk_status_event_tenant_idx on public.room_housekeeping_status_event (tenant_id, hotel_id);

create or replace function public.room_log_housekeeping_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.room_housekeeping_status_event (room_id, tenant_id, hotel_id, from_status, to_status, actor_user_id)
    values (new.id, new.tenant_id, new.hotel_id, null, new.housekeeping_status, auth.uid());
    return new;
  end if;

  if new.housekeeping_status is distinct from old.housekeeping_status then
    insert into public.room_housekeeping_status_event (room_id, tenant_id, hotel_id, from_status, to_status, actor_user_id)
    values (new.id, new.tenant_id, new.hotel_id, old.housekeeping_status, new.housekeeping_status, auth.uid());
  end if;
  return new;
end;
$$;

-- `room` ya existe desde 0004 sin triggers propios: se agregan aqui (expand-only) para
-- que TODA fila (nueva o ya existente en este mismo pase de migracion) quede con su
-- primer evento de historial registrado desde este punto en adelante.
create trigger room_log_hk_status_ins_trg
  after insert on public.room
  for each row execute function public.room_log_housekeeping_status_event();
create trigger room_log_hk_status_upd_trg
  after update on public.room
  for each row execute function public.room_log_housekeeping_status_event();

alter table public.room_housekeeping_status_event enable row level security;

-- Mismo reparto de roles que `room` (0004): housekeeping/mantenimiento/frontdesk/gm/owner
-- pueden leer el historial de limpieza de su hotel; la escritura SOLO ocurre via el
-- trigger SECURITY DEFINER de arriba (append-only, ningun rol de aplicacion recibe
-- INSERT/UPDATE/DELETE directo sobre esta tabla).
create policy "room_hk_status_event_tenant_select" on public.room_housekeeping_status_event
  for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));

grant select on public.room_housekeeping_status_event to authenticated;
