-- ORIGEN: packages/db/migrations/0130_maintenance_asset_historial_escalacion.sql sha256:e796fbb5ecf4037e33e1af2147676dde28d49d859c3246330a596809a78f06c5
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-HK-012 (docs/REQUISITOS.md/docs/ACEPTACION.md): "El sistema debe enriquecer cada
-- ticket con el historial del activo asociado, escalando automáticamente tras N tickets
-- repetidos en X días sobre el mismo activo."
--
-- Hasta esta migración `maintenance_ticket` (0043) solo se ligaba a una HABITACIÓN
-- (`room_id`) -- suficiente para "fuga en el baño de la 204", insuficiente para "el
-- compresor del minisplit de la 204 lleva 4 fallas este mes" o para un equipo que ni
-- siquiera vive en una habitación (bomba de la alberca, elevador, planta de emergencia).
-- `maintenance_asset` es el catálogo NUEVO y mínimo de activos/equipos que ese
-- historial/escalación necesita -- deliberadamente ligero (código + nombre + categoría
-- libre + habitación opcional), no el CMMS completo que REQ-HK-015/019 dejan pendientes
-- por separado (calendario preventivo, costo por activo, adaptador CMMS externo): este
-- REQ solo exige historial + escalación por repetición, no gestión de vida útil.
--
-- `room_id` es NULLABLE a propósito (no todo activo vive en una habitación) y
-- `on delete set null` (mismo criterio que `maintenance_ticket.room_id`): borrar una
-- habitación no debe destruir el historial de fallas de un activo.
create table public.maintenance_asset (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid references public.room(id) on delete set null,
  code text not null,
  name text not null,
  category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, code)
);
create index maintenance_asset_tenant_hotel_idx on public.maintenance_asset (tenant_id, hotel_id);
create index maintenance_asset_room_idx on public.maintenance_asset (room_id) where room_id is not null;

alter table public.maintenance_asset enable row level security;

-- Mismo criterio que `room_tenant_select` (0004): CUALQUIER staff del hotel puede LEER
-- el catálogo de activos -- lo necesita para resolver `assetCode` al reportar un ticket
-- (`crear_ticket_mantenimiento`, packages/agent-core/src/tools/housekeepingTools.ts),
-- sin importar su propio rol (una camarista reporta un ticket sobre el minisplit igual
-- que sobre una habitación).
create policy "maintenance_asset_tenant_select" on public.maintenance_asset for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
-- Alta/edición/baja del catálogo: owner/gm (dueños del inventario de activos) o
-- mantenimiento (quien de verdad conoce el equipo en campo) -- mismo trío que
-- `room_tenant_insert`.
create policy "maintenance_asset_manage_insert" on public.maintenance_asset for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'maintenance']::public.hotel_role[])
  );
create policy "maintenance_asset_manage_update" on public.maintenance_asset for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'maintenance']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'maintenance']::public.hotel_role[]));
create policy "maintenance_asset_manage_delete" on public.maintenance_asset for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.maintenance_asset to authenticated;

-- Ligar cada ticket a SU activo (nullable: un ticket sin activo declarado -- p.ej. "el
-- pasillo del 3er piso huele raro" -- se sigue registrando exactamente igual que antes,
-- sin historial/escalación por activo, mismo criterio de "expand-only sin romper a
-- nadie" que el resto de este esquema).
alter table public.maintenance_ticket add column asset_id uuid references public.maintenance_asset(id) on delete set null;
create index maintenance_ticket_asset_idx on public.maintenance_ticket (hotel_id, asset_id, created_at) where asset_id is not null;

-- Escalación automática por repetición (distinta de la escalación por SLA vencido de
-- `guest_ticket`, 0098/0128 -- esta es por CONTEO de fallas del mismo activo en una
-- ventana de días, no por tiempo sin cierre): mismas dos columnas que `guest_ticket`
-- (`escalated_at`/`escalated_to_roles`) para reutilizar el mismo criterio ya probado de
-- "NULL = nunca escaló" y el mismo patrón `jsonb` de lista de roles (ADR-003: no todo
-- comportamiento de Postgres es idéntico entre PGlite y embedded-postgres, este esquema
-- ya usa jsonb para listas de roles en todos lados, ver `fraud_alert`/`guest_ticket`).
alter table public.maintenance_ticket add column escalated_at timestamptz;
alter table public.maintenance_ticket add column escalated_to_roles jsonb not null default '[]'::jsonb;

-- Política de escalación CONFIGURABLE por hotel (REQ-HK-012 "N tickets repetidos en X
-- días (configurable)"): una fila por hotel que sobreescribe
-- `DEFAULT_ASSET_ESCALATION_POLICY` de
-- packages/domain-hotel/src/tickets/assetEscalation.ts cuando existe. Sin fila -> se usa
-- el default documentado ahí (mismo criterio que `ticket_sla_policy`, 0098: placeholder
-- de negocio explícito, nunca un número inventado en silencio).
create table public.maintenance_escalation_policy (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  threshold_count integer not null check (threshold_count > 0),
  window_days integer not null check (window_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id)
);
create index maintenance_escalation_policy_hotel_idx on public.maintenance_escalation_policy (hotel_id);

alter table public.maintenance_escalation_policy enable row level security;

-- Mismo criterio que `ticket_sla_policy_staff_select` (0098): solo owner/gm ESCRIBEN la
-- política, pero cualquier staff que pueda crear un ticket de mantenimiento necesita
-- LEERLA para que la escalación se resuelva igual sin importar quién reporta.
create policy "maintenance_escalation_policy_staff_select" on public.maintenance_escalation_policy for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'housekeeping', 'maintenance']::public.hotel_role[]
    )
  );
create policy "maintenance_escalation_policy_manager_insert" on public.maintenance_escalation_policy for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "maintenance_escalation_policy_manager_update" on public.maintenance_escalation_policy for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "maintenance_escalation_policy_manager_delete" on public.maintenance_escalation_policy for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.maintenance_escalation_policy to authenticated;
