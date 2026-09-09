-- ORIGEN: packages/db/migrations/0111_entitlement.sql sha256:490a411f1a7c4736d011f824d478898a98e2824f95f2808f397ca6e34c24ae31
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H12c · Entitlement (uso real vs límites del plan, REQ-GOB-012/H18-005: "la factura
-- nunca llega sin su justificación" -- aquí además: "el bloqueo nunca llega sin su
-- justificación"). Dos funciones, ambas SECURITY DEFINER porque cuentan filas de tablas
-- de OTROS módulos (hotel/room/agent_config/message) a través de todo el org, algo que
-- `authenticated` normal no podría hacer de forma eficiente sin exponer más RLS de la
-- necesaria -- el propio cálculo ya filtra siempre por `_org_id`, nunca por un valor que
-- el llamador controle libremente sin verificar membresía primero (ver
-- apps/api/src/lib/entitlement.ts, que exige `is_org_admin`/membresía ANTES de llamar).
--
-- `entitlement_usage()` es de solo lectura (para pintar "18/20 habitaciones" en
-- /suscripcion); `check_entitlement()` es la que se invoca ANTES de crear un recurso y
-- lanza una excepción con un código estable (`entitlement_exceeded:<recurso>` o
-- `entitlement_exceeded:suscripcion_inactiva`) que apps/api traduce a un 402/403 con
-- mensaje explícito -- nunca un bloqueo silencioso (REQ-UX-002, mismo criterio que
-- "estados vacíos honestos").

create or replace function public.entitlement_usage(_org_id uuid)
returns table (
  hoteles integer,
  habitaciones integer,
  agentes_activos integer,
  mensajes_mes integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::integer from public.hotel where org_id = _org_id),
    (select count(*)::integer from public.room r join public.hotel h on h.id = r.hotel_id where h.org_id = _org_id),
    (select count(*)::integer from public.agent_config where org_id = _org_id and gate <> 'shadow'),
    (select count(*)::integer from public.message
       where tenant_id = _org_id
         and created_at >= date_trunc('month', now()))
$$;
revoke all on function public.entitlement_usage(uuid) from public;
grant execute on function public.entitlement_usage(uuid) to atiende_app, authenticated;

-- `_resource` ∈ {'hoteles', 'habitaciones', 'agentes_activos', 'mensajes_mes'}.
-- `_wanted_increment`: cuántas unidades MÁS se van a crear (1 para "crear 1 hotel más").
-- Sin fila en `subscription` para el org: fail-closed -- se trata como si el plan más
-- restrictivo (Starter recién sembrado) ya estuviera excedido, nunca como "sin límite".
create or replace function public.check_entitlement(_org_id uuid, _resource text, _wanted_increment integer default 1)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _status public.subscription_status;
  _limit integer;
  _usage integer;
begin
  if _resource not in ('hoteles', 'habitaciones', 'agentes_activos', 'mensajes_mes') then
    raise exception 'recurso_invalido: %', _resource;
  end if;

  select s.status,
    case _resource
      when 'hoteles' then p.max_hoteles
      when 'habitaciones' then p.max_habitaciones
      when 'agentes_activos' then p.max_agentes_activos
      when 'mensajes_mes' then p.max_mensajes_mes
    end
  into _status, _limit
  from public.subscription s
  join public.plan p on p.id = s.plan_id
  where s.org_id = _org_id;

  if _status is null then
    raise exception 'entitlement_exceeded:sin_suscripcion' using hint = 'No existe una suscripción para esta organización.';
  end if;

  if _status in ('vencida', 'cancelada') then
    raise exception 'entitlement_exceeded:suscripcion_inactiva' using hint = format('La suscripción está %s.', _status);
  end if;

  -- NULL = ilimitado (Enterprise) -- nunca se bloquea.
  if _limit is null then
    return;
  end if;

  select case _resource
    when 'hoteles' then u.hoteles
    when 'habitaciones' then u.habitaciones
    when 'agentes_activos' then u.agentes_activos
    when 'mensajes_mes' then u.mensajes_mes
  end
  into _usage
  from public.entitlement_usage(_org_id) u;

  if (_usage + _wanted_increment) > _limit then
    raise exception 'entitlement_exceeded:%', _resource
      using hint = format('Límite del plan alcanzado: %s/%s (%s).', _usage, _limit, _resource);
  end if;
end;
$$;
revoke all on function public.check_entitlement(uuid, text, integer) from public;
grant execute on function public.check_entitlement(uuid, text, integer) to atiende_app, authenticated;
