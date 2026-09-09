-- ORIGEN: packages/db/migrations/0082_revenue_engine_gate.sql sha256:6b54f712d3aaea3ac3c8329b18372e2ce1b5e27d0e4f679951177dca399278a5
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-REV-003 (P0/GOB, fuentes BP-053/BP-054/BP-056/H02-003/H07-007/BP-016): el motor de
-- revenue (recomendación/ejecución de tarifas BAR) debe operar en "shadow" (solo
-- registra lo que habría hecho, nunca ejecuta) un mínimo de 90 días, con backtesting
-- walk-forward obligatorio que exija mejora vs. baseline antes de habilitar autopilot;
-- después de shadow pasa a "propone y ejecuta" (con aprobación — reutilizable el
-- adaptador de mensajería ya simulado de REQ-UX-006, `agent_approval`/
-- `PostgresApprovalQueue`, este esquema no lo reimplementa) con un límite de variación
-- ±10-15% hasta autopilot pleno.
--
-- Distinción con `agent_config` (0025): esa tabla gobierna el gate del AGENTE LLM
-- `auditor_nocturno` (narra/revisa el cierre, `packages/agent-core`); esta tabla
-- gobierna el gate del MOTOR DETERMINISTA de tarifas en sí — una superficie de negocio
-- distinta, con sus propias reglas de promoción (90 días mínimos + backtest walk-forward
-- + aprobación del fundador), no solo un techo de costo mensual. Reutiliza el mismo
-- enum `public.agent_gate` (0024) para mantener el vocabulario shadow/propone/autopilot
-- consistente en todo el esquema (mismo criterio documentado en
-- `packages/domain-hotel/src/revenue/revenueEngineGate.ts`).
--
-- Autoridad real: el trigger `revenue_engine_gate_transition_guard_trg` de abajo, no la
-- aplicación — ninguna sesión (ni siquiera owner/gm, que sí pueden escribir la fila por
-- RLS) puede saltarse el mínimo de 90 días, el backtest, o la aprobación del fundador
-- escribiendo directamente a esta tabla.

-- 1) Estado del gate por hotel ----------------------------------------------------------
create table public.revenue_engine_gate (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  gate public.agent_gate not null default 'shadow',
  -- Momento en que el hotel entró (o volvió a entrar, tras una democión) en shadow.
  shadow_started_at timestamptz not null default now(),
  propone_started_at timestamptz,
  autopilot_started_at timestamptz,
  -- REQ-REV-003 "límite de variación (±10-15%)" vigente mientras gate = 'propone'.
  propone_max_variation_pct numeric(4, 1) not null default 15.0
    check (propone_max_variation_pct >= 10.0 and propone_max_variation_pct <= 15.0),
  updated_by uuid references public.staff_user(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (hotel_id),
  check (hotel_id is not null)
);

create index revenue_engine_gate_org_idx on public.revenue_engine_gate (org_id);

-- 2) Backtests walk-forward corridos por hotel ------------------------------------------
-- Un registro por corrida (histórico completo, nunca se sobrescribe) — el trigger de
-- arriba solo mira la más reciente para decidir si autopilot es elegible, pero conservar
-- el historial permite auditar por qué una promoción se aprobó (o se bloqueó) en su
-- momento, mismo criterio que `revenue_backtest_run` nunca se actualiza in-place.
create table public.revenue_backtest_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- Espejo de `CounterfactualMethod` (walkForwardBacktest.ts) — un CHECK de catálogo
  -- cerrado, no texto libre, para que un método inventado sobre la marcha (nunca
  -- documentado) no pueda colarse como si fuera uno de los 3 métodos honestos del
  -- dominio.
  counterfactual_method text not null
    check (counterfactual_method in ('misma_tarifa_periodo_anterior', 'tarifa_estatica_pre_motor', 'modelo_elasticidad_declarado')),
  windows_evaluated integer not null check (windows_evaluated >= 0),
  windows_engine_won integer not null check (windows_engine_won >= 0 and windows_engine_won <= windows_evaluated),
  engine_total_revenue numeric(14, 2) not null,
  baseline_total_revenue numeric(14, 2) not null,
  improvement_pct numeric(8, 3) not null,
  passes boolean not null,
  -- Códigos de falla (espejo de `WalkForwardBacktestResult.failureReasons`) — '[]' si
  -- `passes = true`.
  failure_reasons jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  run_by uuid references public.staff_user(id),
  run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check ((passes = true) = (failure_reasons = '[]'::jsonb))
);

