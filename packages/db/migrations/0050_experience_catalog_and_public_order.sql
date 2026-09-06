-- REQ-TEN-004 (GOB-039): "Toda escritura anónima o de bajo privilegio (registro
-- público de check-in, pedidos de huésped sin cuenta, catálogo de experiencias) debe
-- pasar exclusivamente por una función RPC SECURITY DEFINER que recalcule los valores
-- en servidor, nunca aceptando el valor/precio enviado por el cliente."
--
-- Instancia concreta elegida: catálogo de experiencias + pedido público de huésped SIN
-- cuenta (verificado por código de reserva + apellido, mismo criterio que
-- `cancel_reservation_public`, migración 0013/REQ-RES-005). El precio SIEMPRE se lee
-- del catálogo del servidor (`experience_catalog.price`) -- la función
-- `order_experience_public` no declara ningún parámetro de precio/total: es
-- ESTRUCTURALMENTE imposible que un cliente influya en el monto cobrado, no solo una
-- validación que podría olvidarse (ver tests/adversarial/rpc-security-definer.spec.ts).
--
-- El rate limit por IP (REQ-TEN-004 "con rate limit") ya se aplica de forma GLOBAL a
-- toda ruta de apps/api (`ipRateLimit`, apps/api/src/middleware.ts, montado en
-- apps/api/src/app.ts) -- esta ruta pública no necesita ni declara uno adicional.
--
-- Expand-only sobre migraciones ya mergeadas (REQ-GOB-010): tablas nuevas, ninguna
-- migración existente se edita.

