-- ORIGEN: packages/db/migrations/0147_mcp_hotel_server.sql sha256:be3f05470f16c1144bc1f0faa4065e939bec08e6175e0bc481667d888ba40ad3
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-RES-021 (BP-021, H06-004/H06-010/H06-011/H06-012/H06-013, H07-038): "el sistema
-- debe exponer disponibilidad, tarifa y reserva mediante un servidor MCP y datos
-- estructurados (schema.org Hotel/Offer) para que agentes de IA externos puedan
-- consultar y reservar, respondiendo en el orden de segundos".
--
-- Un agente de IA externo NO tiene una sesión de staff (`hotel_staff`/`auth.uid()`) --
-- exactamente la misma categoría de "escritura de bajo privilegio" que REQ-TEN-004/
-- GOB-039 ya resolvió para check-in público y pedidos de experiencias sin cuenta
-- (migraciones 0013/0050): toda lectura/escritura de este servidor pasa por una función
-- `SECURITY DEFINER` que recalcula disponibilidad/tarifa en el propio servidor, nunca
-- confiando en un valor que un cliente MCP externo pudiera enviar.
--
-- Autenticación: `mcp_agent_credential` guarda solo el HASH sha256 de la API key (nunca
-- el valor en claro, mismo criterio que cualquier secreto de este repo) emitida por un
-- owner/gm para un agente externo concreto -- una API key identifica exactamente un
-- hotel, nunca un tenant completo (mismo principio de aislamiento por hotel que el
-- resto del esquema).
--
-- Precio: `compute_mcp_room_type_quote()` reimplementa DELIBERADAMENTE, en SQL, el
-- mismo subconjunto (neto = suma de `rate_plan.price` por noche, min-stay/CTA/CTD) que
-- `packages/domain-hotel/src/quote.ts` ya calcula en TypeScript para el motor de
-- reservas de staff -- NO lo reutiliza porque una función `SECURITY DEFINER` debe ser
-- autocontenida (no puede invocar código de aplicación fuera de la base de datos) y
-- porque GOB-039 exige que el recálculo ocurra DENTRO del límite de confianza de la
-- función. El impuesto (IVA/ISH) se omite a propósito: `reservation.total_amount`
-- siempre guarda el NETO (ver comentario en `apps/api/src/routes/reservas.ts`), igual
-- que el motor de staff. La duplicación queda acotada (un cálculo de ~15 líneas, no el
-- motor completo) y verificada: `tests/integration/contracts/mcp-hotel/paridad-motor-
-- interno.spec.ts` compara, para las MISMAS tarifas sembradas, que este cálculo y
-- `computeQuote()` (vía el endpoint interno `/reservas`) produzcan el MISMO monto --
-- cualquier divergencia futura rompe esa prueba antes de llegar a producción.
--
-- Expand-only sobre migraciones ya mergeadas (REQ-GOB-010): solo tablas/columnas/
-- funciones nuevas, ninguna migración existente se edita.

