-- H4 · Extensiones de tarifas/restricciones/políticas para el motor de cotización
-- determinista (`@atiende-hoteles/domain-hotel`) y el ciclo de vida completo de la
-- reserva (modificación bajo lock, cancelación con política, no-show, sobreventa
-- controlada). Expand-only sobre 0004/0006/0008/0009 (REQ-GOB-010): ninguna migración
-- ya aplicada se edita.

-- Restricciones de estadía por noche (MinLOS/CTA/CTD, citadas en H07-005): viven en
-- `rate_plan` porque varían por temporada igual que el precio, no son un valor fijo del
-- room_type. Los defaults reproducen "sin restricción" para todo lo ya sembrado.
alter table public.rate_plan add column min_stay integer not null default 1 check (min_stay >= 1);
alter table public.rate_plan add column closed_to_arrival boolean not null default false;
alter table public.rate_plan add column closed_to_departure boolean not null default false;

-- Sobreventa controlada (REQ-RES-007/H02-010, "1-2 habitaciones solo en fechas de alta
-- ocupación"): configurable por tipo de habitación, nunca un límite global fijo.
-- `max_overbook_rooms = 0` (default) reproduce EXACTAMENTE el comportamiento anterior
-- de `book_availability` — ninguna sobreventa salvo que un rol autorizado la configure.
alter table public.room_type add column max_overbook_rooms integer not null default 0 check (max_overbook_rooms >= 0);
alter table public.room_type add column overbooking_occupancy_threshold_pct numeric(5, 2) not null default 95
  check (overbooking_occupancy_threshold_pct between 0 and 100);

-- El CHECK original de 0004 (`booked_rooms <= total_rooms`, sin nombre explícito,
-- Postgres lo bautizó "availability_check") bloquearía CUALQUIER sobreventa sin
-- importar lo que `book_availability()` decida más abajo -- un CHECK de tabla no puede
-- referenciar `room_type.max_overbook_rooms` (otra tabla), así que no se puede
-- "arreglar" con otro CHECK: se elimina y la invariante ("nunca vender más que
-- total_rooms + sobreventa vigente") queda exclusivamente a cargo de
-- `book_availability()`/`release_availability()` como ÚNICA vía de escritura
-- sancionada (ya documentado así desde 0004). Localizado dinámicamente por su
-- definición (no por nombre) para no depender de que Postgres siga generando el mismo
-- nombre automático en otra versión/motor.
do $$
declare
  con record;
begin
  for con in
    select conname
    from pg_constraint
    where conrelid = 'public.availability'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) = 'CHECK ((booked_rooms <= total_rooms))'
  loop
    execute format('alter table public.availability drop constraint %I', con.conname);
  end loop;
end $$;

-- Impuestos por hotel (REQ-REV-001): IVA/ISH son PARÁMETROS configurables por hotel,
-- nunca una verdad fiscal fija en código. El motor de cotización los lee de aquí; el
-- LLM jamás calcula ni fija esta cifra por ninguna ruta de código.
create table public.hotel_tax_config (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  iva_rate numeric(6, 4) not null default 0.16 check (iva_rate >= 0 and iva_rate <= 1),
  ish_rate numeric(6, 4) not null default 0.03 check (ish_rate >= 0 and ish_rate <= 1),
  updated_at timestamptz not null default now()
);

-- Política de cancelación/depósito (REQ-RES-004), estructurada en los 4 puntos citados
-- por el encargo (`free_until`, `penalty`, `no_show`, `deposit`), configurable por
-- hotel. La reserva guarda una COPIA (`cancellation_policy_snapshot`) al crearse para
-- que un cambio posterior de política no altere retroactivamente reservas ya hechas.
create table public.hotel_cancellation_policy (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  free_until_hours integer not null default 24 check (free_until_hours >= 0),
  penalty_pct numeric(5, 2) not null default 50 check (penalty_pct between 0 and 100),
  no_show_pct numeric(5, 2) not null default 100 check (no_show_pct between 0 and 100),
  deposit_pct numeric(5, 2) not null default 20 check (deposit_pct between 0 and 100),
  updated_at timestamptz not null default now()
);

-- REQ-RES-004: "siempre debe entregar un número de cancelación al confirmar" — el mismo
-- código sirve también como código de reserva para el huésped (REQ-RES-005: código +
-- apellido). Es GLOBAL (no indexado por tenant): un huésped que llama solo conoce su
-- código, no de qué tenant es — debe ser localizable sin conocer el hotel de antemano.
alter table public.reservation
  add column confirmation_code text default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
alter table public.reservation add column cancellation_policy_snapshot jsonb;
alter table public.reservation add column canceled_at timestamptz;
alter table public.reservation add column cancellation_penalty_amount numeric(12, 2);

-- El DEFAULT de arriba solo aplica a INSERTs futuros; esta actualización cubre
-- filas insertadas por una versión previa de esta migración o por un dump restaurado
-- antes de que existiera la columna (nunca dependemos de que "ya nadie tiene datos").
update public.reservation
set confirmation_code = upper(substr(encode(sha256(id::text::bytea), 'hex'), 1, 8))
where confirmation_code is null;

alter table public.reservation alter column confirmation_code set not null;
create unique index reservation_confirmation_code_idx on public.reservation (confirmation_code);

-- Sobreventa controlada dentro del MISMO advisory lock (ADR-004): reemplaza el cuerpo
-- de `book_availability` (0004) sin cambiar su firma — toda ruta que ya lo invoca (H2)
-- sigue funcionando idéntico mientras `max_overbook_rooms = 0` (default de 0004/aquí).
create or replace function public.book_availability(
  _hotel_id uuid,
  _room_type_id uuid,
  _date date,
  _qty integer default 1
)
returns public.availability
language plpgsql
as $$
declare
  v_row public.availability;
  v_max_overbook integer;
  v_threshold numeric;
  v_effective_capacity integer;
  v_occupancy_pct numeric;
begin
  if _qty <= 0 then
    raise exception 'cantidad_invalida: _qty debe ser mayor a 0';
  end if;

  perform public.lock_availability(_hotel_id, _room_type_id, _date);

  select * into v_row
  from public.availability
  where hotel_id = _hotel_id and room_type_id = _room_type_id and date = _date
  for update;

  if not found then
    raise exception 'sin_disponibilidad: no existe inventario para hotel=%, room_type=%, fecha=%',
      _hotel_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  select max_overbook_rooms, overbooking_occupancy_threshold_pct
    into v_max_overbook, v_threshold
    from public.room_type
    where id = _room_type_id;

  v_occupancy_pct := case
    when v_row.total_rooms > 0 then (v_row.booked_rooms::numeric / v_row.total_rooms::numeric) * 100
    else 100
  end;

  -- La sobreventa solo se habilita al alcanzar el umbral de ocupación configurado
  -- (H02-010/H02 p.16): por debajo del umbral, `max_overbook_rooms` no aplica.
  v_effective_capacity := v_row.total_rooms
    + case when v_occupancy_pct >= coalesce(v_threshold, 95) then coalesce(v_max_overbook, 0) else 0 end;

  if v_row.booked_rooms + _qty > v_effective_capacity then
    raise exception 'sin_disponibilidad: no hay habitaciones libres para hotel=%, room_type=%, fecha=%',
      _hotel_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  update public.availability
  set booked_rooms = booked_rooms + _qty, updated_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- release_availability(): contraparte simétrica de book_availability para
-- cancelación/modificación — mismo advisory lock, nunca deja `booked_rooms` negativo.
create or replace function public.release_availability(
  _hotel_id uuid,
  _room_type_id uuid,
  _date date,
  _qty integer default 1
)
returns public.availability
language plpgsql
as $$
declare
  v_row public.availability;
begin
  if _qty <= 0 then
    raise exception 'cantidad_invalida: _qty debe ser mayor a 0';
  end if;

  perform public.lock_availability(_hotel_id, _room_type_id, _date);

  update public.availability
  set booked_rooms = greatest(booked_rooms - _qty, 0), updated_at = now()
  where hotel_id = _hotel_id and room_type_id = _room_type_id and date = _date
  returning * into v_row;

  if not found then
    raise exception 'sin_disponibilidad: no existe inventario para hotel=%, room_type=%, fecha=%',
      _hotel_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

grant execute on function public.release_availability(uuid, uuid, date, integer) to atiende_app, authenticated;

-- Cancelación verificada por identidad (REQ-RES-005/H03-025): código de reserva +
-- apellido, SIN sesión de staff — por eso corre SECURITY DEFINER (mismo patrón que
-- `record_audit_log` en 0008): es la única vía que puede tocar una `reservation` sin
-- que quien llama pertenezca al `hotel_staff` de ese hotel. El apellido se compara
-- como subcadena case-insensitive de `guest.full_name` porque el esquema (0005) no
-- separa nombre/apellido; se documenta como simplificación deliberada, no un error.
create or replace function public.cancel_reservation_public(
  _confirmation_code text,
  _apellido text
)
returns public.reservation
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res public.reservation;
  v_res_found boolean;
  v_guest_name text;
  v_policy record;
  v_hours_until_checkin numeric;
  v_penalty numeric(12, 2);
  v_night date;
begin
  -- No se puede mezclar una variable %ROWTYPE (v_res) con una escalar (v_guest_name) en
  -- el mismo INTO de plpgsql ("record variable cannot be part of multiple-item INTO
  -- list") -- se resuelve en dos pasos: la fila completa primero, el nombre del huésped
  -- después a partir de `v_res.guest_id` ya resuelto. `FOUND` se guarda en
  -- `v_res_found` de inmediato porque el segundo SELECT lo sobrescribe.
  select r.* into v_res
  from public.reservation r
  where r.confirmation_code = upper(trim(_confirmation_code))
  for update of r;
  v_res_found := found;

  if v_res_found then
    select g.full_name into v_guest_name from public.guest g where g.id = v_res.guest_id;
  end if;

  if not v_res_found
     or v_guest_name is null
     or length(trim(coalesce(_apellido, ''))) = 0
     or position(lower(trim(_apellido)) in lower(v_guest_name)) = 0 then
    raise exception 'cancelacion_no_verificada: código de reserva o apellido no coinciden'
      using errcode = 'P0001';
  end if;

  if v_res.status not in ('cotizada', 'confirmada') then
    raise exception 'transicion_invalida: la reserva % no admite cancelación en estado %',
      v_res.id, v_res.status
      using errcode = 'P0001';
  end if;

  select * into v_policy from public.hotel_cancellation_policy where hotel_id = v_res.hotel_id;
  v_hours_until_checkin := extract(epoch from (v_res.check_in_date::timestamptz - now())) / 3600;

  if v_policy.hotel_id is null or v_hours_until_checkin >= v_policy.free_until_hours then
    v_penalty := 0;
  else
    v_penalty := round(v_res.total_amount * coalesce(v_policy.penalty_pct, 50) / 100, 2);
  end if;

  v_night := v_res.check_in_date;
  while v_night < v_res.check_out_date loop
    perform public.release_availability(v_res.hotel_id, v_res.room_type_id, v_night, 1);
    v_night := v_night + 1;
  end loop;

  update public.reservation
  set status = 'cancelada', canceled_at = now(), cancellation_penalty_amount = v_penalty, updated_at = now()
  where id = v_res.id
  returning * into v_res;

  perform public.record_audit_log(
    v_res.tenant_id, v_res.hotel_id, 'reservation.canceled_by_guest', 'reservation', v_res.id,
    jsonb_build_object('penaltyAmount', v_penalty, 'verifiedBy', 'confirmation_code+apellido')
  );

  insert into public.outbox (tenant_id, hotel_id, aggregate_type, aggregate_id, event_type, payload)
  values (
    v_res.tenant_id, v_res.hotel_id, 'reservation', v_res.id, 'reservation.canceled',
    jsonb_build_object('penaltyAmount', v_penalty, 'canceledBy', 'guest')
  );

  return v_res;
end;
$$;

revoke all on function public.cancel_reservation_public(text, text) from public;
grant execute on function public.cancel_reservation_public(text, text) to atiende_app, authenticated;

alter table public.hotel_tax_config enable row level security;
alter table public.hotel_cancellation_policy enable row level security;

-- Solo owner/gm configuran impuestos y política de cancelación (más cercano a
-- "gerente"; el catálogo de 8 roles de REQ-TEN-003 no incluye un rol "revenue"
-- dedicado — ver docs/PROGRESO.md H4 para la nota de esta correspondencia).
create policy "hotel_tax_config_tenant_select" on public.hotel_tax_config for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "hotel_tax_config_tenant_insert" on public.hotel_tax_config for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "hotel_tax_config_tenant_update" on public.hotel_tax_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "hotel_cancellation_policy_tenant_select" on public.hotel_cancellation_policy for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "hotel_cancellation_policy_tenant_insert" on public.hotel_cancellation_policy for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "hotel_cancellation_policy_tenant_update" on public.hotel_cancellation_policy for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.hotel_tax_config to authenticated;
grant select, insert, update on public.hotel_cancellation_policy to authenticated;
