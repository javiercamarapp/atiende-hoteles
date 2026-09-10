-- H6b-notif · Notificación ACTIVA por WhatsApp al crear un `housekeeping_task`/
-- `maintenance_ticket`/`guest_ticket` (apps/api routes + packages/agent-core/src/tools/
-- staffNotify.ts). Hallazgo al conectar esa notificación contra la sesión RLS real de un
-- staff (no el cliente admin): la migración 0011 REVOCÓ el SELECT de fila completa sobre
-- `staff_user` que 0010 había otorgado y lo reemplazó por uno acotado a columnas
-- (`id, email, full_name, created_at, updated_at`) -- `whatsapp_phone` (0053) quedó
-- deliberadamente FUERA de ese grant (0053 solo agrega UPDATE de esa columna, para que
-- cada quien registre el suyo, nunca SELECT). Cualquier intento de leer
-- `staff_user.whatsapp_phone` con la sesión normal de un staff (`dbSession`, RLS activa)
-- falla con "permission denied for table staff_user" -- correcto para una query libre
-- desde el cliente, pero bloquea también la necesidad legítima del SERVIDOR de resolver
-- a quién notificarle una tarea/ticket nuevo.
--
-- Mismo patrón que `record_fraud_alert()`/`upsert_staff_schedule()` (SECURITY DEFINER,
-- valida membresía del actor ANTES de tocar el dato): esta función es la ÚNICA vía para
-- resolver destinatarios de notificación por WhatsApp, en vez de reabrir el SELECT de
-- fila completa (que sí expondría `whatsapp_phone` a cualquier lectura libre) o de saltar
-- a `engine.admin` desde la ruta HTTP (bypassa RLS por completo en vez de acotar
-- exactamente lo necesario).
create or replace function public.staff_notify_recipients(
  _hotel_id uuid,
  _role public.hotel_role,
  _assigned_to uuid default null
)
returns table (id uuid, whatsapp_phone text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_assigned_tiene_telefono boolean := false;
begin
  -- Defensa en profundidad (igual que record_fraud_alert): con una sesión de staff real
  -- (`auth.uid()` no nulo), el actor debe pertenecer de verdad a `_hotel_id` -- sin esto,
  -- un staff de OTRO hotel/organización podría sondear teléfonos ajenos. Sin sesión de
  -- staff (`auth.uid()` nulo -- llamado con el cliente admin/servicio, p.ej. desde un
  -- trabajo en segundo plano), el chequeo se omite, igual que record_audit_log().
  if auth.uid() is not null and not public.is_hotel_staff(_hotel_id) then
    raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel % (staff_notify_recipients)', auth.uid(), _hotel_id
      using errcode = '42501';
  end if;

  -- El staff YA ASIGNADO (si lo hay y tiene teléfono registrado) tiene prioridad sobre
  -- el rol/departamento -- mismo criterio que notifyStaffOfNewTask (staffNotify.ts).
  if _assigned_to is not null then
    select exists (
      select 1
      from public.staff_user su
      join public.hotel_staff hs on hs.user_id = su.id and hs.hotel_id = _hotel_id
      where su.id = _assigned_to and su.whatsapp_phone is not null
    ) into v_assigned_tiene_telefono;
  end if;

  if v_assigned_tiene_telefono then
    return query select su.id, su.whatsapp_phone from public.staff_user su where su.id = _assigned_to;
    return;
  end if;

  return query
    select su.id, su.whatsapp_phone
    from public.staff_user su
    join public.hotel_staff hs on hs.user_id = su.id
    where hs.hotel_id = _hotel_id and hs.role = _role and su.whatsapp_phone is not null;
end;
$$;

revoke all on function public.staff_notify_recipients(uuid, public.hotel_role, uuid) from public;
grant execute on function public.staff_notify_recipients(uuid, public.hotel_role, uuid) to atiende_app, authenticated;
