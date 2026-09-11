-- REQ-HK-015 (H11-019/H11-020, BP-078): "Calendario de mantenimiento preventivo por
-- activo crítico ajustado a ocupación y temporada; historial y costo por activo permite
-- calcular recomendación reparar vs. reemplazar" (docs/ACEPTACION.md). Tres piezas
-- nuevas:
--
-- 1. `critical_asset` -- el activo crítico en sí (minisplit, bomba, calentador, PTAR,
--    generador, cerradura, alberca, cocina -- lista exacta de H11-019). `room_id` es
--    NULLABLE a propósito: un minisplit vive en una habitación concreta (la MP debe
--    esperar a que esté vacía), pero un generador o la bomba de alberca no pertenecen a
--    ninguna habitación (la ocupación nunca los bloquea). `base_frequency_days` +
--    `replacement_cost` son los dos números que alimentan
--    `packages/domain-hotel/src/mantenimiento/preventivo.ts` (calendario y
--    recomendación reparar/reemplazar respectivamente).
--
-- 2. `hotel_maintenance_season_window` -- las ventanas de temporada (pre-huracanes,
--    post-sargazo) que aprietan la frecuencia base. Es CONFIGURABLE POR HOTEL, nunca un
--    calendario fijo hardcodeado: la temporada de huracanes del Pacífico mexicano
--    (15-may a 30-nov, NOAA/SMN) no es la misma que la del Atlántico/Caribe
--    (1-jun a 30-nov), y el pronóstico de recale de sargazo (Red de Monitoreo del
--    Sargazo Q. Roo) solo aplica a la costa caribeña -- un hotel en Los Cabos no debe
--    heredar una ventana de sargazo que nunca le aplica. Sin filas, el calendario
--    simplemente no aprieta por temporada (nunca se inventa una ventana por default,
--    mismo criterio REQ-UX-002 de "nunca simular una cifra que nadie configuró").
--
-- 3. `critical_asset_maintenance_event` -- el HISTORIAL de ejecución preventiva
--    (checklist con foto, H11-019) y su costo, ancla de `computeNextPreventiveDueDate`
--    (última ejecución = próximo vencimiento) y una de las dos fuentes de costo para
--    reparar-vs-reemplazar (la otra es `maintenance_ticket.actual_cost` de tickets
--    CORRECTIVOS del mismo activo, ver alter de abajo -- MP programada y avería
--    reportada son sucesos distintos que no deben mezclarse en una sola tabla: un
--    ticket significa "algo se rompió", un evento de este tipo significa "se hizo el
--    checklist rutinario", aunque ambos sumen al costo acumulado del activo).
--
-- RLS: mismo patrón de 3 niveles que `maintenance_ticket` (0043) -- owner/gm/maintenance
-- pueden VER el calendario y el historial (el técnico necesita saber qué le toca);
-- gestionar el catálogo de activos y las ventanas de temporada (dar de alta/baja un
-- activo crítico, decidir la frecuencia y el costo de reemplazo) es una decisión de
-- owner/gm, nunca de mantenimiento; registrar que un checklist YA SE HIZO (con su costo)
-- sí lo puede hacer el propio técnico, igual que housekeeping puede reportar un ticket
-- sin poder gestionar el catálogo (mismo criterio que 0043).

create type public.critical_asset_category as enum (
  'minisplit', 'bomba', 'calentador', 'ptar', 'generador', 'cerradura', 'alberca', 'cocina', 'otro'
);

create table public.critical_asset (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid references public.room(id) on delete set null,
  name text not null,
  category public.critical_asset_category not null default 'otro',
  install_date date not null,
  replacement_cost numeric(12, 2) not null check (replacement_cost >= 0),
  base_frequency_days integer not null check (base_frequency_days > 0),
  active boolean not null default true,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index critical_asset_tenant_hotel_idx on public.critical_asset (tenant_id, hotel_id);
create index critical_asset_room_idx on public.critical_asset (room_id) where room_id is not null;

alter table public.critical_asset enable row level security;
create policy "critical_asset_view" on public.critical_asset for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'maintenance']::public.hotel_role[])
  );
