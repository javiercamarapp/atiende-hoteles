-- H1 · reservation (ADR-005): estados cotizada -> confirmada -> check_in -> en_estancia
-- -> check_out -> cerrada, laterales cancelada/no_show. Cada transicion se valida con un
-- trigger (constraint declarativo no alcanza para una maquina de estados con 8 nodos) y
-- se registra en `reservation_status_event`, append-only, como bitacora minima de tipo
-- event-sourcing (REQ-REC-004: "cada transicion es un evento append-only, nunca un UPDATE
-- destructivo del estado anterior" -- aqui el UPDATE de `status` sigue existiendo sobre la
-- fila viva de `reservation` para simplicidad operativa de H1, pero el historial de
-- transiciones queda preservado de forma inmutable en el evento).

create type public.reservation_status as enum (
  'cotizada', 'confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada', 'cancelada', 'no_show'
);

create table public.reservation (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_type_id uuid not null references public.room_type(id) on delete restrict,
  guest_id uuid references public.guest(id) on delete set null,
  check_in_date date not null,
  check_out_date date not null check (check_out_date > check_in_date),
  status public.reservation_status not null default 'cotizada',
  idempotency_key text,
  total_amount numeric(12, 2) not null default 0 check (total_amount >= 0),
  currency text not null default 'MXN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reservation_tenant_hotel_dates_idx
  on public.reservation (tenant_id, hotel_id, check_in_date, check_out_date);
create unique index reservation_tenant_idempotency_key_idx
  on public.reservation (tenant_id, idempotency_key)
  where idempotency_key is not null;

create table public.reservation_status_event (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservation(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  from_status public.reservation_status,
  to_status public.reservation_status not null,
  actor_user_id uuid,
  created_at timestamptz not null default now()
);
create index reservation_status_event_reservation_idx
  on public.reservation_status_event (reservation_id, created_at);
create index reservation_status_event_tenant_idx
  on public.reservation_status_event (tenant_id, hotel_id);

-- Tabla de transiciones validas, mas facil de auditar/extender que un CASE largo.
create table public.reservation_status_transition (
  from_status public.reservation_status not null,
  to_status public.reservation_status not null,
  primary key (from_status, to_status)
);
insert into public.reservation_status_transition (from_status, to_status) values
  ('cotizada', 'confirmada'),
  ('cotizada', 'cancelada'),
  ('confirmada', 'check_in'),
  ('confirmada', 'cancelada'),
  ('confirmada', 'no_show'),
  ('check_in', 'en_estancia'),
  ('en_estancia', 'check_out'),
  ('check_out', 'cerrada');

create or replace function public.reservation_validate_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if not exists (
    select 1 from public.reservation_status_transition
    where from_status = old.status and to_status = new.status
  ) then
    raise exception 'transicion_invalida: % -> % no esta permitida para reservation %',
      old.status, new.status, old.id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger reservation_validate_transition_trg
  before update of status on public.reservation
  for each row execute function public.reservation_validate_transition();

-- La bitacora de transiciones es append-only por diseño: solo se escribe via este
-- trigger SECURITY DEFINER; ningun rol de aplicacion recibe INSERT directo sobre
-- reservation_status_event (ver grants en 0010).
create or replace function public.reservation_log_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.reservation_status_event (reservation_id, tenant_id, hotel_id, from_status, to_status, actor_user_id)
    values (new.id, new.tenant_id, new.hotel_id, null, new.status, auth.uid());
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.reservation_status_event (reservation_id, tenant_id, hotel_id, from_status, to_status, actor_user_id)
    values (new.id, new.tenant_id, new.hotel_id, old.status, new.status, auth.uid());
  end if;

  return new;
end;
$$;

create trigger reservation_log_status_event_ins_trg
  after insert on public.reservation
  for each row execute function public.reservation_log_status_event();

create trigger reservation_log_status_event_upd_trg
  after update on public.reservation
  for each row execute function public.reservation_log_status_event();

alter table public.reservation enable row level security;
alter table public.reservation_status_event enable row level security;

create policy "reservation_tenant_select" on public.reservation for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "reservation_tenant_insert" on public.reservation for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "reservation_tenant_update" on public.reservation for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "reservation_tenant_delete" on public.reservation for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "reservation_status_event_tenant_select" on public.reservation_status_event
  for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
