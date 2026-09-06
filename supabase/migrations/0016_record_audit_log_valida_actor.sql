-- ORIGEN: packages/db/migrations/0016_record_audit_log_valida_actor.sql sha256:9f02c63a3135a1fb46013c856d72c401624fa9b5b159e7fde8d79da35f082bf9
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- auditoria-1/seguridad [CRITICO] "record_audit_log() permite falsificar el audit_log
-- de cualquier organizacion, no solo de otro hotel" (docs/auditoria-1/seguridad.md).
--
-- `record_audit_log()` (0008) es SECURITY DEFINER y hasta ahora insertaba directo con
-- los parametros `_tenant_id`/`_hotel_id` que recibia, sin comparar contra la membresia
-- real (`current_tenant_ids()`/`current_hotel_ids()`) del `auth.uid()` de la sesion que
-- la invoca. Verificado: una sesion real `authenticated` como `housekeeping` de un
-- hotel podia llamar `record_audit_log('<org-ajena>', '<hotel-ajeno>', ...)` y la fila
-- quedaba insertada, correctamente encadenada por hash, en la cadena de auditoria de
-- una organizacion completamente ajena.
--
-- Arreglo: valida `_tenant_id`/`_hotel_id` contra la membresia real del actor SOLO
-- cuando existe un actor de sesion real (`auth.uid()` no nulo, ver 0001) -- una llamada
-- sin sesion (conexion admin/superusuario del runner/seed/tests, o un SECURITY DEFINER
-- de nivel superior como `cancel_reservation_public`, 0013, que ya verifico codigo de
-- reserva + apellido antes de llegar aqui) sigue funcionando exactamente igual: ya paso
-- por su propia autorizacion o es codigo de plataforma de confianza, nunca alcanzable
-- por un request HTTP externo con `authenticated` (toda ruta real de apps/api que
-- escribe audit_log corre dentro de `dbSession`, que SIEMPRE fija
-- `request.jwt.claim.sub` al usuario ya autenticado -- ver apps/api/src/middleware.ts).
--
-- Esto cierra exactamente el vector reportado sin tocar ningun caller legitimo: todo
-- llamador real de apps/api pasa `orgId`/`hotelId` ya verificados en vivo por
-- `requireHotelMembership` contra `hotel_staff`, asi que `_tenant_id`/`_hotel_id`
-- siempre coinciden con `current_tenant_ids()`/`current_hotel_ids()` del mismo actor.
create or replace function public.record_audit_log(
  _tenant_id uuid,
  _hotel_id uuid,
  _action text,
  _entity_type text,
  _entity_id uuid,
  _payload jsonb default '{}'::jsonb
)
returns public.audit_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.audit_log;
  v_actor uuid;
begin
  v_actor := auth.uid();

  if v_actor is not null then
    if _tenant_id is null or not (_tenant_id = any (current_tenant_ids())) then
      raise exception
        'tenant_no_autorizado: el actor % no pertenece a la organizacion % (record_audit_log)',
        v_actor, _tenant_id
        using errcode = '42501';
    end if;

    if _hotel_id is not null and not (_hotel_id = any (current_hotel_ids())) then
      raise exception
        'hotel_no_autorizado: el actor % no pertenece al hotel % (record_audit_log)',
        v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  insert into public.audit_log (tenant_id, hotel_id, actor_user_id, action, entity_type, entity_id, payload)
  values (_tenant_id, _hotel_id, v_actor, _action, _entity_type, _entity_id, _payload)
  returning * into v_row;

  return v_row;
end;
$$;
