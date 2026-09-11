-- REQ-AB-014 (P2/F, fuente H10-010): "El sistema debe disparar ofertas de upsell F&B
-- (cena romántica, botella, desayuno en cama) en momentos definidos (T-7, T-3,
-- check-in), con el precio siempre proveniente del motor de Revenue."
--
-- Dos tablas nuevas + una función:
--   * `fnb_upsell_offer_template`: la oferta de upsell que un hotel configura --
--     apunta a un `menu_item` REAL (REQ-AB-001, migración 0153), nunca a un precio
--     libre capturado aquí. El precio de la oferta SIEMPRE se lee de
--     `menu_item.price` en el momento de disparar, nunca se copia/congela al crear la
--     plantilla (si el hotel actualiza el precio del platillo, la siguiente oferta
--     disparada ya refleja el precio vigente -- exactamente el mismo criterio de "la
--     autoridad es la fila real, no una copia" que `rate_plan.price` en `quote.ts`).
--   * `fnb_upsell_trigger_event`: un renglón por CADA oferta efectivamente disparada
--     a una reserva en un momento concreto (T-7/T-3/check-in) -- `offered_price` es el
--     precio REAL capturado en ese instante (auditable después aunque el platillo
--     cambie de precio más tarde). `unique (reservation_id, template_id,
--     trigger_moment)` es la garantía de fondo de idempotencia bajo concurrencia real
--     (mismo criterio que `menu_qr_location(location_code)`): dos ticks del
--     planificador que compitieran por la misma reserva nunca duplican el disparo.
--   * `public.trigger_fnb_upsell_offer(_reservation_id, _template_id,
--     _trigger_moment)`: la ÚNICA vía para insertar en `fnb_upsell_trigger_event`.
--     Deliberadamente NO recibe ningún parámetro de precio -- el precio se calcula
--     DENTRO de la función, leyendo `menu_item.price` vía la plantilla. Es literalmente
--     imposible para cualquier llamador (incluido un futuro canal conversacional/LLM)
--     pasar un precio propio: la función no tiene ningún parámetro por el que hacerlo.
--     Esta es la garantía de fondo, a nivel de base de datos, de "el precio siempre
--     proveniente del motor de Revenue" -- mismo espíritu que
--     `reservation_validate_transition`/`revenue_engine_gate` siendo la autoridad
--     final que nadie puede saltarse escribiendo SQL a mano fuera de la aplicación.
--
-- Expand-only sobre migraciones ya mergeadas (REQ-GOB-010): tablas nuevas, ninguna
-- migración existente se edita.

-- ---------------------------------------------------------------------------
-- fnb_upsell_offer_template
-- ---------------------------------------------------------------------------
create table public.fnb_upsell_offer_template (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- Catálogo cerrado -- espejo exacto de `UPSELL_OFFER_TYPES` en
  -- `packages/domain-hotel/src/fnbUpsellEngine.ts`. Es solo la CATEGORÍA para agrupar/
  -- presentar: un hotel puede tener varias plantillas del mismo tipo (ej. dos opciones
  -- de "botella" a precios distintos), por eso no es parte de una llave única por sí
  -- sola.
  offer_type text not null check (offer_type in ('cena_romantica', 'botella', 'desayuno_en_cama')),
  -- El platillo/paquete REAL cuyo precio gobierna esta oferta (REQ-AB-001). `restrict`
  -- (nunca cascade): borrar un platillo del menú mientras tiene una plantilla de
  -- upsell activa es una decisión que un humano debe resolver explícitamente
  -- (desactivar la plantilla primero), no algo que deba perderse en silencio.
  menu_item_id uuid not null references public.menu_item(id) on delete restrict,
  active boolean not null default true,
  created_by uuid not null references public.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, offer_type, menu_item_id)
);
create index fnb_upsell_offer_template_hotel_active_idx on public.fnb_upsell_offer_template (hotel_id) where active;

