-- ORIGEN: packages/db/migrations/0114_notification_triggers.sql sha256:a0e7fa8484bdea8c81ee501c17ccaf12aa6466731420399fdce0301142ef1993
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H12c · Emisión de notificaciones para "eventos clave" (REQ-UX/H18-006 health score:
-- el dueño debe enterarse de lo importante sin tener que ir a buscarlo). Se implementa
-- con TRIGGERS de base de datos, no modificando las rutas de apps/api que ya existen
-- (reservas.ts, aprobaciones.ts, mantenimiento.ts, night-audit.ts, mensajeria.ts, todas
-- fuera del alcance de este hito/propiedad de otros agentes en paralelo) -- el mismo
-- patrón de "outbox alimentado por trigger" que ya usa este esquema (ver comentario de
-- `agent_approval`, 0042: "un evento de dominio se registra en el mismo INSERT que lo
-- origina"). Todas las funciones son SECURITY DEFINER: deben poder insertar la
-- notificación sin importar el rol RLS de quien disparó el evento (p. ej. `housekeeping`
-- reportando un ticket no tiene por qué tener permiso de insertar una notificación para
-- `gm`).

-- 1) Reserva confirmada -> avisa a frontdesk/reservations del hotel.
create or replace function public.notify_reserva_confirmada()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.to_status = 'confirmada' and (OLD is null or OLD.to_status is distinct from NEW.to_status) then
    insert into public.notification (tenant_id, hotel_id, recipient_role, type, title, body, link)
    select NEW.tenant_id, NEW.hotel_id, r.role, 'reserva_nueva', 'Nueva reserva confirmada',
      'Se confirmó una reserva. Revisa el detalle en el panel de reservas.',
      '/reservas/' || NEW.reservation_id
    from unnest(array['frontdesk', 'reservations']::public.hotel_role[]) as r(role);
  end if;
  return NEW;
end;
$$;
create trigger notification_reserva_confirmada
  after insert on public.reservation_status_event
  for each row execute function public.notify_reserva_confirmada();

-- 2) Aprobación pendiente -> avisa a owner/gm.
create or replace function public.notify_aprobacion_pendiente()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status = 'pendiente' then
    insert into public.notification (tenant_id, hotel_id, recipient_role, type, title, body, link)
    select NEW.org_id, NEW.hotel_id, r.role, 'aprobacion_pendiente', 'Aprobación pendiente',
      'Hay una acción de agente esperando tu aprobación: ' || NEW.tool_name || '.',
      '/aprobaciones'
    from unnest(array['owner', 'gm']::public.hotel_role[]) as r(role);
  end if;
  return NEW;
end;
$$;
create trigger notification_aprobacion_pendiente
  after insert on public.agent_approval
  for each row execute function public.notify_aprobacion_pendiente();

-- 3) Ticket de mantenimiento urgente (severidad alta) -> avisa a maintenance/gm.
create or replace function public.notify_ticket_urgente()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.severity = 'alta' then
    insert into public.notification (tenant_id, hotel_id, recipient_role, type, title, body, link)
    select NEW.tenant_id, NEW.hotel_id, r.role, 'ticket_urgente', 'Ticket de mantenimiento urgente',
      'Nuevo ticket urgente: ' || NEW.title || '.',
      '/mantenimiento'
    from unnest(array['maintenance', 'gm']::public.hotel_role[]) as r(role);
  end if;
  return NEW;
end;
$$;
create trigger notification_ticket_urgente
  after insert on public.maintenance_ticket
  for each row execute function public.notify_ticket_urgente();

-- 4) Night audit cerrado -> avisa a gm/owner.
create or replace function public.notify_night_audit_cerrado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status = 'completado' and (OLD is null or OLD.status is distinct from NEW.status) then
    insert into public.notification (tenant_id, hotel_id, recipient_role, type, title, body, link)
    select NEW.tenant_id, NEW.hotel_id, r.role, 'night_audit_cerrado', 'Night audit cerrado',
      'El corte de caja del ' || NEW.business_date || ' quedó cerrado.',
      '/back-office'
    from unnest(array['gm', 'owner']::public.hotel_role[]) as r(role);
  end if;
  return NEW;
