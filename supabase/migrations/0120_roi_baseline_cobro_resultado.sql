-- ORIGEN: packages/db/migrations/0120_roi_baseline_cobro_resultado.sql sha256:4edc3c57d1ad7c1355c29aacbba2b33785190c004136fc171476d6cf5785b61f
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-REV-018/REQ-GOB-016 (P0/OBS-GOB, fuentes BP-015/BP-131/BP-171/BP-150/GOB-037/
-- GOB-012/H17-001/H17-002/H02-019/H12-007/H17-003): "El sistema debe registrar, para
-- cada agente/módulo con impacto económico, una línea base firmada en la semana 1 ...;
-- ningún cobro por resultado se activa sin línea base firmada." (BP-015: "Sin línea base
-- firmada por el dueño en la semana 1 no se activa ningún cobro por éxito"; BP-131:
-- "sin línea base no hay cobro por éxito ('medición honesta')").
--
-- `packages/db/migrations/0026_roi_event.sql` YA captura el evento (`monto_verificado`/
-- `monto_estimado`/`metodo_contrafactual`/`confianza`) -- esta migración construye la
-- pieza que 0026 dejó documentada como pendiente ("la lógica de línea base firmada ...
-- queda pendiente de un hito posterior"): (1) `roi_baseline`, el registro en sí de la
-- línea base por (hotel, agente/módulo), con la ventana "semana 1" (7 días desde que el
-- agente/módulo se activó para ese hotel) impuesta por trigger, no por la aplicación; y
-- (2) `cobro_resultado_activacion`, el punto de activación REAL de un cobro por
-- resultado, cuyo trigger rechaza el INSERT si no existe una `roi_baseline` FIRMADA para
-- ese mismo (hotel, agente) -- exactamente el "verificado: intento de cobro sin línea
-- base → bloqueado" que exige `docs/ACEPTACION.md`.
--
-- Defensa en profundidad adicional (BP-150 "todo cambio de precio o de estructura de
-- éxito compartido por hotel requiere decisión reservada al fundador"; GOB-052): activar
-- un cobro por resultado es, por definición, fijar la "estructura de éxito compartido"
-- de ese hotel -- el trigger de `cobro_resultado_activacion` exige ADEMÁS una aprobación
-- vigente del fundador para la categoría `estructura_de_exito_compartido` (catálogo
-- cerrado de 0081), mismo patrón que `0082_revenue_engine_gate.sql` exige
-- `shadow_a_autopilot_revenue` antes de autopilot. Ninguna de las dos condiciones
-- (línea base firmada / aprobación del fundador) sustituye a la otra.
--
-- Mismo criterio de catálogo abierto que `roi_event.tipo_evento` (0026): `agent_name`
-- (aquí también "o módulo", p.ej. un motor determinista como `motor_revenue`, no solo un
-- agente LLM de `agent-core`) y `modelo_cobro` son texto libre, no un enum cerrado -- las
-- fórmulas de valor de H17 siguen evolucionando.

-- 1) Línea base por (hotel, agente/módulo) -----------------------------------------------
create table public.roi_baseline (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  agent_name text not null check (length(trim(agent_name)) > 0),
  -- Qué se mide (p.ej. 'reservas_directas_mensuales', 'kwh_por_habitacion_noche',
  -- 'comisiones_ota_mensuales') -- catálogo abierto, mismo criterio que roi_event.
  metrica text not null check (length(trim(metrica)) > 0),
  valor_base numeric(14, 2) not null check (valor_base >= 0),
  unidad text not null check (length(trim(unidad)) > 0),
  -- Cómo se obtuvo el valor_base (p.ej. "promedio de 12 meses de histórico PMS
  -- importados en onboarding, H18-002") -- texto libre igual que
  -- roi_event.metodo_contrafactual: la metodología debe quedar legible para el dueño,
  -- nunca un código interno opaco.
  metodo_captura text not null check (length(trim(metodo_captura)) > 0),
  periodo_desde date not null,
  periodo_hasta date not null check (periodo_hasta >= periodo_desde),
  -- Momento en que el agente/módulo se activó para este hotel -- inicio del reloj de
  -- "semana 1" que exige BP-015/BP-131. Lo fija la aplicación al crear el borrador
  -- (normalmente "ahora"), nunca se recalcula después.
  activado_en timestamptz not null default now(),
  -- NULL mientras la línea base sigue en borrador (BP-131: "acordada por escrito"). El
  -- trigger de abajo es la única vía real para poblar este campo, y exige que quede
  -- dentro de los 7 días siguientes a `activado_en`.
  firmado_en timestamptz,
  firmado_por uuid references public.staff_user(id),
  notas text,
  created_by uuid references public.staff_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Una línea base vigente por (hotel, agente) -- corregirla tras firmada exige un
  -- registro nuevo (inmutabilidad, ver trigger), no un UPDATE sobre esta fila.
  unique (hotel_id, agent_name),
  check ((firmado_en is null) = (firmado_por is null))
);

create index roi_baseline_hotel_idx on public.roi_baseline (hotel_id);

-- Máquina de estados REAL (borrador -> firmada -> inmutable) -- autoridad del trigger,
-- no de la aplicación, mismo criterio que `revenue_engine_gate_transition_guard`
-- (0082): ninguna sesión (ni owner/gm, que sí puede escribir la fila por RLS) puede
-- firmar fuera de la semana 1 ni modificar una línea base ya firmada escribiendo SQL a
-- mano.
create or replace function public.roi_baseline_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_dias_para_firmar numeric;
begin
  if TG_OP = 'INSERT' then
    new.activado_en := coalesce(new.activado_en, v_now);
    new.created_by := coalesce(new.created_by, auth.uid());
    new.updated_at := v_now;
    if new.firmado_en is not null then
      -- Comparación truncada a milisegundo: `activado_en` puede llevar precisión de
      -- microsegundo (default `now()` de Postgres) mientras `firmado_en` normalmente
      -- llega como un `Date` de JavaScript (precisión de milisegundo) -- sin este
      -- truncado, firmar en el MISMO instante de la activación podía leerse como "unos
      -- microsegundos antes" y rechazarse por un artefacto de precisión, no por una
      -- violación real de la regla.
      if date_trunc('milliseconds', new.firmado_en) < date_trunc('milliseconds', new.activado_en) then
        raise exception 'firma_anterior_a_activacion: la linea base del agente/modulo "%" no puede firmarse (%) antes de que se activara (%)',
          new.agent_name, new.firmado_en, new.activado_en
          using errcode = 'P0001';
      end if;
      v_dias_para_firmar := extract(epoch from (new.firmado_en - new.activado_en)) / 86400;
      if v_dias_para_firmar > 7 then
        raise exception 'linea_base_fuera_de_semana_1: la linea base del agente/modulo "%" debe firmarse dentro de los primeros 7 dias desde su activacion (REQ-REV-018/BP-015/BP-131), transcurrieron % dias',
          new.agent_name, round(v_dias_para_firmar, 1)
          using errcode = 'P0001';
      end if;
      new.firmado_por := coalesce(new.firmado_por, auth.uid());
    end if;
    return new;
  end if;

  -- TG_OP = 'UPDATE' ---------------------------------------------------------------
  if old.firmado_en is not null then
    -- Ya firmada: inmutable por completo (append-only, mismo criterio que
    -- roi_event/audit_log) -- corregir un dato exige un registro NUEVO, nunca reescribir
    -- el que el dueño ya vio y firmó.
    if new.agent_name is distinct from old.agent_name
      or new.metrica is distinct from old.metrica
      or new.valor_base is distinct from old.valor_base
      or new.unidad is distinct from old.unidad
      or new.metodo_captura is distinct from old.metodo_captura
      or new.periodo_desde is distinct from old.periodo_desde
      or new.periodo_hasta is distinct from old.periodo_hasta
      or new.activado_en is distinct from old.activado_en
      or new.firmado_en is distinct from old.firmado_en
      or new.firmado_por is distinct from old.firmado_por
      or new.notas is distinct from old.notas
    then
      raise exception 'linea_base_firmada_inmutable: la linea base del agente/modulo "%" ya fue firmada el % -- no se puede modificar, un ajuste requiere un registro nuevo',
        old.agent_name, old.firmado_en
        using errcode = 'P0001';
    end if;
    new.updated_at := v_now;
    return new;
  end if;

  -- old.firmado_en IS NULL: sigue en borrador.
  if new.firmado_en is not null then
    -- Acción de FIRMAR: en el MISMO update no se admite cambiar ningún otro campo --
    -- evita "firmar y de paso ajustar la cifra" en una sola sentencia.
    if new.agent_name is distinct from old.agent_name
      or new.metrica is distinct from old.metrica
      or new.valor_base is distinct from old.valor_base
      or new.unidad is distinct from old.unidad
      or new.metodo_captura is distinct from old.metodo_captura
      or new.periodo_desde is distinct from old.periodo_desde
      or new.periodo_hasta is distinct from old.periodo_hasta
      or new.activado_en is distinct from old.activado_en
    then
      raise exception 'no_se_puede_modificar_al_firmar: al firmar la linea base del agente/modulo "%" no se puede cambiar ningun otro campo en el mismo momento -- edita el borrador antes de firmarlo',
        old.agent_name
        using errcode = 'P0001';
    end if;
    -- Comparación truncada a milisegundo: `activado_en` puede llevar precisión de
    -- microsegundo (default `now()` de Postgres) mientras `firmado_en` normalmente
    -- llega como un `Date` de JavaScript (precisión de milisegundo) -- sin este
    -- truncado, firmar en el MISMO instante de la activación podía leerse como "unos
    -- microsegundos antes" y rechazarse por un artefacto de precisión, no por una
    -- violación real de la regla.
    if date_trunc('milliseconds', new.firmado_en) < date_trunc('milliseconds', new.activado_en) then
      raise exception 'firma_anterior_a_activacion: la linea base del agente/modulo "%" no puede firmarse (%) antes de que se activara (%)',
        new.agent_name, new.firmado_en, new.activado_en
        using errcode = 'P0001';
    end if;
    v_dias_para_firmar := extract(epoch from (new.firmado_en - new.activado_en)) / 86400;
    if v_dias_para_firmar > 7 then
      raise exception 'linea_base_fuera_de_semana_1: la linea base del agente/modulo "%" debe firmarse dentro de los primeros 7 dias desde su activacion (REQ-REV-018/BP-015/BP-131), transcurrieron % dias',
        new.agent_name, round(v_dias_para_firmar, 1)
        using errcode = 'P0001';
    end if;
    new.firmado_por := coalesce(new.firmado_por, auth.uid());
  end if;
  new.updated_at := v_now;
  return new;
end;
$$;

create trigger roi_baseline_guard_trg
  before insert or update on public.roi_baseline
  for each row execute function public.roi_baseline_guard();

alter table public.roi_baseline enable row level security;

-- SELECT: transparencia -- cualquier rol de staff del hotel puede ver la línea base
-- vigente y si ya está firmada (mismo criterio que agent_config/roi_event).
create policy "roi_baseline_hotel_select" on public.roi_baseline for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT/UPDATE (crear el borrador y firmarlo) es una decisión de gobierno reservada a
-- owner/gm (mismo nivel que agent_config/revenue_engine_gate) -- el trigger de arriba
-- impone además las condiciones REALES de la ventana de semana 1 e inmutabilidad.
create policy "roi_baseline_manager_insert" on public.roi_baseline for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "roi_baseline_manager_update" on public.roi_baseline for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
-- Sin policy de DELETE: append-only, mismo criterio que roi_event/agent_config.

grant select, insert, update on public.roi_baseline to authenticated;

-- 2) Activación real de un cobro por resultado --------------------------------------------
-- Un registro por (hotel, agente/módulo): el momento en que el hotel empieza a cobrarse
-- por resultado sobre los `roi_event` de ese agente. Append-only (activar es una
-- decisión de un solo sentido en este esquema; desactivar/renegociar queda para un hito
-- posterior, ver comentario de archivo de 0026).
create table public.cobro_resultado_activacion (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  agent_name text not null check (length(trim(agent_name)) > 0),
  -- La línea base concreta que sustenta esta activación -- referencia real, nunca solo
  -- "hubo alguna línea base alguna vez" (evita que una línea base de OTRO agente, o ya
  -- reemplazada, se use para justificar el cobro de este).
  roi_baseline_id uuid not null references public.roi_baseline(id) on delete restrict,
  -- Modelo de cobro (p.ej. 'porcentaje_reservas_directas_incrementales',
  -- 'porcentaje_ahorro_energetico_verificado_ipmvp', 'fijo_por_evento') -- texto libre,
  -- mismo criterio de catálogo abierto que roi_event.tipo_evento (BP-015 cita al menos 3
  -- modelos distintos y en evolución).
  modelo_cobro text not null check (length(trim(modelo_cobro)) > 0),
  activado_por uuid references public.staff_user(id),
  activado_en timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (hotel_id, agent_name)
);

create index cobro_resultado_activacion_hotel_idx on public.cobro_resultado_activacion (hotel_id);

-- El GATE real (REQ-REV-018 + BP-150/GOB-052 en profundidad): rechaza la activación si
-- (a) la línea base referenciada no existe, (b) no corresponde a este mismo
-- hotel/agente, (c) no está firmada, o (d) no hay una aprobación vigente del fundador
-- para `estructura_de_exito_compartido` en este alcance (hotel u org). Ninguna de las
-- dos condiciones de fondo (a-c / d) sustituye a la otra -- mismo espíritu que
-- `revenue_engine_gate_transition_guard` exige backtest Y aprobación del fundador, no
-- solo uno de los dos.
create or replace function public.cobro_resultado_activacion_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_baseline public.roi_baseline%rowtype;
begin
  select * into v_baseline from public.roi_baseline where id = new.roi_baseline_id;

  if v_baseline.id is null then
    raise exception 'linea_base_no_encontrada: el id de linea base % no existe -- no se puede activar cobro por resultado sin una linea base real', new.roi_baseline_id
      using errcode = 'P0001';
  end if;

  if v_baseline.hotel_id <> new.hotel_id or v_baseline.agent_name <> new.agent_name then
    raise exception 'linea_base_no_corresponde: la linea base % pertenece a otro hotel o a otro agente/modulo distinto del que se intenta activar', new.roi_baseline_id
      using errcode = 'P0001';
  end if;

  if v_baseline.firmado_en is null then
    raise exception 'linea_base_no_firmada: no se puede activar cobro por resultado para el agente/modulo "%" -- no existe una linea base FIRMADA para este hotel (REQ-REV-018/BP-015/BP-131: "sin linea base firmada por el dueño en la semana 1 no se activa ningun cobro por exito")',
      new.agent_name
      using errcode = 'P0001';
  end if;

  perform public.require_founder_decision_approval('estructura_de_exito_compartido', new.org_id, new.hotel_id);

  new.activado_por := coalesce(new.activado_por, auth.uid());
  new.activado_en := coalesce(new.activado_en, now());
  return new;
end;
$$;

create trigger cobro_resultado_activacion_guard_trg
  before insert on public.cobro_resultado_activacion
  for each row execute function public.cobro_resultado_activacion_guard();

alter table public.cobro_resultado_activacion enable row level security;

-- SELECT: transparencia, mismo criterio que roi_baseline/roi_event.
create policy "cobro_resultado_activacion_hotel_select" on public.cobro_resultado_activacion for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT: activar un cobro por resultado es, por definición, fijar la "estructura de
-- éxito compartido" del hotel (BP-150) -- reservado a owner/gm para siquiera intentarlo;
-- el trigger de arriba exige además que exista línea base firmada Y aprobación vigente
-- del fundador. Sin policy de UPDATE/DELETE: append-only.
create policy "cobro_resultado_activacion_manager_insert" on public.cobro_resultado_activacion for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert on public.cobro_resultado_activacion to authenticated;
