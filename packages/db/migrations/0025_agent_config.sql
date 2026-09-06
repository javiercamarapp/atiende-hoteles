-- H7 · ADR-006/BP-016/BP-053/BP-054/GOB-036/REQ-AGT-020: configuración por (hotel,
-- agente) del gate (shadow -> propone -> autopilot) y el techo de costo mensual (USD,
-- LLM-026: banda de referencia ≈USD 27-158/mes por hotel de 45 habitaciones, según
-- opción de proveedor). Sin fila explícita para un (hotel, agente), la aplicación usa el
-- default de código (packages/agent-core/src/agents.ts, AGENT_DEFINITIONS) -- mismo
-- criterio que `StaticGateResolver` (roles.ts): ningún agente nuevo entra en autopilot
-- por omisión.
create table public.agent_config (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  agent_name text not null,
  gate public.agent_gate not null default 'shadow',
  monthly_ceiling_usd numeric(10, 2) not null check (monthly_ceiling_usd >= 0),
  currency text not null default 'USD',
  -- Umbral de alerta como fracción (0.800 = 80%) -- REQ-AGT-020 "alerta al 80%".
  alert_threshold_pct numeric(4, 3) not null default 0.800 check (alert_threshold_pct > 0 and alert_threshold_pct <= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, agent_name)
);

alter table public.agent_config enable row level security;
-- SELECT: cualquier rol de staff del hotel puede VER el gate/techo configurado (mismo
-- criterio de transparencia que agent_approval/agent_run).
create policy "agent_config_hotel_select" on public.agent_config for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
-- INSERT/UPDATE: cambiar el gate o el techo de costo de un agente es una decisión de
-- gobierno reservada a owner/gm (mismo nivel que `agent_approval_manager_update`, 0042).
create policy "agent_config_manager_insert" on public.agent_config for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "agent_config_manager_update" on public.agent_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.agent_config to authenticated;
