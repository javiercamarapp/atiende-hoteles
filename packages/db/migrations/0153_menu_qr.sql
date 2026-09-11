-- REQ-AB-001 (P1/F): "El menú QR con video debe estar disponible en habitación,
-- alberca, camastro, playa y mesa, con reglas de all-inclusive/day-pass y alérgenos
-- multilingües, y numeración física única por ubicación codificada en el QR."
--
-- Dos tablas nuevas:
--   * `menu_item`: el catálogo real del menú (nombre, video, precio de lista, si viene
--     incluido en el plan todo-incluido, si un day-pass puede pedirlo y con qué
--     recargo, y sus alérgenos). El motor de reglas (qué paga cada tipo de huésped) es
--     dominio PURO en `packages/domain-hotel/src/menuQr.ts` -- esta tabla solo guarda
--     los datos de entrada de esas reglas, nunca el resultado calculado.
--   * `menu_qr_location`: un renglón por CADA superficie física donde se planta un QR
--     (una mesa, un camastro, una habitación...). `physical_number` es la numeración
--     física real (la que trae pegada la tarjeta/el vinil en el mueble) y
--     `location_code` es lo que el QR impreso codifica -- generado en dominio
--     (`buildLocationCode`) a partir de (hotel, tipo, número), así que dos ubicaciones
--     CUALESQUIERA siempre codifican un `location_code` distinto (verificado en
--     tests/integration/ab/menu-qr-publico.spec.ts: "2 QR distintos -> 2 location_code
--     distintos"). El código no vive solo en la app: la unicidad la garantiza también
--     el índice único de abajo, no solo la función pura.
--
-- Deliberadamente FUERA de alcance (pertenecen a REQ-AB-002, pendiente-credenciales de
-- PMS/POS): tomar el pedido desde el QR, enrutarlo a KDS, o cargarlo al folio. Este
-- requisito es únicamente la SUPERFICIE del menú -- verlo, con las reglas de qué paga
-- cada tipo de huésped y sus alérgenos ya aplicadas, sin backend de POS de por medio
-- (Dependencia externa: "ninguna", docs/REQUISITOS.md).
--
-- Expand-only sobre migraciones ya mergeadas (REQ-GOB-010): tablas nuevas, ninguna
-- migración existente se edita.

-- ---------------------------------------------------------------------------
-- menu_item
-- ---------------------------------------------------------------------------
create table public.menu_item (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  name text not null,
  description text,
  -- Nunca vacío en la fila (el REQ es explícito: "menú QR CON VIDEO") -- la ausencia
  -- de un video real para un platillo concreto es una decisión de contenido del
  -- hotel, no algo que esta tabla deba permitir fingir con NULL; `check` abajo.
  video_url text not null,
  price numeric(12, 2) not null check (price >= 0),
  -- Regla all-inclusive: si es true, un huésped en plan todo-incluido lo consume sin
  -- costo adicional (precioAPagar = 0 en `resolveMenuForGuest`); si es false, un
  -- huésped todo-incluido lo paga a `price` igual que un huésped sin plan (ej. un
  -- corte premium fuera del menú base incluido).
  all_inclusive_included boolean not null default false,
  -- Regla day-pass: si es false, el platillo NO aparece en absoluto para un huésped
  -- de day-pass (ej. el pase de un día no incluye servicio a la habitación) -- filtrado
  -- en dominio, nunca solo "marcado". Si es true, un day-pass lo paga `price +
  -- day_pass_surcharge` (el recargo existe porque muchos hoteles cobran distinto al
  -- day-pass que al huésped hospedado, ej. sin el descuento del plan).
  day_pass_available boolean not null default true,
  day_pass_surcharge numeric(12, 2) not null default 0 check (day_pass_surcharge >= 0),
  -- Catálogo cerrado de alérgenos (NOM-051 + los 14 alérgenos mayores UE, acotado a los
  -- que de verdad aparecen en cocina de hotel) -- traducción es/en/fr vive en dominio
  -- (`ALLERGEN_LABELS`), nunca duplicada aquí como texto libre por idioma.
  allergens text[] not null default '{}'
    check (allergens <@ array['gluten','lactosa','huevo','mariscos','pescado','cacahuate','frutos_secos','soya','sesamo','sulfitos']::text[]),
  active boolean not null default true,
  created_by uuid not null references public.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index menu_item_hotel_active_idx on public.menu_item (hotel_id) where active;

alter table public.menu_item enable row level security;

-- Gestión del menú: mismo criterio que `experience_catalog` (0050) para
-- owner/gm -- se añade `fnb` porque, a diferencia del catálogo de experiencias, el
-- menú de alimentos y bebidas SÍ es responsabilidad operativa directa de ese rol
-- (mismo rol que ya gestiona `fnb_order`, migración 0084).
create policy "menu_item_tenant_select" on public.menu_item for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "menu_item_tenant_insert" on public.menu_item for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[])
  );
