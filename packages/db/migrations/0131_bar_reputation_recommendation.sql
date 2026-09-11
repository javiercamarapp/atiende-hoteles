-- REQ-REV-017 (P2/F, fuente H05-017): "El sistema debe recomendar un ajuste de tarifa
-- (BAR) cuando el índice de reputación suba sobre un umbral en una ventana de tiempo
-- definida." Confirmado por grep antes de esta migración: no existía ninguna tabla que
-- conectara reputación (`guest_review`, 0097) con revenue (`revenue_engine_gate`,
-- 0082) -- esta es la primera.
--
-- Una fila = una recomendación de ajuste de BAR generada por
-- `apps/api/src/jobs/barReputacionEvaluator.ts` (I/O) llamando al cálculo puro de
-- `packages/domain-hotel/src/revenue/barPorReputacion.ts` (`detectarCruceDeUmbral` +
-- `recomendarAjusteBar`) -- SOLO una recomendación, nunca ejecuta el cambio de tarifa
-- por sí sola (el ajuste real sigue pasando por el gate de REQ-REV-003,
-- `revenue_engine_gate`/`evaluateRevenueProposal()`, que exige aprobación humana en
-- modo "propone" -- esta tabla es la entrada informativa a esa decisión, no un atajo
-- para saltársela).
--
-- Idempotencia (mismo patrón EXACTO que `fraud_alert`/`record_fraud_alert`, 0095):
-- `unique (hotel_id, fecha_cruce)` + `record_bar_reputation_recommendation()`
-- SECURITY DEFINER con `on conflict ... do nothing` -- re-evaluar el mismo hotel varias
-- veces mientras el índice se mantiene sobre el umbral (el job corre periódicamente)
-- NUNCA duplica la recomendación del mismo cruce; solo un cruce real NUEVO (el índice
-- volvió a caer bajo el umbral y subió otra vez) genera una fila nueva.
--
-- Expand-only sobre el esquema existente (REQ-GOB-011): ninguna migración ya aplicada
-- se edita.

create type public.bar_reputation_recommendation_status as enum ('pendiente', 'aplicada', 'descartada');

create table public.bar_reputation_recommendation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- Parámetros vigentes en el momento de la evaluación -- guardados junto con la
  -- recomendación (no solo referenciados) para que una recomendación vieja siga
  -- siendo interpretable aunque el hotel cambie su umbral/ventana después.
  umbral numeric(5, 2) not null check (umbral between 0 and 100),
  ventana_dias smallint not null check (ventana_dias > 0),
  -- Día real (dentro de la ventana evaluada) en que el índice pasó de abajo del
  -- umbral a arriba/igual -- ver `detectarCruceDeUmbral()`. Es la clave de
  -- idempotencia junto con `hotel_id` (índice único de abajo).
  fecha_cruce date not null,
  indice_antes_de_cruce numeric(5, 2) not null check (indice_antes_de_cruce between 0 and 100),
  indice_actual numeric(5, 2) not null check (indice_actual between 0 and 100),
  -- Siempre dentro de ±10-15% -- el MISMO rango de variación que REQ-REV-003 exige
  -- para cualquier cambio de tarifa en modo "propone" (`revenueEngineGate.ts`,
  -- `PROPONE_VARIATION_PCT_MIN`/`MAX`): esta recomendación nunca sugiere un número que
  -- el propio motor de revenue rechazaría por exceder ese límite de gobierno.
  ajuste_porcentaje numeric(4, 1) not null check (ajuste_porcentaje between 10.0 and 15.0),
  razon text not null,
  status public.bar_reputation_recommendation_status not null default 'pendiente',
  resolved_by uuid references public.staff_user(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index bar_reputation_recommendation_hotel_cruce_idx
  on public.bar_reputation_recommendation (hotel_id, fecha_cruce);
create index bar_reputation_recommendation_tenant_hotel_created_idx
  on public.bar_reputation_recommendation (tenant_id, hotel_id, created_at desc);

alter table public.bar_reputation_recommendation enable row level security;

-- Quién ve/resuelve una recomendación de ajuste de tarifa: owner/gm (dueños de la
-- decisión de revenue) + accountant (mismo criterio que `revenue_backtest_run`/
-- `guest_review_action`: cualquier cosa que toque tarifas/dinero incluye a quien lleva
-- las cuentas). Sin frontdesk/reservations aquí -- a diferencia de una reseña
-- individual (`guest_review`), esto es una decisión de pricing, no de servicio al
-- huésped en el momento.
create policy "bar_reputation_recommendation_select" on public.bar_reputation_recommendation for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  );
-- Resolver (marcar aplicada/descartada) -- igual set de roles que puede verla; nunca
-- pueden cambiar `umbral`/`ventana_dias`/`indice_*`/`ajuste_porcentaje`/`fecha_cruce`
-- (los valores que el sistema calculó), solo `status`/`resolved_by`/`resolved_at`, pero
-- eso se exige a nivel de aplicación (mismo patrón que `guest_review_action`, que
-- tampoco lo fuerza con un CHECK de columnas inmutables individual).
create policy "bar_reputation_recommendation_update" on public.bar_reputation_recommendation for update to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  )
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  );
-- Sin policy de insert para `authenticated`: toda escritura pasa por
-- record_bar_reputation_recommendation() (SECURITY DEFINER, abajo) -- mismo patrón que
-- record_fraud_alert (0095), esta es una tabla de HALLAZGOS calculados por el sistema,
-- no un formulario que el staff llena a mano.

