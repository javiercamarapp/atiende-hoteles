-- REQ-AB-007 (P2/F, H10-011/H10-012): "El sistema debe soportar múltiples centros de
-- consumo con traspasos internos de inventario hacia/desde un almacén central, e
-- imputar automáticamente el costo del desayuno incluido con base en consumo teórico y
-- forecast de ocupación." La lógica de negocio pura vive en
-- `packages/domain-hotel/src/fnbCentrosConsumo.ts`; esta migración agrega el estado
-- real (centros, existencias, traspasos, config de costo) y la ÚNICA función que
-- decrementa/incrementa existencia con lock -- mismo patrón que `book_availability()`
-- (0004_room_inventory.sql): re-leer bajo lock, validar contra el dato real, nunca un
-- UPDATE ciego.

create type public.fnb_consumption_center_type as enum ('centro_consumo', 'almacen_central');

-- Un centro de consumo (restaurante, pool bar, room service, minibar, eventos, el
-- propio "desayuno"...) o el almacén central del hotel. `unique (hotel_id, id)` abajo
-- habilita las FK compuestas hotel-scoped de las tablas hijas (mismo criterio que
-- `guest_hotel_id_id_key`, 0064): un traspaso de Hotel A nunca puede referenciar un
-- centro de Hotel B.
create table public.fnb_consumption_center (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  nombre text not null check (length(trim(nombre)) > 0),
  tipo public.fnb_consumption_center_type not null default 'centro_consumo',
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (hotel_id, nombre),
  unique (hotel_id, id)
);
create index fnb_consumption_center_tenant_hotel_idx on public.fnb_consumption_center (tenant_id, hotel_id);
-- Un hotel tiene UN almacén central (el REQ habla de "un almacén central", singular) --
-- índice único parcial, no un check de fila (necesita ver las demás filas del hotel).
create unique index fnb_consumption_center_almacen_central_unique_idx
  on public.fnb_consumption_center (hotel_id)
  where tipo = 'almacen_central';

-- Existencia de un SKU en un centro específico. `unit_cost` es el costo unitario
-- vigente EN ESE CENTRO (puede diferir del origen tras varios traspasos con costos
-- distintos en el tiempo; este REQ no exige costeo PEPS/promedio ponderado, solo que el
-- costo quede registrado -- ver H12-005/REQ-AB-010 para merma, fuera de este alcance).
create table public.fnb_stock_item (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  center_id uuid not null references public.fnb_consumption_center(id) on delete cascade,
  sku text not null check (length(trim(sku)) > 0),
  nombre text not null check (length(trim(nombre)) > 0),
  unit_cost numeric(10, 2) not null default 0 check (unit_cost >= 0),
  quantity numeric(12, 3) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  unique (center_id, sku)
);
create index fnb_stock_item_tenant_hotel_idx on public.fnb_stock_item (tenant_id, hotel_id);
alter table public.fnb_stock_item
  add constraint fnb_stock_item_center_hotel_fk
  foreign key (hotel_id, center_id) references public.fnb_consumption_center (hotel_id, id)
  on delete cascade;

-- Traspaso interno registrado (append-only, nunca se edita/borra -- es la bitácora de
-- auditoría de existencia entre centros). El check de "debe involucrar al almacén
-- central" y el ajuste real de `fnb_stock_item` viven en `fnb_registrar_traspaso()`
-- abajo, no en un CHECK de esta tabla (necesita el `tipo` de OTRA tabla, que un CHECK no
-- puede leer).
create table public.fnb_inventory_transfer (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  from_center_id uuid not null references public.fnb_consumption_center(id) on delete restrict,
  to_center_id uuid not null references public.fnb_consumption_center(id) on delete restrict,
  sku text not null check (length(trim(sku)) > 0),
  quantity numeric(12, 3) not null check (quantity > 0),
  unit_cost_snapshot numeric(10, 2) not null check (unit_cost_snapshot >= 0),
  transferred_by uuid references public.staff_user(id) on delete set null,
  nota text,
  created_at timestamptz not null default now(),
  check (from_center_id <> to_center_id)
);
create index fnb_inventory_transfer_tenant_hotel_idx on public.fnb_inventory_transfer (tenant_id, hotel_id, created_at);
alter table public.fnb_inventory_transfer
  add constraint fnb_inventory_transfer_from_hotel_fk
  foreign key (hotel_id, from_center_id) references public.fnb_consumption_center (hotel_id, id) on delete restrict;