-- Un `menu_item` de OTRO hotel nunca puede respaldar la plantilla de upsell de este
-- hotel -- el FK a `menu_item(id)` por sí solo no lo impide (la columna `hotel_id` de
-- `menu_item` es independiente), así que se valida explícitamente en un trigger, mismo
-- patrón que `reservation_validate_transition` (0006) siendo la autoridad real que
-- ningún INSERT/UPDATE puede saltarse.
create or replace function public.fnb_upsell_offer_template_validate_menu_item()
returns trigger
language plpgsql
as $$
declare
  v_menu_item_hotel_id uuid;
begin
  select hotel_id into v_menu_item_hotel_id from public.menu_item where id = new.menu_item_id;
  if v_menu_item_hotel_id is null then
    raise exception 'menu_item_no_encontrado: % no existe', new.menu_item_id;
  end if;
  if v_menu_item_hotel_id <> new.hotel_id then
    raise exception 'menu_item_de_otro_hotel: el menu_item % pertenece a otro hotel, no puede respaldar una oferta de upsell de %',
      new.menu_item_id, new.hotel_id;
  end if;
  return new;
end;
$$;

create trigger fnb_upsell_offer_template_validate_menu_item_trg
  before insert or update of menu_item_id, hotel_id on public.fnb_upsell_offer_template
  for each row execute function public.fnb_upsell_offer_template_validate_menu_item();

alter table public.fnb_upsell_offer_template enable row level security;

-- Mismo criterio que `menu_item` (0153): gestionar las ofertas de upsell es
-- responsabilidad de owner/gm/fnb.
create policy "fnb_upsell_offer_template_tenant_select" on public.fnb_upsell_offer_template for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "fnb_upsell_offer_template_tenant_insert" on public.fnb_upsell_offer_template for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[])
  );
create policy "fnb_upsell_offer_template_tenant_update" on public.fnb_upsell_offer_template for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]));
grant select, insert, update on public.fnb_upsell_offer_template to authenticated;

-- ---------------------------------------------------------------------------
-- fnb_upsell_trigger_event
-- ---------------------------------------------------------------------------
create table public.fnb_upsell_trigger_event (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  template_id uuid not null references public.fnb_upsell_offer_template(id) on delete restrict,
  -- Catálogo cerrado -- espejo exacto de `UPSELL_TRIGGER_MOMENTS` en
  -- `packages/domain-hotel/src/fnbUpsellEngine.ts`.
  trigger_moment text not null check (trigger_moment in ('t_menos_7', 't_menos_3', 'checkin')),
  -- El precio REAL capturado por `trigger_fnb_upsell_offer` en el momento del disparo
  -- (copiado de `menu_item.price` vía la plantilla) -- nunca escrito directamente por
  -- ningún INSERT de la aplicación (ver `revoke`/`grant` de la función abajo: ninguna
  -- ruta HTTP inserta en esta tabla con un `insert` propio).
  offered_price numeric(12, 2) not null check (offered_price >= 0),
  triggered_at timestamptz not null default now(),
  unique (reservation_id, template_id, trigger_moment)
);
create index fnb_upsell_trigger_event_reservation_idx on public.fnb_upsell_trigger_event (reservation_id);
create index fnb_upsell_trigger_event_hotel_idx on public.fnb_upsell_trigger_event (hotel_id, triggered_at desc);

alter table public.fnb_upsell_trigger_event enable row level security;

create policy "fnb_upsell_trigger_event_tenant_select" on public.fnb_upsell_trigger_event for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
-- El INSERT real siempre pasa por `trigger_fnb_upsell_offer` (`security invoker`, ver
-- abajo): esta policy autoriza esa vía tanto para el planificador en proceso (corre
-- con el cliente admin del motor embebido/Supabase, que no está sujeto a RLS) como
-- para el disparo manual desde el panel de staff (`POST .../upsell-fnb/evaluar`,
-- sesión de staff real con RLS activa) -- mismos roles que gestionan las plantillas.
create policy "fnb_upsell_trigger_event_tenant_insert" on public.fnb_upsell_trigger_event for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[])
  );