create policy "menu_item_tenant_update" on public.menu_item for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]));
grant select, insert, update on public.menu_item to authenticated;

-- ---------------------------------------------------------------------------
-- menu_qr_location
-- ---------------------------------------------------------------------------
create table public.menu_qr_location (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  location_type text not null check (location_type in ('habitacion', 'alberca', 'camastro', 'playa', 'mesa')),
  -- La numeración física real (el "14" de la habitación 14, el "3" del camastro 3...).
  -- Única POR TIPO dentro del hotel -- dos camastros no pueden compartir número, pero
  -- un camastro y una mesa sí pueden coincidir en número (son numeraciones físicas
  -- independientes en el mundo real).
  physical_number integer not null check (physical_number > 0),
  -- Generado por `buildLocationCode` (dominio puro) a partir de
  -- (hotel_id, location_type, physical_number) -- lo que el QR impreso codifica.
  -- Único GLOBALMENTE (no solo por hotel): la ruta pública `/menu/:locationCode`
  -- resuelve el hotel a partir del código, sin que el huésped conozca ni envíe el
  -- hotel_id (mismo criterio "el cliente no aporta el dato de autoridad" que
  -- `confirmation_code` de reservation).
  location_code text not null,
  active boolean not null default true,
  created_by uuid not null references public.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (hotel_id, location_type, physical_number),
  unique (location_code)
);
create index menu_qr_location_hotel_idx on public.menu_qr_location (hotel_id);

alter table public.menu_qr_location enable row level security;

create policy "menu_qr_location_tenant_select" on public.menu_qr_location for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "menu_qr_location_tenant_insert" on public.menu_qr_location for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[])
  );
create policy "menu_qr_location_tenant_update" on public.menu_qr_location for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]));
grant select, insert, update on public.menu_qr_location to authenticated;

-- ---------------------------------------------------------------------------
-- Lectura pública (sin sesión de staff -- el huésped escanea un QR, nunca inicia
-- sesión en el panel): mismo patrón que `list_experience_catalog_public` (0050),
-- SECURITY DEFINER + solo columnas necesarias, nunca expone otro hotel ni otra
-- ubicación.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_menu_location_public(_location_code text)
returns table (hotel_id uuid, location_type text, physical_number integer)
language sql
security definer
set search_path = public
stable
as $$
  select l.hotel_id, l.location_type, l.physical_number
  from public.menu_qr_location l
  where l.location_code = _location_code and l.active = true;
$$;

revoke all on function public.resolve_menu_location_public(text) from public;
grant execute on function public.resolve_menu_location_public(text) to atiende_app, authenticated;

create or replace function public.list_menu_items_public(_hotel_id uuid)
returns table (
  id uuid,
  name text,
  description text,
  video_url text,
  price numeric,
  all_inclusive_included boolean,
  day_pass_available boolean,
  day_pass_surcharge numeric,
  allergens text[]
)
language sql
security definer
set search_path = public
stable
as $$
  select mi.id, mi.name, mi.description, mi.video_url, mi.price,
         mi.all_inclusive_included, mi.day_pass_available, mi.day_pass_surcharge, mi.allergens
  from public.menu_item mi
  where mi.hotel_id = _hotel_id and mi.active = true
  order by mi.name;
$$;

revoke all on function public.list_menu_items_public(uuid) from public;
grant execute on function public.list_menu_items_public(uuid) to atiende_app, authenticated;
