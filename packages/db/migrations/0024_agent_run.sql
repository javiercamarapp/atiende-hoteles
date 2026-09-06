-- H7 · ADR-006/REQ-AGT-020: `agent_run` es UNA fila por corrida completa de
-- `AgentRunner` (agregado -- tokens/costo/steps/duración totales), la fuente real del
-- presupuesto/costo por hotel y por agente (REQ-AGT-020, "techo de costo por
-- agente/unidad de negocio, medido en producción"). El detalle PASO A PASO de cada
-- corrida (llm_call/tool_call/approval_requested/etc., ya redactado por agent-core
-- `redact()`) se escribe aparte en `public.audit_log` vía `record_audit_log()` (0008) --
-- esta tabla NO duplica esa traza fina, solo agrega el resumen que necesita el
-- presupuesto/reporte de costo (mucho más barato de sumar que recorrer audit_log
-- completo cada vez que se pinta /agentes/costos).
--
-- Append-only por diseño (sin policy de UPDATE/DELETE para `authenticated`, mismo
-- criterio que `audit_log`): una corrida ya cerrada no se corrige, se audita.

create type public.agent_gate as enum ('shadow', 'propone', 'autopilot');

create type public.agent_run_status as enum (
  'completado',
  'esperando_aprobacion',
  'accion_rechazada',
  'agotado_pasos',
  'presupuesto_agotado',
  'no_configurado',
  'error_proveedor',
  'paralelismo_dinero_bloqueado',
  'truncado'
);

create table public.agent_run (
  id uuid primary key default gen_random_uuid(),
  -- runId que generó AgentRunner.run() (packages/agent-core/src/runner.ts) -- no es la
  -- PK de esta fila porque un mismo runId conceptual podría, en un hito futuro,
  -- corresponder a más de un registro (p.ej. reintentos); hoy es 1:1.
  run_id uuid not null,
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- Nombre de la configuración de agente (packages/agent-core/src/agents.ts), p.ej.
  -- "recepcion_virtual" / "enrutador_mensajes" / "auditor_nocturno" -- texto, no un
  -- catálogo en BD: el catálogo de agentes es código (ADR-006, "agentes como
  -- configuración, no prompts sueltos"), no una tabla más que sincronizar.
  agent_name text not null,
  model_role text not null,
  provider_id text not null,
  model_slug text not null,
  gate public.agent_gate not null,
  status public.agent_run_status not null,
  steps integer not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  request_id text not null,
  actor_type text not null,
  actor_id text not null,
  duration_ms integer not null default 0,
  -- Mensaje de cierre YA seguro para el humano (AgentRunResult.message, ver runner.ts) --
  -- nunca detalle interno de implementación.
  message text,
  created_at timestamptz not null default now()
);

create index agent_run_hotel_created_idx on public.agent_run (hotel_id, created_at desc);
-- Índice de apoyo específico para la agregación mensual por (hotel, agente) que usa
-- `agent_cost_mes()` abajo y el reporte de /agentes/costos.
create index agent_run_hotel_agent_created_idx on public.agent_run (hotel_id, agent_name, created_at);

alter table public.agent_run enable row level security;
-- SELECT: transparencia total dentro del hotel (cualquier rol de staff ve el historial
-- de corridas de agente de su hotel, igual que agent_approval).
create policy "agent_run_hotel_select" on public.agent_run for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
-- INSERT: cualquier miembro del staff del hotel que disparó la corrida (vía
-- apps/api/src/routes/agentes.ts, dentro de `dbSession` -- RLS real).
create policy "agent_run_hotel_insert" on public.agent_run for insert to authenticated
  with check (hotel_id = any (current_hotel_ids()));
-- Sin policy de UPDATE/DELETE para `authenticated`: append-only.

grant select, insert on public.agent_run to authenticated;

-- Suma el costo estimado del MES EN CURSO (UTC, date_trunc) para un hotel, opcionalmente
-- acotado a un agente -- REQ-AGT-020 "función que suma costo del mes por hotel".
-- security definer + revoke/grant explícitos (mismo patrón que current_tenant_ids(),
-- 0003): de lectura pura (stable), sin efectos secundarios.
create or replace function public.agent_cost_mes(_hotel_id uuid, _agent_name text default null)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0)::numeric
  from public.agent_run
  where hotel_id = _hotel_id
    and created_at >= date_trunc('month', now())
    and (_agent_name is null or agent_name = _agent_name);
$$;

revoke all on function public.agent_cost_mes(uuid, text) from public;
grant execute on function public.agent_cost_mes(uuid, text) to atiende_app, authenticated;
