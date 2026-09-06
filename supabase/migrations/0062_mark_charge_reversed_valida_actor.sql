-- ORIGEN: packages/db/migrations/0062_mark_charge_reversed_valida_actor.sql sha256:ff5b13164cd49b0d8770eb9b9d99622f936616709abc660131ff5a3f7fb9ea91
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- auditoria-2/seguridad [CRITICO]: "mark_charge_reversed() (SECURITY DEFINER) no
-- valida que el actor pertenezca al hotel del cargo: cualquier staff autenticado
-- reversa un cargo de cualquier hotel". La funcion (0030) solo comprobaba que el cargo
-- existiera y no estuviera ya reversado -- ni `current_tenant_ids()` ni
-- `can_access_money()` se evaluaban, pese a que la propia migracion admitia
-- explicitamente "la autorizacion real ya ocurrio en la capa de aplicacion" (mismo
-- patron que `record_audit_log` ANTES de 0016).
--
-- Arreglo: mismo criterio que 0016/0051 -- valida `tenant_id`/`can_access_money(hotel)`
-- del CARGO REAL (nunca de un parametro que el llamador podria inventar) contra la
-- membresia del actor SOLO cuando existe una sesion real (`auth.uid()` no nulo); una
-- llamada admin/CLI/seed sigue funcionando igual.
create or replace function public.mark_charge_reversed(_charge_id uuid, _reversal_charge_id uuid)
returns public.charge
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.charge;
  v_charge public.charge;
  v_actor uuid;
begin
  select * into v_charge from public.charge where id = _charge_id;
  if not found then
    raise exception 'reverso_invalido: el cargo % no existe o ya fue reversado', _charge_id
      using errcode = 'P0001';
  end if;

  v_actor := auth.uid();
  if v_actor is not null then
    if not (v_charge.tenant_id = any (current_tenant_ids())) then
      raise exception 'tenant_no_autorizado: el actor % no pertenece a la organizacion del cargo % (mark_charge_reversed)', v_actor, _charge_id
        using errcode = '42501';
    end if;
    if not can_access_money(v_charge.hotel_id) then
      raise exception 'hotel_no_autorizado: el actor % no tiene acceso a dinero en el hotel del cargo % (mark_charge_reversed)', v_actor, _charge_id
        using errcode = '42501';
    end if;
  end if;

  update public.charge
  set reversed_by = _reversal_charge_id
  where id = _charge_id and reversed_by is null
  returning * into v_row;

  if not found then
    raise exception 'reverso_invalido: el cargo % no existe o ya fue reversado', _charge_id
      using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.mark_charge_reversed(uuid, uuid) from public;
grant execute on function public.mark_charge_reversed(uuid, uuid) to atiende_app, authenticated;
