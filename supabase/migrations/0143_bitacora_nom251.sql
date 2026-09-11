-- ORIGEN: packages/db/migrations/0143_bitacora_nom251.sql sha256:d0abce7e8a7e30257bff0d2007826ea53cf8c5fcc5403928183c50035bfef542
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-AB-011 (P1/GOB, H10-016): bitácoras digitales de temperatura, recepción y
-- limpieza conforme a NOM-251, disponibles para auditoría COFEPRIS. Una bitácora de
-- cumplimiento que un inspector puede revisar es, por definición, INALTERABLE una vez
-- capturada -- mismo patrón append-only + hash encadenado con "cabeza de cadena"
-- bloqueada por FOR UPDATE que audit_log (0008/0012/0015) y attendance_log (0118), ya
-- corregido desde el inicio (ver 0015 para el razonamiento completo de por qué un
-- simple `order by ... desc limit 1` bifurca la cadena bajo escritura concurrente
-- real).
--
-- La cadena se encadena POR HOTEL (hotel_id), no por empleado: a diferencia del
-- checador (attendance_log, un registro laboral propio de cada trabajador), una
-- bitácora NOM-251 es el registro de CUMPLIMIENTO DEL ESTABLECIMIENTO -- la
-- inspección de COFEPRIS es "el registro de ESTE hotel/cocina", sin importar qué
-- empleado capturó cada renglón. Tres tipos (temperatura/recepción/limpieza)
-- comparten una sola tabla con `payload jsonb` (mismo criterio que `fnb_order.items`)
-- porque el ciclo de vida de cumplimiento -- captura inalterable, consulta, export
-- para auditoría -- es idéntico entre los tres; la forma exacta del payload la valida
-- la capa de aplicación (`@atiende-hoteles/domain-hotel::bitacoraNom251EntradaSchema`,
-- zod discriminado por `tipo`) antes de llegar aquí.
create type public.bitacora_nom251_tipo as enum ('temperatura', 'recepcion', 'limpieza');

create table public.bitacora_nom251_entry (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotel(id) on delete restrict,
  tipo public.bitacora_nom251_tipo not null,
  payload jsonb not null,
  -- Quién capturó el renglón -- auditoría de responsabilidad, no el sujeto del
  -- registro (a diferencia de attendance_log.staff_user_id). `on delete set null`
  -- (mismo criterio que fnb_order.created_by): si el empleado deja de existir en el
  -- sistema, el renglón de cumplimiento SIGUE existiendo intacto para la auditoría,
  -- solo pierde la referencia a quién lo capturó.
  registrado_por uuid references public.staff_user(id) on delete set null,
  recorded_at timestamptz not null default now(),
  seq bigint generated always as identity,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now(),
  -- Barrera estructural mínima: el payload siempre existe y es un objeto JSON. La
  -- forma detallada por tipo (campos exigidos por NOM-251 para cada bitácora) la
  -- valida la aplicación con zod antes del insert -- duplicar esa validación campo por
  -- campo en SQL sería frágil (cualquier cambio de esquema exigiría tocar dos
  -- lugares) sin aportar una garantía de integridad adicional real, a diferencia del
  -- CHECK de fnb_order que sí protege un invariante de seguridad del huésped.
  check (jsonb_typeof(payload) = 'object')
);
create unique index bitacora_nom251_entry_seq_idx on public.bitacora_nom251_entry (seq);
create index bitacora_nom251_entry_hotel_seq_idx on public.bitacora_nom251_entry (hotel_id, seq);
create index bitacora_nom251_entry_hotel_tipo_recorded_idx on public.bitacora_nom251_entry (hotel_id, tipo, recorded_at);

-- Cabeza de cadena por hotel, bloqueada con FOR UPDATE dentro del trigger -- ver
-- 0015_audit_log_advisory_lock.sql para el razonamiento completo de por qué esto (y no
-- un `order by seq desc limit 1` ni un advisory lock aislado) es lo único que no
-- bifurca la cadena bajo escritura concurrente real.
create table public.bitacora_nom251_chain_head (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  hash text
);
revoke all on public.bitacora_nom251_chain_head from public;
alter table public.bitacora_nom251_chain_head enable row level security;
-- Sin ninguna policy: `authenticated` queda sin SELECT/INSERT/UPDATE/DELETE directo,
-- solo el trigger de abajo (corre con el privilegio de quien define la función, vía
-- SECURITY DEFINER de record_bitacora_nom251_entry) la toca.