end;
$$;
create trigger notification_night_audit_cerrado
  after update on public.night_audit_run
  for each row execute function public.notify_night_audit_cerrado();

-- 5) Límite de plan al 80% -- H18-006 (health score/riesgo de expansión). Deduplica: no
-- inserta un aviso nuevo si ya existe uno del MISMO org+recurso en las últimas 24h
-- (evita saturar la campana en una ráfaga de altas). `_resource` es el nombre exacto que
-- usa `check_entitlement()`/`entitlement_usage()` (0111).
create or replace function public.notify_if_plan_threshold(_org_id uuid, _resource text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _limit integer;
  _usage integer;
  _title text := 'Límite de plan: ' || _resource;
begin
  select
    case _resource
      when 'hoteles' then p.max_hoteles
      when 'habitaciones' then p.max_habitaciones
      when 'agentes_activos' then p.max_agentes_activos
      when 'mensajes_mes' then p.max_mensajes_mes
    end
  into _limit
  from public.subscription s join public.plan p on p.id = s.plan_id
  where s.org_id = _org_id;

  if _limit is null then
    return; -- sin suscripción o límite ilimitado (Enterprise): nada que avisar.
  end if;

  select case _resource
    when 'hoteles' then u.hoteles
    when 'habitaciones' then u.habitaciones
    when 'agentes_activos' then u.agentes_activos
    when 'mensajes_mes' then u.mensajes_mes
  end
  into _usage
  from public.entitlement_usage(_org_id) u;

  if _usage::numeric / _limit::numeric < 0.8 then
    return;
  end if;

  if exists (
    select 1 from public.notification
    where tenant_id = _org_id and type = 'limite_plan' and title = _title
      and created_at > now() - interval '24 hours'
  ) then
    return;
  end if;

  insert into public.notification (tenant_id, hotel_id, recipient_role, type, title, body, link)
  select _org_id, null, r.role, 'limite_plan', _title,
    format('Tu plan lleva %s de %s (%s) usados este periodo. Considera actualizar tu plan.', _usage, _limit, _resource),
    '/suscripcion'
  from unnest(array['owner', 'gm']::public.hotel_role[]) as r(role);
end;
$$;
revoke all on function public.notify_if_plan_threshold(uuid, text) from public;
grant execute on function public.notify_if_plan_threshold(uuid, text) to atiende_app;

create or replace function public.trg_notify_plan_hoteles()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.notify_if_plan_threshold(NEW.org_id, 'hoteles'); return NEW; end;
$$;
create trigger notification_plan_hoteles after insert on public.hotel
  for each row execute function public.trg_notify_plan_hoteles();

create or replace function public.trg_notify_plan_habitaciones()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.notify_if_plan_threshold(NEW.tenant_id, 'habitaciones'); return NEW; end;
$$;
create trigger notification_plan_habitaciones after insert on public.room
  for each row execute function public.trg_notify_plan_habitaciones();

create or replace function public.trg_notify_plan_agentes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.gate <> 'shadow' and (TG_OP = 'INSERT' or OLD.gate = 'shadow') then
    perform public.notify_if_plan_threshold(NEW.org_id, 'agentes_activos');
  end if;
  return NEW;
end;
$$;
create trigger notification_plan_agentes after insert or update on public.agent_config
  for each row execute function public.trg_notify_plan_agentes();

create or replace function public.trg_notify_plan_mensajes()
returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.notify_if_plan_threshold(NEW.tenant_id, 'mensajes_mes'); return NEW; end;
$$;
create trigger notification_plan_mensajes after insert on public.message
  for each row execute function public.trg_notify_plan_mensajes();
