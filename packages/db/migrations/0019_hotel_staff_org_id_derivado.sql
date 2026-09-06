-- auditoria-1/datos [CRITICO] "hotel_staff.org_id no se valida contra hotel.org_id
-- real: un owner/gm de un hotel puede fabricar membresia con org_id de otro tenant y
-- ver su org/location" (docs/auditoria-1/datos.md). La policy `hotel_staff_manage_insert`
-- (0003) solo exige `has_hotel_role(hotel_id, ['owner','gm'])` -- nunca compara
-- `org_id` de la fila contra el `org_id` REAL de `hotel_id`. Verificado: un owner real
-- podia insertar `hotel_staff(org_id=<org ajeno>, hotel_id=<su hotel real>, ...)` y el
-- nuevo usuario quedaba con `current_tenant_ids()` apuntando a un tenant con el que no
-- tiene ninguna relacion legitima, exponiendole el catalogo org/location ajeno via
-- `org_member_select`/`location_member_select` (que solo filtran por org_id).
--
-- Arreglo: `org_id` deja de ser un valor que el cliente controla -- un trigger
-- BEFORE INSERT/UPDATE lo SOBRESCRIBE siempre con el `org_id` real de `hotel_id`
-- (derivado, nunca solo validado): cualquier valor que la sesion intente fijar en
-- `org_id` se descarta. Es la misma tecnica de "columna de scope derivada, no confiada
-- al cliente" que ya usa el propio esquema (auth.uid() para `actor_user_id`).
create or replace function public.hotel_staff_derive_org_id()
returns trigger
language plpgsql
as $$
declare
  v_real_org_id uuid;
begin
  select org_id into v_real_org_id from public.hotel where id = new.hotel_id;

  if v_real_org_id is null then
    raise exception 'hotel_inexistente: no existe hotel % para hotel_staff', new.hotel_id
      using errcode = '23503';
  end if;

  new.org_id := v_real_org_id;
  return new;
end;
$$;

create trigger hotel_staff_derive_org_id_trg
  before insert or update of hotel_id, org_id on public.hotel_staff
  for each row execute function public.hotel_staff_derive_org_id();
