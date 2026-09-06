-- auditoria-2/seguridad [ALTO]: "set_identity_checkout() (SECURITY DEFINER) permite
-- alterar el reloj de retencion de la boveda de identidad de otro hotel". A diferencia
-- de `register_identity_document`/`read_identity_vault_document` (mismo archivo 0051),
-- esta funcion no validaba nada: cualquier `authenticated` podia adelantar el
-- `checkout_at` de la reserva de OTRO hotel, haciendo que el job de purga borre
-- fisicamente un documento de identidad antes de tiempo, sin que el hotel dueno lo
-- autorice ni se entere (y sin rastro: la funcion no dejaba audit_log).
--
-- Arreglo: mismo criterio que 0016/0051/0062/0063 -- resuelve la reserva REAL primero
-- y valida `tenant_id`/`hotel_id` del actor contra ELLA (nunca contra un parametro
-- libre) cuando existe una sesion real; agrega ademas `record_audit_log` (antes no
-- dejaba ningun rastro de quien adelanto el reloj de retencion, ni siquiera en el uso
-- legitimo).
create or replace function public.set_identity_checkout(_reservation_id uuid, _checkout_at timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_res public.reservation;
  v_count integer;
begin
  select * into v_res from public.reservation where id = _reservation_id;
  if not found then
    raise exception 'reserva_no_encontrada: %', _reservation_id using errcode = 'P0001';
  end if;

  v_actor := auth.uid();
  if v_actor is not null then
    if not (v_res.tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion de la reserva % (set_identity_checkout)', v_actor, _reservation_id
        using errcode = '42501';
    end if;
    if not (v_res.hotel_id = any (current_hotel_ids())) then
      raise exception 'hotel_no_autorizado: el actor % no pertenece al hotel de la reserva % (set_identity_checkout)', v_actor, _reservation_id
        using errcode = '42501';
    end if;
  end if;

  update public.identity_vault
  set checkout_at = _checkout_at
  where reservation_id = _reservation_id and checkout_at is null;

  select count(*)::integer into v_count
  from public.identity_vault
  where reservation_id = _reservation_id and checkout_at is not null;

  if v_count > 0 then
    perform public.record_audit_log(v_res.tenant_id, v_res.hotel_id, 'identity_vault.checkout_set', 'reservation', v_res.id,
      jsonb_build_object('checkoutAt', _checkout_at));
  end if;

  return v_count;
end;
$$;

revoke all on function public.set_identity_checkout(uuid, timestamptz) from public;
grant execute on function public.set_identity_checkout(uuid, timestamptz) to atiende_app, authenticated;
