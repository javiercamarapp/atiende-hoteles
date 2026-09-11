-- ORIGEN: packages/db/migrations/0136_channel_mix_decision.sql sha256:6ddc825e54d41786e56182080a3e20f9aaebe0b5f05b4e3d7cb2089013dd8e22
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-REV-006 (P1/F, fuentes BP-087/H02-001/H05-003): "el sistema debe decidir/ejecutar
-- el mix de canal (cerrar OTA en fechas de alta demanda, pausar campañas de metasearch
-- al superar umbral de ocupación proyectada, subir puja) registrando la razón de cada
-- decisión."
--
-- Dos tablas, mismo patrón que `revenue_engine_gate`/`revenue_backtest_run` (0082):
--   1. `hotel_channel_mix_config`: la configuración VIGENTE por canal de cada hotel --
--      umbrales + estado actual (abierto/cerrado, activo/pausado). "Configurable por
--      hotel" del propio texto del requisito exige que esto sea una fila persistida y
--      editable por el dueño, no un parámetro de función que solo vive en memoria --
--      exactamente el hueco que dejó a REQ-REV-007 en estado `parcial` (ver
--      docs/REQUISITOS.md, fila REQ-REV-007): este requisito no repite ese error.
--   2. `channel_mix_decision`: el LOG inmutable de cada decisión que produjo el motor
--      determinista (`packages/domain-hotel/src/revenue/channelMixEngine.ts`) -- un
--      registro por decisión, nunca se sobrescribe (mismo criterio que
--      `revenue_backtest_run`, nunca actualizado in-place). La razón NO vacía que exige
--      el criterio de aceptación literal ("cada decisión sintética tiene una razón no
--      vacía asociada") se impone aquí con un CHECK -- autoridad real de Postgres, no
--      solo la validación de la aplicación (mismo criterio que
--      `hotel_channel_commission.channel <> 'directo'`, 0122).
--
-- Alcance de "ejecutar": este esquema NO empuja nada a una OTA/metasearch real -- eso
-- exigiría el conector/channel manager de REQ-REV-008..REQ-REV-011, deliberadamente
-- fuera de esta fase (REQ-REV-008: "0 conectividad OTA propia fuera del channel
-- manager/PMS", `scripts/checks/orden-conectores-pms.ts`). "Ejecutar" en esta fase
-- significa: la decisión queda escrita como la fuente de verdad interna del hotel --
-- `hotel_channel_mix_config.is_open`/`is_active` reflejan el nuevo estado tras cada
-- decisión (ver el trigger de la sección 3) -- lista para que un conector futuro la lea
-- y la empuje al canal real.

-- 1) Configuración vigente por canal ----------------------------------------------------
create table public.hotel_channel_mix_config (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  channel text not null check (length(trim(channel)) > 0),
  channel_type text not null check (channel_type in ('ota', 'metasearch')),
  -- Solo 'ota': umbral de ocupación proyectada (%) que dispara el cierre del canal, y
  -- estado vigente (abierto/cerrado). NULL en un canal 'metasearch' (CHECK combinado
  -- más abajo lo exige).
  high_demand_occupancy_threshold_pct numeric(5, 2)
    check (high_demand_occupancy_threshold_pct is null or (high_demand_occupancy_threshold_pct > 0 and high_demand_occupancy_threshold_pct <= 100)),
  is_open boolean,
  -- Solo 'metasearch': umbral de pausa, umbral de alza de puja (debe ser estrictamente
  -- menor que el de pausa -- las dos bandas nunca se solapan), cuánto sube la puja, y
  -- estado vigente (activo/pausado). NULL en un canal 'ota'.
  pause_occupancy_threshold_pct numeric(5, 2)
    check (pause_occupancy_threshold_pct is null or (pause_occupancy_threshold_pct > 0 and pause_occupancy_threshold_pct <= 100)),
  raise_bid_occupancy_threshold_pct numeric(5, 2)
    check (raise_bid_occupancy_threshold_pct is null or (raise_bid_occupancy_threshold_pct >= 0 and raise_bid_occupancy_threshold_pct < 100)),
  bid_raise_pct numeric(5, 2) check (bid_raise_pct is null or bid_raise_pct > 0),
  is_active boolean,
  updated_by uuid references public.staff_user(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (hotel_id, channel),
  -- Cada canal declara EXACTAMENTE los campos de su propio tipo -- mismo criterio que
  -- `assertValidChannelMixChannelConfig` en el dominio puro, impuesto también aquí para
  -- que nadie deje un canal 'ota' con campos de metasearch (o viceversa) escribiendo
  -- SQL directo.
  check (
    (channel_type = 'ota'
      and high_demand_occupancy_threshold_pct is not null and is_open is not null
      and pause_occupancy_threshold_pct is null and raise_bid_occupancy_threshold_pct is null
      and bid_raise_pct is null and is_active is null)
    or
    (channel_type = 'metasearch'
      and high_demand_occupancy_threshold_pct is null and is_open is null
      and pause_occupancy_threshold_pct is not null and raise_bid_occupancy_threshold_pct is not null
      and bid_raise_pct is not null and is_active is not null
      and raise_bid_occupancy_threshold_pct < pause_occupancy_threshold_pct)
  )
);

create index hotel_channel_mix_config_org_idx on public.hotel_channel_mix_config (org_id);

-- 2) Log inmutable de decisiones ---------------------------------------------------------
create table public.channel_mix_decision (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  channel text not null check (length(trim(channel)) > 0),
  channel_type text not null check (channel_type in ('ota', 'metasearch')),
  action text not null check (action in ('cerrar_ota', 'pausar_metasearch', 'subir_puja')),
  -- "fechas de alta demanda" (texto del requisito): la decisión siempre es por fecha de
  -- estadía, nunca un cierre global del canal para todo el calendario.
  stay_date date not null,
  occupancy_projected_pct numeric(5, 2) not null check (occupancy_projected_pct >= 0 and occupancy_projected_pct <= 100),
  threshold_pct numeric(5, 2) not null check (threshold_pct >= 0 and threshold_pct <= 100),
  bid_raise_pct numeric(5, 2) check (bid_raise_pct is null or bid_raise_pct > 0),
  -- REQ-REV-006, criterio de aceptación LITERAL: "cada decisión sintética tiene una
  -- razón no vacía asociada" -- impuesto como CHECK de esquema, no solo validación de
  -- aplicación (ni siquiera un INSERT directo por SQL puede colarse sin razón).
  reason text not null check (length(trim(reason)) > 0),
  decided_by uuid references public.staff_user(id),
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- La acción declarada debe ser consistente con el tipo de canal (mismo criterio que
  -- el dominio puro: cerrar_ota solo aplica a 'ota'; pausar_metasearch/subir_puja solo a
  -- 'metasearch') y bid_raise_pct acompaña únicamente a subir_puja.
  check (
    (action = 'cerrar_ota' and channel_type = 'ota' and bid_raise_pct is null)
    or (action = 'pausar_metasearch' and channel_type = 'metasearch' and bid_raise_pct is null)
    or (action = 'subir_puja' and channel_type = 'metasearch' and bid_raise_pct is not null)
  )
);

create index channel_mix_decision_hotel_idx on public.channel_mix_decision (hotel_id, decided_at desc);
create index channel_mix_decision_stay_date_idx on public.channel_mix_decision (hotel_id, stay_date);

-- 3) Guards de pertenencia hotel/org + "ejecutar" el nuevo estado en la configuración ----
-- Reutiliza `revenue_engine_validate_hotel_org` (0082) -- mismo guard exacto, no se
-- duplica la lógica de "este hotel pertenece a esta org".
create or replace function public.hotel_channel_mix_config_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.revenue_engine_validate_hotel_org(new.hotel_id, new.org_id);
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger hotel_channel_mix_config_guard_trg
  before insert or update on public.hotel_channel_mix_config
  for each row execute function public.hotel_channel_mix_config_guard();