grant select, insert on public.fnb_upsell_trigger_event to authenticated;

-- ---------------------------------------------------------------------------
-- trigger_fnb_upsell_offer: la ÚNICA vía de escritura a fnb_upsell_trigger_event.
-- ---------------------------------------------------------------------------
-- Deliberadamente SIN ningún parámetro de precio -- ver comentario extenso al inicio
-- del archivo. `security invoker` (no `definer`): corre con los privilegios/RLS de
-- quien llama, así que un disparo manual de staff SOLO puede afectar reservas/
-- plantillas del hotel al que ese staff pertenece (las policies de arriba y de
-- `reservation`/`menu_item` ya lo garantizan) -- el planificador en proceso llama con
-- el cliente admin del motor, sin restricción adicional, mismo criterio que el resto
-- de `jobs/*Scheduler.ts` de este repo.
create or replace function public.trigger_fnb_upsell_offer(
  _reservation_id uuid,
  _template_id uuid,
  _trigger_moment text
) returns table (id uuid, offered_price numeric, ya_disparada boolean)
language plpgsql
security invoker
as $$
declare
  v_hotel_id uuid;
  v_tenant_id uuid;
  v_template_hotel_id uuid;
  v_price numeric;
  v_active boolean;
  v_existing_id uuid;
  v_existing_price numeric;
  v_new_id uuid;
begin
  if _trigger_moment not in ('t_menos_7', 't_menos_3', 'checkin') then
    raise exception 'momento_invalido: % no es un momento de disparo válido', _trigger_moment;
  end if;

  select r.hotel_id, r.tenant_id into v_hotel_id, v_tenant_id
  from public.reservation r
  where r.id = _reservation_id;
  if v_hotel_id is null then
    raise exception 'reserva_no_encontrada: %', _reservation_id;
  end if;

  -- El precio SIEMPRE se lee AQUÍ, de `menu_item.price` vía la plantilla -- ningún
  -- parámetro de esta función permite sustituirlo.
  select t.hotel_id, mi.price, (t.active and mi.active)
    into v_template_hotel_id, v_price, v_active
  from public.fnb_upsell_offer_template t
  join public.menu_item mi on mi.id = t.menu_item_id
  where t.id = _template_id;

  if v_template_hotel_id is null then
    raise exception 'plantilla_no_encontrada: %', _template_id;
  end if;
  if v_template_hotel_id <> v_hotel_id then
    raise exception 'plantilla_de_otro_hotel: la plantilla % no pertenece al hotel de la reserva %', _template_id, _reservation_id;
  end if;
  if not v_active then
    raise exception 'oferta_inactiva: la plantilla % o su platillo están inactivos', _template_id;
  end if;

  select fte.id, fte.offered_price into v_existing_id, v_existing_price
  from public.fnb_upsell_trigger_event fte
  where fte.reservation_id = _reservation_id and fte.template_id = _template_id and fte.trigger_moment = _trigger_moment;

  if v_existing_id is not null then
    -- Idempotente: un segundo disparo del MISMO (reserva, plantilla, momento) nunca
    -- crea un segundo evento ni "actualiza" el precio ya capturado -- devuelve el que
    -- ya existía tal cual, mismo criterio que `location_code` (0153) siendo
    -- determinístico ante reintentos.
    return query select v_existing_id, v_existing_price, true;
    return;
  end if;

  insert into public.fnb_upsell_trigger_event (tenant_id, hotel_id, reservation_id, template_id, trigger_moment, offered_price)
  values (v_tenant_id, v_hotel_id, _reservation_id, _template_id, _trigger_moment, v_price)
  returning fnb_upsell_trigger_event.id into v_new_id;

  return query select v_new_id, v_price, false;
end;
$$;

revoke all on function public.trigger_fnb_upsell_offer(uuid, uuid, text) from public;
grant execute on function public.trigger_fnb_upsell_offer(uuid, uuid, text) to atiende_app, authenticated;