create table public.experience_catalog (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  name text not null,
  description text,
  price numeric(12, 2) not null check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index experience_catalog_tenant_hotel_idx on public.experience_catalog (tenant_id, hotel_id);
create index experience_catalog_hotel_active_idx on public.experience_catalog (hotel_id) where active;

alter table public.experience_catalog enable row level security;

-- Gestión del catálogo: solo owner/gm (mismo criterio que `hotel_tax_config`, 0013 --
-- fijar precios de venta al público es una decisión de negocio, no operativa).
create policy "experience_catalog_tenant_select" on public.experience_catalog for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "experience_catalog_tenant_insert" on public.experience_catalog for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "experience_catalog_tenant_update" on public.experience_catalog for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

-- Pedidos: registro append-only de lo que un huésped SIN cuenta pidió del catálogo,
-- ya con el precio/total recalculado en servidor. `client_request_id` es la llave de
-- idempotencia opcional del propio cliente (huésped) para tolerar reintento de red sin
-- duplicar el cargo -- mismo espíritu que `Idempotency-Key`, ver
-- apps/api/src/lib/idempotency.ts, pero embebida en la función SECURITY DEFINER porque
-- aquí no existe todavía un `tenant_id` conocido antes de verificar identidad.
create table public.experience_order (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete restrict,
  experience_id uuid not null references public.experience_catalog(id) on delete restrict,
  quantity integer not null check (quantity between 1 and 20),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  total_amount numeric(12, 2) not null check (total_amount >= 0),
  folio_charge_id uuid references public.charge(id) on delete set null,
  client_request_id text,
  created_at timestamptz not null default now()
);
create index experience_order_reservation_idx on public.experience_order (reservation_id);
create index experience_order_tenant_hotel_idx on public.experience_order (tenant_id, hotel_id);
-- Idempotencia real: mismo (reservation_id, client_request_id) no puede insertar dos
-- filas -- `order_experience_public` hace SELECT antes de INSERT (ver más abajo), pero
-- este índice es la garantía de fondo bajo concurrencia real (dos requests a la vez).
create unique index experience_order_reservation_client_request_idx
  on public.experience_order (reservation_id, client_request_id)
  where client_request_id is not null;

alter table public.experience_order enable row level security;

-- Solo lectura para roles con acceso a dinero del hotel (mismo criterio que
-- `folio`/`charge`, 0007) -- ninguna policy de insert/update para `authenticated`:
-- toda escritura pasa por `order_experience_public` (SECURITY DEFINER, abajo).
create policy "experience_order_money_role_select" on public.experience_order for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
grant select on public.experience_order to authenticated;
grant select on public.experience_catalog to authenticated;

-- list_experience_catalog_public(): catálogo activo de un hotel, sin autenticación --
-- solo expone nombre/descripción/precio (nunca datos de otro huésped ni de otro
-- hotel), consistente con REQ-HUE-023 "nunca revelar... a terceros".
create or replace function public.list_experience_catalog_public(_hotel_id uuid)
returns table (id uuid, name text, description text, price numeric)
language sql
security definer
set search_path = public
stable
as $$
  select ec.id, ec.name, ec.description, ec.price
  from public.experience_catalog ec
  where ec.hotel_id = _hotel_id and ec.active = true
  order by ec.name;
$$;

revoke all on function public.list_experience_catalog_public(uuid) from public;
grant execute on function public.list_experience_catalog_public(uuid) to atiende_app, authenticated;

-- order_experience_public(): ver cabecera de este archivo. Nótese la AUSENCIA
-- deliberada de cualquier parámetro de precio/total.
create or replace function public.order_experience_public(
  _confirmation_code text,
  _apellido text,
  _experience_id uuid,
  _quantity integer,
  _client_request_id text default null
)
returns table (order_id uuid, unit_price numeric, total_amount numeric, ya_registrado boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res public.reservation;
  v_res_found boolean;
  v_guest_name text;
  v_exp public.experience_catalog;
  v_existing public.experience_order;
  v_order public.experience_order;
  v_folio_id uuid;
  v_charge_id uuid;
begin
  select r.* into v_res
  from public.reservation r
  where r.confirmation_code = upper(trim(_confirmation_code))
  for update of r;
  v_res_found := found;

  if v_res_found then
    select g.full_name into v_guest_name from public.guest g where g.id = v_res.guest_id;
  end if;

  -- Mismo criterio de "sin fuga" que `cancel_reservation_public` (0013): un solo
  -- mensaje de error genérico, nunca revela si el código o el apellido fue la parte
  -- incorrecta.
  if not v_res_found
     or v_guest_name is null
     or length(trim(coalesce(_apellido, ''))) = 0
     or position(lower(trim(_apellido)) in lower(v_guest_name)) = 0 then
    raise exception 'pedido_no_verificado: código de reserva o apellido no coinciden'
      using errcode = 'P0001';
  end if;

  if v_res.status not in ('confirmada', 'check_in', 'en_estancia') then
    raise exception 'reserva_no_activa: la reserva % no admite pedidos en estado %',
      v_res.id, v_res.status
      using errcode = 'P0001';
  end if;

  if _quantity is null or _quantity < 1 or _quantity > 20 then
    raise exception 'cantidad_invalida: la cantidad debe ser entre 1 y 20' using errcode = 'P0001';
  end if;

  if _client_request_id is not null then
    select * into v_existing from public.experience_order
    where reservation_id = v_res.id and client_request_id = _client_request_id;
    if found then
      return query select v_existing.id, v_existing.unit_price, v_existing.total_amount, true;
      return;
    end if;
  end if;

  select * into v_exp from public.experience_catalog
  where id = _experience_id and hotel_id = v_res.hotel_id and active = true;
  if not found then
    raise exception 'experiencia_no_disponible: la experiencia solicitada no existe o no está activa para este hotel'
      using errcode = 'P0001';
  end if;

  -- El monto SIEMPRE sale de `v_exp.price` (leído arriba del catálogo del servidor),
  -- nunca de un parámetro de esta función -- no hay ninguno para precio/total.
  insert into public.experience_order
    (tenant_id, hotel_id, reservation_id, experience_id, quantity, unit_price, total_amount, client_request_id)
  values
    (v_res.tenant_id, v_res.hotel_id, v_res.id, v_exp.id, _quantity, v_exp.price, round(v_exp.price * _quantity, 2), _client_request_id)
  on conflict (reservation_id, client_request_id) where client_request_id is not null do nothing
  returning * into v_order;

  if v_order.id is null then
    -- Carrera resuelta por el índice único: otra sesión ganó el mismo
    -- (reservation_id, client_request_id) entre nuestro SELECT y este INSERT.
    select * into v_order from public.experience_order
    where reservation_id = v_res.id and client_request_id = _client_request_id;
    return query select v_order.id, v_order.unit_price, v_order.total_amount, true;
    return;
  end if;

  select f.id into v_folio_id from public.folio f
  where f.reservation_id = v_res.id and f.is_primary
  limit 1;

  if v_folio_id is not null then
    insert into public.charge (tenant_id, hotel_id, folio_id, description, amount, tax_amount, concept)
    values (v_res.tenant_id, v_res.hotel_id, v_folio_id,
            'Experiencia: ' || v_exp.name || ' x' || _quantity, v_order.total_amount, 0, 'extras')
    returning id into v_charge_id;
    update public.experience_order set folio_charge_id = v_charge_id where id = v_order.id;
  end if;

  perform public.record_audit_log(
    v_res.tenant_id, v_res.hotel_id, 'experience_order.created', 'experience_order', v_order.id,
    jsonb_build_object('reservationId', v_res.id, 'experienceId', v_exp.id, 'quantity', _quantity, 'totalAmount', v_order.total_amount)
  );

  return query select v_order.id, v_order.unit_price, v_order.total_amount, false;
end;
$$;

revoke all on function public.order_experience_public(text, text, uuid, integer, text) from public;
grant execute on function public.order_experience_public(text, text, uuid, integer, text) to atiende_app, authenticated;