create index revenue_backtest_run_hotel_idx on public.revenue_backtest_run (hotel_id, run_at desc);

-- 3) Guard de pertenencia hotel/org, reutilizado por ambas tablas -----------------------
create or replace function public.revenue_engine_validate_hotel_org(_hotel_id uuid, _org_id uuid)
returns void
language plpgsql
stable
as $$
declare
  v_hotel_org uuid;
begin
  select org_id into v_hotel_org from public.hotel where id = _hotel_id;
  if v_hotel_org is null or v_hotel_org <> _org_id then
    raise exception 'hotel_no_pertenece_a_org: el hotel % no pertenece a la organizacion %', _hotel_id, _org_id
      using errcode = '23514';
  end if;
end;
$$;

-- 4) Trigger de transición del gate (la máquina de estados REAL) ------------------------
create or replace function public.revenue_engine_gate_transition_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_order_from integer;
  v_order_to integer;
  v_days_in_shadow integer;
  v_latest_backtest record;
begin
  perform public.revenue_engine_validate_hotel_org(new.hotel_id, new.org_id);

  if TG_OP = 'INSERT' then
    -- BP-016: ningún hotel entra en un gate distinto de shadow por omisión ni por
    -- inserción directa — la única forma de llegar a "propone"/"autopilot" es
    -- promover una fila ya existente a través de este mismo trigger.
    if new.gate <> 'shadow' then
      raise exception 'gate_inicial_invalido: todo hotel nuevo debe comenzar en "shadow" (REQ-REV-003/BP-016), no en "%"', new.gate
        using errcode = 'P0001';
    end if;
    new.shadow_started_at := coalesce(new.shadow_started_at, v_now);
    new.propone_started_at := null;
    new.autopilot_started_at := null;
    new.updated_by := auth.uid();
    new.updated_at := v_now;
    return new;
  end if;

  -- TG_OP = 'UPDATE' -----------------------------------------------------------------
  if new.gate = old.gate then
    -- Sin cambio de fase: los timestamps de fase son inmutables fuera de una
    -- transición real (evita que alguien "reescriba" cuánto tiempo lleva en shadow sin
    -- pasar por una transición de gate de verdad).
    if new.shadow_started_at is distinct from old.shadow_started_at
      or new.propone_started_at is distinct from old.propone_started_at
      or new.autopilot_started_at is distinct from old.autopilot_started_at
    then
      raise exception 'timestamps_de_fase_inmutables: shadow_started_at/propone_started_at/autopilot_started_at solo los fija este trigger durante una transición real de gate'
        using errcode = 'P0001';
    end if;
    new.updated_by := auth.uid();
    new.updated_at := v_now;
    return new;
  end if;

  v_order_from := case old.gate when 'shadow' then 0 when 'propone' then 1 when 'autopilot' then 2 end;
  v_order_to := case new.gate when 'shadow' then 0 when 'propone' then 1 when 'autopilot' then 2 end;

  if v_order_to < v_order_from then
    -- DEMOCIÓN ("freno de emergencia"): siempre permitida, sin ninguna de las
    -- condiciones de abajo — mismo criterio que aprobacionEjecutor.ts documenta para
    -- el agente LLM ("un gerente que baja el agente a shadow ... no tenía ninguna
    -- garantía de que se detuviera"). Volver a shadow reinicia el reloj de 90 días
    -- (es un shadow NUEVO, no una pausa); volver a propone desde autopilot conserva
    -- (o fija, si faltaba) su propio started_at pero exige un backtest NUEVO (posterior
    -- a ese started_at) para volver a subir.
    if new.gate = 'shadow' then
      new.shadow_started_at := v_now;
      new.propone_started_at := null;
      new.autopilot_started_at := null;
    elsif new.gate = 'propone' then
      new.propone_started_at := v_now;
      new.autopilot_started_at := null;
    end if;
    new.updated_by := auth.uid();
    new.updated_at := v_now;
    return new;
  end if;

  if v_order_to > v_order_from + 1 then
    raise exception 'transicion_no_permitida: no se puede saltar directamente de "%" a "%" (REQ-REV-003 exige pasar por "propone")', old.gate, new.gate
      using errcode = 'P0001';
  end if;

  -- PROMOCIÓN shadow -> propone: mínimo 90 días en shadow.
  if old.gate = 'shadow' and new.gate = 'propone' then
    v_days_in_shadow := floor(extract(epoch from (v_now - old.shadow_started_at)) / 86400);
    if v_days_in_shadow < 90 then
      raise exception 'shadow_insuficiente: se requieren 90 dias en shadow antes de pasar a "propone" (REQ-REV-003), van % dias', v_days_in_shadow
        using errcode = 'P0001';
    end if;
    new.propone_started_at := v_now;
    new.autopilot_started_at := null;
  end if;

  -- PROMOCIÓN propone -> autopilot: backtest walk-forward vigente que pase + aprobación
  -- registrada del fundador (REQ-GOB-012, categoría 'shadow_a_autopilot_revenue', ya
  -- definida en 0081 -- se reutiliza tal cual, nunca se duplica el catálogo).
  if old.gate = 'propone' and new.gate = 'autopilot' then
    select * into v_latest_backtest
      from public.revenue_backtest_run
      where hotel_id = new.hotel_id
      order by run_at desc
      limit 1;

    if v_latest_backtest is null or v_latest_backtest.passes is not true then
      raise exception 'backtest_no_supera_baseline: no existe un backtest walk-forward vigente que demuestre mejora vs. baseline para el hotel % (REQ-REV-003)', new.hotel_id
        using errcode = 'P0001';
    end if;
    if old.propone_started_at is not null and v_latest_backtest.run_at < old.propone_started_at then
      raise exception 'backtest_obsoleto: el ultimo backtest walk-forward es anterior a que este hotel entrara en modo "propone" -- se requiere uno corrido durante/despues de "propone"'
        using errcode = 'P0001';
    end if;

    perform public.require_founder_decision_approval('shadow_a_autopilot_revenue', new.org_id, new.hotel_id);

    new.autopilot_started_at := v_now;
  end if;

  new.updated_by := auth.uid();
  new.updated_at := v_now;
  return new;
end;
$$;

create trigger revenue_engine_gate_transition_guard_trg
  before insert or update on public.revenue_engine_gate
  for each row execute function public.revenue_engine_gate_transition_guard();

-- 5) Guard de pertenencia hotel/org para revenue_backtest_run ---------------------------
create or replace function public.revenue_backtest_run_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.revenue_engine_validate_hotel_org(new.hotel_id, new.org_id);
  new.run_by := coalesce(new.run_by, auth.uid());
  return new;