-- "Ejecutar" la decisión (dentro del alcance de esta fase, ver cabecera): al registrar
-- una decisión, esta función también actualiza `hotel_channel_mix_config` para que el
-- estado vigente del canal refleje inmediatamente la acción tomada -- `cerrar_ota` deja
-- `is_open = false`; `pausar_metasearch` deja `is_active = false`; `subir_puja` no
-- cambia `is_active` (la campaña sigue activa, solo se documenta el alza de puja en el
-- log -- el valor de puja en sí vive fuera de este esquema, en el proveedor real).
create or replace function public.channel_mix_decision_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.revenue_engine_validate_hotel_org(new.hotel_id, new.org_id);
  new.decided_by := coalesce(new.decided_by, auth.uid());

  if new.action = 'cerrar_ota' then
    update public.hotel_channel_mix_config
      set is_open = false
      where hotel_id = new.hotel_id and channel = new.channel and channel_type = 'ota';
  elsif new.action = 'pausar_metasearch' then
    update public.hotel_channel_mix_config
      set is_active = false
      where hotel_id = new.hotel_id and channel = new.channel and channel_type = 'metasearch';
  end if;

  return new;
end;
$$;

create trigger channel_mix_decision_guard_trg
  before insert on public.channel_mix_decision
  for each row execute function public.channel_mix_decision_guard();

-- 4) RLS -----------------------------------------------------------------------------
alter table public.hotel_channel_mix_config enable row level security;

create policy "hotel_channel_mix_config_hotel_select" on public.hotel_channel_mix_config for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- Configurar el mix de canal (umbrales, estado inicial) es una decisión de revenue
-- reservada a owner/gm -- mismo nivel que `revenue_engine_gate` (0082).
create policy "hotel_channel_mix_config_manager_insert" on public.hotel_channel_mix_config for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_channel_mix_config_manager_update" on public.hotel_channel_mix_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_channel_mix_config_manager_delete" on public.hotel_channel_mix_config for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.hotel_channel_mix_config to authenticated;

alter table public.channel_mix_decision enable row level security;

create policy "channel_mix_decision_hotel_select" on public.channel_mix_decision for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT: mismo nivel que `revenue_backtest_run` (owner/gm/accountant) -- accountant ya
-- opera night audit/cierre y reporting de revenue; frontdesk/housekeeping/maintenance/
-- fnb no tienen injerencia sobre revenue. Sin policy de UPDATE/DELETE: cada decisión es
-- inmutable, igual que audit_log/revenue_backtest_run.
create policy "channel_mix_decision_manager_insert" on public.channel_mix_decision for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[]));

grant select, insert on public.channel_mix_decision to authenticated;