alter table public.fnb_inventory_transfer
  add constraint fnb_inventory_transfer_to_hotel_fk
  foreign key (hotel_id, to_center_id) references public.fnb_consumption_center (hotel_id, id) on delete restrict;

-- Costo teórico por habitación-noche del desayuno incluido (H10-012), configurable por
-- hotel -- mismo patrón que `hotel_loyalty_program_config` (0123): una fila por hotel,
-- default explícito en 0 (sin inventar un número: mientras el hotel no lo configure, el
-- costo imputado es $0, nunca una cifra adivinada).
create table public.hotel_breakfast_cost_config (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  cost_per_room_night numeric(10, 2) not null default 0 check (cost_per_room_night >= 0),
  updated_at timestamptz not null default now()
);

-- Advisory lock helper (mismo criterio que `lock_availability`, 0004): serializa
-- traspasos concurrentes del MISMO sku dentro del MISMO hotel. Deliberadamente a nivel
-- (hotel, sku) y no (hotel, sku, centro_par): dos traspasos concurrentes del mismo sku
-- en el mismo hotel, aunque toquen centros distintos, se serializan igual -- volumen de
-- F&B back-office (P2) no justifica lock de grano más fino, y evita cualquier
-- posibilidad de deadlock por orden de adquisición entre centros.
create or replace function public.lock_fnb_stock(_hotel_id uuid, _sku text)
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(_hotel_id::text || ':fnb_stock:' || _sku, 0));
end;
$$;

-- fnb_registrar_traspaso(): única vía recomendada para mover existencia entre un centro
-- de consumo y el almacén central. security invoker (default): corre con el rol de
-- quien llama para que las políticas RLS de las tablas que toca sigan aplicando -- igual
-- que `book_availability()`.
create or replace function public.fnb_registrar_traspaso(
  _hotel_id uuid,
  _tenant_id uuid,
  _from_center_id uuid,
  _to_center_id uuid,
  _sku text,
  _quantity numeric,
  _transferred_by uuid default null,
  _nota text default null
)
returns public.fnb_inventory_transfer
language plpgsql
as $$
declare
  v_from public.fnb_consumption_center;
  v_to public.fnb_consumption_center;
  v_source_item public.fnb_stock_item;
  v_unit_cost numeric(10, 2);
  v_transfer public.fnb_inventory_transfer;