end;
$$;

create trigger revenue_backtest_run_guard_trg
  before insert on public.revenue_backtest_run
  for each row execute function public.revenue_backtest_run_guard();

-- 6) RLS ----------------------------------------------------------------------------
alter table public.revenue_engine_gate enable row level security;

-- SELECT: cualquier rol de staff del hotel puede ver el gate vigente (transparencia,
-- mismo criterio que agent_config/agent_approval).
create policy "revenue_engine_gate_hotel_select" on public.revenue_engine_gate for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT/UPDATE: cambiar el gate del motor de revenue (o su límite de variación) es una
-- decisión de gobierno reservada a owner/gm (mismo nivel que agent_config, 0025) — el
-- trigger de arriba impone además las condiciones REALES de promoción/aprobación, esto
-- solo decide quién puede intentarlo.
create policy "revenue_engine_gate_manager_insert" on public.revenue_engine_gate for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "revenue_engine_gate_manager_update" on public.revenue_engine_gate for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.revenue_engine_gate to authenticated;

alter table public.revenue_backtest_run enable row level security;

-- SELECT: igual transparencia que el gate — cualquier rol de staff del hotel puede ver
-- el historial de backtests (es la evidencia de por qué el gate está donde está).
create policy "revenue_backtest_run_hotel_select" on public.revenue_backtest_run for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT: registrar la corrida de un backtest requiere el mismo nivel que decidir el
-- gate (owner/gm) o accountant (rol que ya opera night audit/cierre, REQ-REV-013) —
-- nunca frontdesk/housekeeping/maintenance/fnb, que no tienen ninguna injerencia sobre
-- revenue. Sin policy de UPDATE/DELETE: cada corrida es inmutable, igual que audit_log.
create policy "revenue_backtest_run_manager_insert" on public.revenue_backtest_run for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[]));

grant select, insert on public.revenue_backtest_run to authenticated;