create or replace function public.bitacora_nom251_entry_set_hash()
returns trigger
language plpgsql
as $$
declare
  v_prev_hash text;
  v_recorded_at timestamptz;
  v_canonical text;
begin
  insert into public.bitacora_nom251_chain_head (hotel_id, hash)
  values (new.hotel_id, null)
  on conflict (hotel_id) do nothing;

  select hash into v_prev_hash
  from public.bitacora_nom251_chain_head
  where hotel_id = new.hotel_id
  for update;

  v_recorded_at := coalesce(new.recorded_at, now());

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.hotel_id::text
    || '|' || new.tipo::text
    || '|' || v_recorded_at::text
    || '|' || new.payload::text
    || '|' || coalesce(new.registrado_por::text, '');

  new.prev_hash := v_prev_hash;
  new.recorded_at := v_recorded_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  update public.bitacora_nom251_chain_head set hash = new.hash where hotel_id = new.hotel_id;

  return new;
end;
$$;

create trigger bitacora_nom251_entry_set_hash_trg
  before insert on public.bitacora_nom251_entry
  for each row execute function public.bitacora_nom251_entry_set_hash();

create or replace function public.bitacora_nom251_entry_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'bitacora_nom251_append_only: % no está permitido sobre bitacora_nom251_entry', tg_op
    using errcode = '0A000';
end;
$$;

create trigger bitacora_nom251_entry_block_update_trg
  before update on public.bitacora_nom251_entry
  for each row execute function public.bitacora_nom251_entry_block_mutation();

create trigger bitacora_nom251_entry_block_delete_trg
  before delete on public.bitacora_nom251_entry
  for each row execute function public.bitacora_nom251_entry_block_mutation();

-- record_bitacora_nom251_entry(): única vía de inserción (SECURITY DEFINER). SIEMPRE
-- registra a quien capturó el renglón como el propio `auth.uid()` de la sesión --
-- nunca un id que el cliente pudiera mandar en el body -- mismo principio de
-- accountability que record_attendance_event(): nadie puede capturar una bitácora "a
-- nombre de" otro compañero. Restringido a los roles con motivo operativo real de
-- tocar temperatura/recepción/limpieza de cocina (owner/gm de respaldo, y 'fnb' que
-- opera la cocina/bar) -- housekeeping/frontdesk/mantenimiento/reservaciones/
-- contabilidad no capturan esta bitácora.
create or replace function public.record_bitacora_nom251_entry(
  _hotel_id uuid,
  _tipo public.bitacora_nom251_tipo,
  _payload jsonb
)
returns public.bitacora_nom251_entry
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.bitacora_nom251_entry;
begin
  if not public.has_hotel_role(_hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]) then
    raise exception 'rol_no_autorizado: tu rol no puede capturar bitácoras NOM-251 de este hotel' using errcode = '42501';
  end if;

  insert into public.bitacora_nom251_entry (hotel_id, tipo, payload, registrado_por)
  values (_hotel_id, _tipo, _payload, auth.uid())
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.record_bitacora_nom251_entry(uuid, public.bitacora_nom251_tipo, jsonb) from public;
grant execute on function public.record_bitacora_nom251_entry(uuid, public.bitacora_nom251_tipo, jsonb)
  to atiende_app, authenticated;

alter table public.bitacora_nom251_entry enable row level security;
-- SELECT: mismos roles que pueden capturar (owner/gm/fnb) -- housekeeping/frontdesk/
-- mantenimiento/reservaciones/contabilidad no tienen necesidad operativa de leer una
-- bitácora de cocina. La exportación formal para el inspector de COFEPRIS la arma la
-- ruta HTTP (owner/gm únicamente, mismo criterio que el ledger de consentimiento de
-- 0068/consentimiento.ts: es un reporte de cumplimiento, no una operación de piso) a
-- partir de esta misma tabla -- no hay acceso directo de un tercero externo a la BD.
create policy "bitacora_nom251_entry_staff_select" on public.bitacora_nom251_entry for select to authenticated
  using (public.has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]));
-- Sin policy de insert/update/delete para `authenticated`: única vía de insert es
-- record_bitacora_nom251_entry() (SECURITY DEFINER); UPDATE/DELETE además bloqueados
-- por trigger para CUALQUIER rol, incluido el dueño de la migración (defensa en
-- profundidad, mismo criterio que audit_log/0008 y attendance_log/0118) -- esto es lo
-- que hace el registro "inalterable" que una bitácora de cumplimiento exige, no solo
-- la ausencia de una policy de escritura.

grant select on public.bitacora_nom251_entry to authenticated;
