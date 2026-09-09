-- ORIGEN: packages/db/migrations/0118_attendance_log.sql sha256:897345cdaf6eb906322c6834aa2034d636f6bc84a9263870995c1dcd20a1f0dc
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): checador/registro de asistencia
-- INALTERABLE (append-only) y exportable a STPS. Mismo patron append-only + hash
-- encadenado con "cabeza de cadena" bloqueada por FOR UPDATE que audit_log
-- (0008/0012/0015) -- se aplica aqui la version YA CORREGIDA desde el inicio (0015
-- documenta por que un simple `order by ... desc limit 1`, o incluso un advisory lock
-- por si solo, bifurca la cadena bajo escritura concurrente real).
--
-- La cadena se encadena POR EMPLEADO (staff_user_id), no por tenant/hotel: un checador
-- real es, por diseno, el historial propio de cada trabajador ante la autoridad laboral
-- (la inspeccion de la STPS es "el registro de ESTE trabajador"), y encadenar por
-- empleado evita que la escritura concurrente de decenas de empleados de un mismo hotel
-- compita por una sola cabeza de cadena sin necesidad -- la garantia de inmutabilidad en
-- si es por FILA (el trigger de bloqueo de abajo), no por el alcance de la cadena.
create type public.attendance_event_type as enum ('entrada', 'salida');

create table public.attendance_log (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotel(id) on delete restrict,
  staff_user_id uuid not null references public.staff_user(id) on delete restrict,
  event_type public.attendance_event_type not null,
  recorded_at timestamptz not null default now(),
  source text not null default 'app',
  note text,
  seq bigint generated always as identity,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
create unique index attendance_log_seq_idx on public.attendance_log (seq);
create index attendance_log_staff_seq_idx on public.attendance_log (staff_user_id, seq);
create index attendance_log_hotel_recorded_idx on public.attendance_log (hotel_id, recorded_at);

-- Cabeza de cadena por empleado, bloqueada con FOR UPDATE dentro del trigger -- ver
-- 0015_audit_log_advisory_lock.sql para el razonamiento completo de por que esto (y no
-- un `order by seq desc limit 1` ni un advisory lock aislado) es lo unico que no
-- bifurca la cadena bajo escritura concurrente real.
create table public.attendance_log_chain_head (
  staff_user_id uuid primary key references public.staff_user(id) on delete cascade,
  hash text
);
revoke all on public.attendance_log_chain_head from public;
alter table public.attendance_log_chain_head enable row level security;
-- Sin ninguna policy: `authenticated` queda sin SELECT/INSERT/UPDATE/DELETE directo,
-- solo el trigger de abajo (corre con el privilegio de quien define la funcion via
-- SECURITY DEFINER de record_attendance_event) la toca.

create or replace function public.attendance_log_set_hash()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
  v_recorded_at timestamptz;
  v_canonical text;
begin
  insert into public.attendance_log_chain_head (staff_user_id, hash)
  values (new.staff_user_id, null)
  on conflict (staff_user_id) do nothing;

  select hash into v_prev_hash
  from public.attendance_log_chain_head
  where staff_user_id = new.staff_user_id
  for update;

  v_recorded_at := coalesce(new.recorded_at, now());

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.hotel_id::text
    || '|' || new.staff_user_id::text
    || '|' || new.event_type::text
    || '|' || v_recorded_at::text
    || '|' || new.source
    || '|' || coalesce(new.note, '');

  new.prev_hash := v_prev_hash;
  new.recorded_at := v_recorded_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  update public.attendance_log_chain_head set hash = new.hash where staff_user_id = new.staff_user_id;

  return new;
end;
$$;

create trigger attendance_log_set_hash_trg
  before insert on public.attendance_log
  for each row execute function public.attendance_log_set_hash();

create or replace function public.attendance_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'attendance_log_append_only: % no esta permitido sobre attendance_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger attendance_log_block_update_trg
  before update on public.attendance_log
  for each row execute function public.attendance_log_block_mutation();

create trigger attendance_log_block_delete_trg
  before delete on public.attendance_log
  for each row execute function public.attendance_log_block_mutation();

-- record_attendance_event(): unica via de insercion (SECURITY DEFINER). SIEMPRE registra
-- al propio `auth.uid()` como `staff_user_id` -- nunca un id que el cliente pudiera
-- mandar en el body -- checador de autoservicio: nadie puede fichar la entrada/salida de
-- OTRO empleado, cerrando por diseno el vector de fraude mas comun de un checador (un
-- companero marca la asistencia de quien todavia no ha llegado).
create or replace function public.record_attendance_event(
  _hotel_id uuid,
  _event_type public.attendance_event_type,
  _source text default 'app',
  _note text default null
)
returns public.attendance_log
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.attendance_log;
begin
  if not public.is_hotel_staff(_hotel_id) then
    raise exception 'hotel_no_autorizado: no perteneces al staff de este hotel' using errcode = '42501';
  end if;

  insert into public.attendance_log (hotel_id, staff_user_id, event_type, source, note)
  values (_hotel_id, auth.uid(), _event_type, coalesce(nullif(trim(_source), ''), 'app'), _note)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_attendance_event(uuid, public.attendance_event_type, text, text) from public;
grant execute on function public.record_attendance_event(uuid, public.attendance_event_type, text, text)
  to atiende_app, authenticated;

alter table public.attendance_log enable row level security;
-- SELECT: el propio empleado ve su historial; owner/gm (los responsables ante una
-- inspeccion de la STPS) ven el de cualquiera del hotel. A diferencia de audit_log
-- (transparencia total intra-hotel) esto es dato personal de jornada laboral, con el
-- mismo criterio de minimizacion que boveda_identidad/consentimiento (0068).
create policy "attendance_log_self_or_admin_select" on public.attendance_log for select to authenticated
  using (
    staff_user_id = auth.uid()
    or public.has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
-- Sin policy de insert/update/delete para `authenticated`: unica via es
-- record_attendance_event() (SECURITY DEFINER); UPDATE/DELETE ademas bloqueados por
-- trigger para CUALQUIER rol, incluido el dueno de la migracion (defensa en profundidad,
-- mismo criterio que audit_log/0008) -- esto es lo que hace el registro "inalterable"
-- exigido por LFT art.132 fr.XXXIV, no solo la ausencia de una policy de escritura.

grant select on public.attendance_log to authenticated;
