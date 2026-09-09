-- ORIGEN: packages/db/migrations/0063_night_audit_valida_actor_y_no_reabre.sql sha256:bc155352e18b18fc44b545587eda3e9538573854fb1030244344674bb1780627
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- auditoria-2/seguridad [CRITICO]: "night_audit_claim()/night_audit_finish()
-- (SECURITY DEFINER) filtran y permiten falsificar el cierre de caja de cualquier
-- hotel". Ninguna de las dos funciones (0031) comparaba `_tenant_id`/`_hotel_id`/
-- `_run_id` contra la membresia real del actor, y `night_audit_finish` podia
-- re-terminar una corrida YA `completado` (de cualquier hotel), reemplazando su
-- `summary` -- sin guarda de estado ni de propiedad.
--
-- Arreglo:
--   1. `night_audit_claim`: valida `tenant_id`/`can_access_money(hotel_id)` del actor
--      real ANTES de tomar el advisory lock -- ningun rol sin acceso a dinero de OTRO
--      hotel puede ya ni reclamar ni leer el resumen financiero de una corrida ajena.
--   2. `night_audit_finish`: resuelve primero la corrida real (`v_run`), valida
--      `tenant_id`/`can_access_money(hotel_id)` de ESA corrida (nunca de un parametro
--      libre, la funcion no recibe hotel/tenant como argumento) contra el actor real, y
--      AGREGA la guarda que faltaba (`where status = 'en_progreso'`) para que una
--      corrida ya `completado` nunca pueda reemplazarse -- ni siquiera por un actor
--      legitimo del mismo hotel.
create or replace function public.night_audit_claim(
  _tenant_id uuid,
  _hotel_id uuid,
  _business_date date
)
returns table (run_id uuid, already_completed boolean, summary jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.night_audit_run;
  v_actor uuid;
begin
  v_actor := auth.uid();
  if v_actor is not null then
    if _tenant_id is null or not (_tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion % (night_audit_claim)', v_actor, _tenant_id
        using errcode = '42501';
    end if;
    if _hotel_id is null or not can_access_money(_hotel_id) then
      raise exception 'hotel_no_autorizado: el actor % no tiene acceso a dinero en el hotel % (night_audit_claim)', v_actor, _hotel_id
        using errcode = '42501';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('night_audit:' || _hotel_id::text || ':' || _business_date::text));

  insert into public.night_audit_run (tenant_id, hotel_id, business_date, status)
  values (_tenant_id, _hotel_id, _business_date, 'en_progreso')
  on conflict (hotel_id, business_date) do nothing
  returning * into v_row;

  if found then
    return query select v_row.id, false, v_row.summary;
    return;
  end if;

  select * into v_row from public.night_audit_run
  where hotel_id = _hotel_id and business_date = _business_date;

  return query select v_row.id, (v_row.status = 'completado'), v_row.summary;
end;
$$;

revoke all on function public.night_audit_claim(uuid, uuid, date) from public;
grant execute on function public.night_audit_claim(uuid, uuid, date) to atiende_app, authenticated;

create or replace function public.night_audit_finish(_run_id uuid, _summary jsonb)
returns public.night_audit_run
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.night_audit_run;
  v_run public.night_audit_run;
  v_actor uuid;
begin
  select * into v_run from public.night_audit_run where id = _run_id;
  if not found then
    raise exception 'night_audit_run_no_encontrado: %', _run_id using errcode = 'P0001';
  end if;

  v_actor := auth.uid();
  if v_actor is not null then
    if not (v_run.tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion de la corrida % (night_audit_finish)', v_actor, _run_id
        using errcode = '42501';
    end if;
    if not can_access_money(v_run.hotel_id) then
      raise exception 'hotel_no_autorizado: el actor % no tiene acceso a dinero en el hotel de la corrida % (night_audit_finish)', v_actor, _run_id
        using errcode = '42501';
    end if;
  end if;

  if v_run.status = 'completado' then
    raise exception 'night_audit_run_ya_completado: la corrida % ya fue cerrada, no puede re-terminarse ni reemplazar su resumen', _run_id
      using errcode = 'P0001';
  end if;

  update public.night_audit_run
  set status = 'completado', summary = _summary, completed_at = now()
  where id = _run_id and status = 'en_progreso'
  returning * into v_row;

  if not found then
    raise exception 'night_audit_run_no_encontrado: %', _run_id using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.night_audit_finish(uuid, jsonb) from public;
grant execute on function public.night_audit_finish(uuid, jsonb) to atiende_app, authenticated;