grant select, update on public.bar_reputation_recommendation to authenticated;

-- record_bar_reputation_recommendation(): valida al actor real (cuando existe sesión)
-- contra su propia membresía de tenant/hotel ANTES de insertar -- mismo arreglo que
-- record_fraud_alert() (0095)/record_audit_log() (0016). `on conflict` sobre
-- `bar_reputation_recommendation_hotel_cruce_idx`: una re-evaluación del mismo cruce
-- NUNCA inserta una segunda fila -- el llamador usa `is_new` para decidir si además
-- dispara una notificación (nunca reenvía la misma recomendación dos veces).
create or replace function public.record_bar_reputation_recommendation(
  _tenant_id uuid,
  _hotel_id uuid,
  _umbral numeric,
  _ventana_dias smallint,
  _fecha_cruce date,
  _indice_antes_de_cruce numeric,
  _indice_actual numeric,
  _ajuste_porcentaje numeric,
  _razon text
)
returns table (id uuid, is_new boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_id uuid;
begin
  v_actor := auth.uid();
  if v_actor is not null then
    if _tenant_id is null or not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (record_bar_reputation_recommendation)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if _hotel_id is null or not (_hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (record_bar_reputation_recommendation)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  insert into public.bar_reputation_recommendation
    (tenant_id, hotel_id, umbral, ventana_dias, fecha_cruce, indice_antes_de_cruce, indice_actual, ajuste_porcentaje, razon)
  values
    (_tenant_id, _hotel_id, _umbral, _ventana_dias, _fecha_cruce, _indice_antes_de_cruce, _indice_actual, _ajuste_porcentaje, _razon)
  on conflict (hotel_id, fecha_cruce) do nothing
  returning bar_reputation_recommendation.id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;

  select brr.id into v_id from public.bar_reputation_recommendation brr
    where brr.hotel_id = _hotel_id and brr.fecha_cruce = _fecha_cruce;
  return query select v_id, false;
end;
$$;

revoke all on function public.record_bar_reputation_recommendation(uuid, uuid, numeric, smallint, date, numeric, numeric, numeric, text) from public;
grant execute on function public.record_bar_reputation_recommendation(uuid, uuid, numeric, smallint, date, numeric, numeric, numeric, text) to atiende_app, authenticated;