create policy "critical_asset_manager_insert" on public.critical_asset for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "critical_asset_manager_update" on public.critical_asset for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "critical_asset_manager_delete" on public.critical_asset for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
grant select, insert, update, delete on public.critical_asset to authenticated;

create table public.hotel_maintenance_season_window (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  label text not null,
  -- MM-DD, calendario anual que se repite cada año (ver
  -- packages/domain-hotel/src/mantenimiento/preventivo.ts::isMonthDayInSeasonWindow,
  -- que interpreta start > end como una ventana que cruza el 31-dic, ej. temporada de
  -- fin de año).
  start_month_day text not null check (start_month_day ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'),
  end_month_day text not null check (end_month_day ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'),
  -- Frecuencia apretada durante la ventana. NUNCA se valida aquí que sea <= la
  -- frecuencia base de cada activo (una ventana es compartida por TODOS los activos del
  -- hotel, cada uno con su propia base_frequency_days) -- esa comparación (y la regla
  -- de "nunca aflojar por temporada") vive en el dominio puro, no en el esquema.
  frequency_days integer not null check (frequency_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hotel_maintenance_season_window_hotel_idx on public.hotel_maintenance_season_window (tenant_id, hotel_id);

alter table public.hotel_maintenance_season_window enable row level security;
create policy "hotel_maintenance_season_window_view" on public.hotel_maintenance_season_window for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'maintenance']::public.hotel_role[])
  );
create policy "hotel_maintenance_season_window_manager_insert" on public.hotel_maintenance_season_window for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "hotel_maintenance_season_window_manager_update" on public.hotel_maintenance_season_window for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_maintenance_season_window_manager_delete" on public.hotel_maintenance_season_window for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
grant select, insert, update, delete on public.hotel_maintenance_season_window to authenticated;

create table public.critical_asset_maintenance_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  asset_id uuid not null references public.critical_asset(id) on delete cascade,
  completed_at timestamptz not null default now(),
  cost numeric(12, 2) not null default 0 check (cost >= 0),
  note text,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index critical_asset_maintenance_event_asset_idx on public.critical_asset_maintenance_event (asset_id, completed_at desc);
create index critical_asset_maintenance_event_tenant_hotel_idx on public.critical_asset_maintenance_event (tenant_id, hotel_id);

alter table public.critical_asset_maintenance_event enable row level security;
create policy "critical_asset_maintenance_event_view" on public.critical_asset_maintenance_event for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'maintenance']::public.hotel_role[])
  );
-- Registrar que el checklist YA SE HIZO (con su costo) lo puede hacer el propio
-- técnico de mantenimiento, no solo owner/gm -- mismo criterio que
-- "maintenance_ticket_staff_insert" (0043): quien ejecuta el trabajo en campo es quien
-- lo reporta.
create policy "critical_asset_maintenance_event_insert" on public.critical_asset_maintenance_event for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'maintenance']::public.hotel_role[])
  );
create policy "critical_asset_maintenance_event_manager_delete" on public.critical_asset_maintenance_event for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
grant select, insert, delete on public.critical_asset_maintenance_event to authenticated;

-- Liga el ticket CORRECTIVO (0043) al activo crítico que reparó, cuando aplica -- la
-- segunda fuente de "historial y costo por activo" (H11-020: "tickets + refacciones +
-- CFDI de contratistas") junto con critical_asset_maintenance_event de arriba.
-- Nullable/expand-only: un ticket sin activo asociado (la inmensa mayoría hoy, ya que
-- REQ-HK-011 no exige capturar el activo) sigue siendo válido.
alter table public.maintenance_ticket add column asset_id uuid references public.critical_asset(id) on delete set null;
create index maintenance_ticket_asset_idx on public.maintenance_ticket (asset_id) where asset_id is not null;