create table public.mcp_agent_credential (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  api_key_hash text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
create index mcp_agent_credential_tenant_hotel_idx on public.mcp_agent_credential (tenant_id, hotel_id);
-- Una API key debe resolver a UN SOLO agente -- único incluso entre hoteles/tenants
-- distintos (mismo espacio de nombres global de secretos, como cualquier API key).
create unique index mcp_agent_credential_api_key_hash_idx on public.mcp_agent_credential (api_key_hash);

alter table public.mcp_agent_credential enable row level security;

-- Gestionar credenciales de agentes externos es una decisión de negocio (quién puede
-- reservar en nombre del hotel), no operativa -- mismo criterio de rol que
-- `hotel_channel_commission`/`hotel_tax_config` (owner/gm únicamente). SELECT nunca
-- expone `api_key_hash` en ninguna ruta real (ver apps/api/src/routes/mcpAgentes.ts) --
-- la columna existe en la tabla por simplicidad de esquema, no porque deba llegar a un
-- cliente HTTP.
create policy "mcp_agent_credential_tenant_select" on public.mcp_agent_credential for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "mcp_agent_credential_tenant_insert" on public.mcp_agent_credential for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "mcp_agent_credential_tenant_update" on public.mcp_agent_credential for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "mcp_agent_credential_tenant_delete" on public.mcp_agent_credential for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.mcp_agent_credential to authenticated;

-- Trazabilidad: qué agente MCP originó cada reserva (REQ-RES-020 ya reporta por
-- `reservation.channel = 'agente_ia_externo'`; estas dos columnas son el detalle FINO
-- de cuál agente exacto, útil para revocar/depurar sin ambigüedad) + idempotencia real
-- de la herramienta `crear_reserva` por (agente, client_request_id) -- mismo espíritu
-- que `Idempotency-Key` (apps/api/src/lib/idempotency.ts) o
-- `experience_order_reservation_client_request_idx` (migración 0050), adaptado a un
-- llamador MCP que no manda un header HTTP sino un parámetro de herramienta.
alter table public.reservation add column mcp_agent_id uuid references public.mcp_agent_credential(id) on delete set null;
alter table public.reservation add column mcp_client_request_id text;
create unique index reservation_mcp_agent_client_request_idx
  on public.reservation (mcp_agent_id, mcp_client_request_id)
  where mcp_agent_id is not null and mcp_client_request_id is not null;

-- verify_mcp_agent_credential(): resuelve una API key (ya hasheada por el llamador,
-- NUNCA en claro dentro de SQL/logs) al hotel/tenant que autoriza -- fail-closed:
-- credencial inexistente o revocada, mismo error genérico (sin distinguir cuál),
-- consistente con el resto de RPCs públicas de este repo (`cancel_reservation_public`,
-- `order_experience_public`) que nunca revelan CUÁL parte de la verificación falló.
create or replace function public.verify_mcp_agent_credential(_api_key_hash text)
returns table (agent_id uuid, hotel_id uuid, tenant_id uuid, hotel_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cred public.mcp_agent_credential;
begin
  select c.* into v_cred
  from public.mcp_agent_credential c
  where c.api_key_hash = _api_key_hash and c.revoked_at is null;

  if not found then
    raise exception 'credencial_mcp_invalida: API key inválida o revocada' using errcode = 'P0001';
  end if;

  update public.mcp_agent_credential set last_used_at = now() where id = v_cred.id;

  return query
    select v_cred.id, v_cred.hotel_id, v_cred.tenant_id, l.name
    from public.location l
    where l.id = v_cred.hotel_id;
end;
$$;

revoke all on function public.verify_mcp_agent_credential(text) from public;
grant execute on function public.verify_mcp_agent_credential(text) to atiende_app, authenticated;

-- compute_mcp_room_type_quote(): ver cabecera de este archivo (por qué reimplementa,
-- acotado, el neto de `computeQuote()`). `_reason` no nulo ⇒ `_net_amount`/`_nights`
-- son 0/null -- el llamador (herramienta `buscar_disponibilidad` o `crear_reserva`)
-- decide qué hacer con cada código (los mismos que `QuoteError.code` en
-- `packages/domain-hotel/src/quote.ts`, para que un cliente MCP y un cliente HTTP
-- interno vean el mismo vocabulario de error).
create or replace function public.compute_mcp_room_type_quote(
  _room_type_id uuid,
  _check_in date,
  _check_out date
)
returns table (net_amount numeric, nights integer, currency text, reason text)
language plpgsql
stable
as $$
declare
  v_nights integer;
  v_arrival public.rate_plan;
  v_departure public.rate_plan;
  v_night date;
  v_rate public.rate_plan;
  v_total numeric := 0;
  v_currency text := 'MXN';
begin
  if _check_out <= _check_in then
    return query select null::numeric, 0, v_currency, 'estadia_invalida';
    return;
  end if;
  v_nights := _check_out - _check_in;

  select * into v_arrival from public.rate_plan where room_type_id = _room_type_id and date = _check_in;
  if not found then
    return query select null::numeric, 0, v_currency, 'sin_tarifa';
    return;
  end if;
  if v_arrival.closed_to_arrival then
    return query select null::numeric, 0, v_arrival.currency, 'cerrado_a_llegada';
    return;
  end if;
  if v_nights < v_arrival.min_stay then
    return query select null::numeric, 0, v_arrival.currency, 'estadia_minima_no_alcanzada';
    return;
  end if;

  select * into v_departure from public.rate_plan where room_type_id = _room_type_id and date = _check_out;
  if found and v_departure.closed_to_departure then
    return query select null::numeric, 0, v_arrival.currency, 'cerrado_a_salida';
    return;
  end if;

  v_currency := v_arrival.currency;
  v_night := _check_in;
  while v_night < _check_out loop
    select * into v_rate from public.rate_plan where room_type_id = _room_type_id and date = v_night;
    if not found then
      return query select null::numeric, 0, v_currency, 'sin_tarifa';
      return;
    end if;
    v_total := v_total + v_rate.price;
    v_night := v_night + 1;
  end loop;

  return query select v_total, v_nights, v_currency, null::text;
end;
$$;

-- list_mcp_hotel_availability(): fuente de datos de la herramienta MCP
-- `buscar_disponibilidad` -- un `Offer` por tipo de habitación del hotel, con
-- disponibilidad (mínimo del rango, mismo criterio "peor caso" que
-- `apps/api/src/routes/disponibilidad.ts`) y tarifa/razón de
-- `compute_mcp_room_type_quote()`. `security definer` porque un agente externo no
-- tiene `hotel_staff`/RLS propio -- SOLO expone id/nombre/disponibilidad/precio, nunca
-- datos de huésped (REQ-HUE-023).
create or replace function public.list_mcp_hotel_availability(
  _hotel_id uuid,
  _check_in date,
  _check_out date
)
returns table (
  room_type_id uuid,
  room_type_name text,
  disponibles integer,
  net_amount numeric,
  currency text,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    with disponibilidad as (
      select
        rt.id as room_type_id,
        rt.name as room_type_name,
        coalesce((
          select min(a.total_rooms - a.booked_rooms)
          from public.availability a
          where a.room_type_id = rt.id and a.date >= _check_in and a.date < _check_out
        ), 0)::integer as disponibles
      from public.room_type rt
      where rt.hotel_id = _hotel_id
    )
    select
      d.room_type_id,
      d.room_type_name,
      d.disponibles,
      q.net_amount,
      q.currency,
      case when d.disponibles <= 0 then coalesce(q.reason, 'sin_disponibilidad') else q.reason end as reason
    from disponibilidad d
    cross join lateral public.compute_mcp_room_type_quote(d.room_type_id, _check_in, _check_out) q
    order by d.room_type_name asc;
end;
$$;

revoke all on function public.list_mcp_hotel_availability(uuid, date, date) from public;
grant execute on function public.list_mcp_hotel_availability(uuid, date, date) to atiende_app, authenticated;

-- book_reservation_mcp_agent(): ÚNICA vía de escritura de la herramienta MCP
-- `crear_reserva` -- nótese la AUSENCIA deliberada de cualquier parámetro de precio
-- (GOB-039/REQ-TEN-004, mismo criterio estructural que `order_experience_public`).
-- Reutiliza `book_availability()` (0004/0013, ya audita sobreventa configurada,
-- REQ-RES-007) para el inventario -- eso NO se duplica aquí. Idempotente por
-- (agent_id, client_request_id): una segunda llamada con el mismo par devuelve la
-- misma reserva (`ya_registrado = true`) en vez de crear una segunda.
create or replace function public.book_reservation_mcp_agent(
  _api_key_hash text,
  _room_type_id uuid,
  _check_in date,
  _check_out date,
  _guest_full_name text,
  _guest_email text,
  _guest_phone text,
  _client_request_id text default null
)
returns table (reservation_id uuid, confirmation_code text, net_amount numeric, currency text, ya_registrado boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cred record;
  v_room_type public.room_type;
  v_quote record;
  v_existing public.reservation;
  v_guest_id uuid;
  v_reservation public.reservation;
  v_night date;
begin
  select * into v_cred from public.verify_mcp_agent_credential(_api_key_hash);

  if _client_request_id is not null then
    select r.* into v_existing
    from public.reservation r
    where r.mcp_agent_id = v_cred.agent_id and r.mcp_client_request_id = _client_request_id;
    if found then
      return query select v_existing.id, v_existing.confirmation_code, v_existing.total_amount, v_existing.currency, true;
      return;
    end if;
  end if;

  if length(trim(coalesce(_guest_full_name, ''))) = 0 then
    raise exception 'huesped_invalido: nombre del huésped requerido' using errcode = 'P0001';
  end if;

  select * into v_room_type from public.room_type where id = _room_type_id and hotel_id = v_cred.hotel_id;
  if not found then
    raise exception 'tipo_habitacion_invalido: % no pertenece al hotel de esta credencial', _room_type_id
      using errcode = 'P0001';
  end if;

  select * into v_quote from public.compute_mcp_room_type_quote(_room_type_id, _check_in, _check_out);
  if v_quote.reason is not null then
    raise exception 'reserva_no_disponible: %', v_quote.reason using errcode = 'P0001';
  end if;

  v_night := _check_in;
  while v_night < _check_out loop
    -- `book_availability` es SECURITY INVOKER (0004) pero corre con el rol elevado de
    -- ESTA función (SECURITY DEFINER) mientras dura la llamada -- mismo mecanismo ya
    -- usado por `cancel_reservation_public` (0013) para `release_availability`.
    perform public.book_availability(v_cred.hotel_id, _room_type_id, v_night, 1);
    v_night := v_night + 1;
  end loop;

  insert into public.guest (tenant_id, hotel_id, full_name, email, phone)
  values (v_cred.tenant_id, v_cred.hotel_id, trim(_guest_full_name), nullif(trim(coalesce(_guest_email, '')), ''), nullif(trim(coalesce(_guest_phone, '')), ''))
  returning id into v_guest_id;

  insert into public.reservation
    (tenant_id, hotel_id, room_type_id, guest_id, check_in_date, check_out_date, total_amount, currency, channel, mcp_agent_id, mcp_client_request_id)
  values
    (v_cred.tenant_id, v_cred.hotel_id, _room_type_id, v_guest_id, _check_in, _check_out, v_quote.net_amount, v_quote.currency, 'agente_ia_externo', v_cred.agent_id, _client_request_id)
  returning * into v_reservation;

  insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
  values (
    v_cred.tenant_id, v_cred.hotel_id, 'reservation', v_reservation.id, 'reservation.created',
    jsonb_build_object('reservationId', v_reservation.id, 'totalAmount', v_quote.net_amount, 'channel', 'agente_ia_externo', 'mcpAgentId', v_cred.agent_id)
  );

  perform public.record_audit_log(
    v_cred.tenant_id, v_cred.hotel_id, 'reservation.created_by_mcp_agent', 'reservation', v_reservation.id,
    jsonb_build_object('mcpAgentId', v_cred.agent_id, 'channel', 'agente_ia_externo')
  );

  return query select v_reservation.id, v_reservation.confirmation_code, v_reservation.total_amount, v_reservation.currency, false;
end;
$$;

revoke all on function public.book_reservation_mcp_agent(text, uuid, date, date, text, text, text, text) from public;
grant execute on function public.book_reservation_mcp_agent(text, uuid, date, date, text, text, text, text) to atiende_app, authenticated;