begin
  if _quantity is null or _quantity <= 0 then
    raise exception 'cantidad_invalida: _quantity debe ser mayor a 0' using errcode = 'P0001';
  end if;
  if _from_center_id = _to_center_id then
    raise exception 'centro_invalido: el centro origen y destino no pueden ser el mismo' using errcode = 'P0001';
  end if;

  perform public.lock_fnb_stock(_hotel_id, _sku);

  select * into v_from from public.fnb_consumption_center where id = _from_center_id and hotel_id = _hotel_id;
  if not found then
    raise exception 'centro_invalido: centro origen % no existe en el hotel %', _from_center_id, _hotel_id
      using errcode = 'P0001';
  end if;
  select * into v_to from public.fnb_consumption_center where id = _to_center_id and hotel_id = _hotel_id;
  if not found then
    raise exception 'centro_invalido: centro destino % no existe en el hotel %', _to_center_id, _hotel_id
      using errcode = 'P0001';
  end if;

  -- La regla central del REQ: el traspaso debe involucrar al almacén central, en
  -- cualquiera de los dos sentidos, nunca directo entre dos centros de consumo.
  if not (v_from.tipo = 'almacen_central' or v_to.tipo = 'almacen_central') then
    raise exception 'traspaso_invalido: el traspaso debe involucrar al almacen central (origen o destino)'
      using errcode = 'P0001';
  end if;

  select * into v_source_item
  from public.fnb_stock_item
  where center_id = _from_center_id and sku = _sku
  for update;

  if not found or v_source_item.quantity < _quantity then
    raise exception 'stock_insuficiente: el centro origen no tiene % unidades disponibles de %', _quantity, _sku
      using errcode = 'P0001';
  end if;

  v_unit_cost := v_source_item.unit_cost;

  update public.fnb_stock_item
  set quantity = quantity - _quantity, updated_at = now()
  where id = v_source_item.id;

  insert into public.fnb_stock_item (tenant_id, hotel_id, center_id, sku, nombre, unit_cost, quantity)
  values (_tenant_id, _hotel_id, _to_center_id, _sku, v_source_item.nombre, v_unit_cost, _quantity)
  on conflict (center_id, sku)
  do update set quantity = public.fnb_stock_item.quantity + excluded.quantity, updated_at = now();

  insert into public.fnb_inventory_transfer
    (tenant_id, hotel_id, from_center_id, to_center_id, sku, quantity, unit_cost_snapshot, transferred_by, nota)
  values (_tenant_id, _hotel_id, _from_center_id, _to_center_id, _sku, _quantity, v_unit_cost, _transferred_by, _nota)
  returning * into v_transfer;

  return v_transfer;
end;
$$;

alter table public.fnb_consumption_center enable row level security;
alter table public.fnb_stock_item enable row level security;
alter table public.fnb_inventory_transfer enable row level security;
alter table public.hotel_breakfast_cost_config enable row level security;

-- Centros de consumo / existencia / traspasos: owner/gm/fnb operan F&B día a día
-- (mismo grupo que `pedidosFnb.ts` usa para tomar/confirmar pedidos).
create policy "fnb_consumption_center_tenant_select" on public.fnb_consumption_center for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "fnb_consumption_center_tenant_insert" on public.fnb_consumption_center for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[])
  );
create policy "fnb_consumption_center_tenant_update" on public.fnb_consumption_center for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]));

create policy "fnb_stock_item_tenant_select" on public.fnb_stock_item for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "fnb_stock_item_tenant_insert" on public.fnb_stock_item for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[])
  );
create policy "fnb_stock_item_tenant_update" on public.fnb_stock_item for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]));

create policy "fnb_inventory_transfer_tenant_select" on public.fnb_inventory_transfer for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "fnb_inventory_transfer_tenant_insert" on public.fnb_inventory_transfer for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[])
  );
-- Append-only por diseño (bitácora de auditoría): sin policy de UPDATE/DELETE, nadie --
-- ni el owner -- puede editar/borrar un traspaso ya registrado.

-- Costo de desayuno: config de dinero del hotel -> solo owner/gm dan de alta/editan
-- (mismo criterio que `hotel_loyalty_program_config`/`hotel_cancellation_policy`);
-- accountant/fnb pueden CONSULTARLO (lo necesitan para el reporte de costo imputado)
-- pero no cambiarlo.
create policy "hotel_breakfast_cost_config_tenant_select" on public.hotel_breakfast_cost_config for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and hotel_id = any (current_hotel_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb', 'accountant']::public.hotel_role[])
  );
create policy "hotel_breakfast_cost_config_tenant_insert" on public.hotel_breakfast_cost_config for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "hotel_breakfast_cost_config_tenant_update" on public.hotel_breakfast_cost_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.fnb_consumption_center to authenticated;
grant select, insert, update on public.fnb_stock_item to authenticated;
grant select, insert on public.fnb_inventory_transfer to authenticated;
grant select, insert, update on public.hotel_breakfast_cost_config to authenticated;
