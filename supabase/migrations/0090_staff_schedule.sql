-- ORIGEN: packages/db/migrations/0090_staff_schedule.sql sha256:e3a5333504e99af25cf452e3e4b9711b09a651bc9d2b40770c169ad995f86cb4
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-BO-024 (P0/GOB, LFT art.132 fr.XXXIV): horario programado por empleado, contra el
-- cual `packages/domain-hotel` cruza lo REALMENTE trabajado (attendance_log, migracion
-- 0091) para detectar horas extra no autorizadas. Es MUTABLE a proposito -- un gerente
-- puede reprogramar un turno futuro sin restriccion -- porque lo que la ley exige
-- inalterable es el REGISTRO DE ASISTENCIA (lo trabajado), no el horario planeado.
create table public.staff_schedule (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  staff_user_id uuid not null references public.staff_user(id) on delete cascade,
  work_date date not null,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  -- Horas extra PRE-AUTORIZADAS para este turno (ej. por el GM, al programarlo). El
  -- cruce en packages/domain-hotel solo marca "no autorizada" la porcion de tiempo
  -- trabajado de mas que EXCEDE este margen -- nunca todo el excedente a ciegas.
  authorized_overtime_minutes integer not null default 0,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, staff_user_id, work_date),
  constraint staff_schedule_rango_valido check (scheduled_end > scheduled_start),
  constraint staff_schedule_overtime_no_negativo check (authorized_overtime_minutes >= 0)
);
create index staff_schedule_hotel_date_idx on public.staff_schedule (hotel_id, work_date);
create index staff_schedule_staff_idx on public.staff_schedule (staff_user_id);

-- upsert_staff_schedule(): unica via de escritura (SECURITY DEFINER). Valida DOS cosas
-- que jamas confia al cliente: (a) que quien llama sea owner/gm de ESE hotel (mismo
-- criterio de administracion que el resto del modulo), y (b) que `_staff_user_id`
-- pertenezca de verdad al `hotel_staff` de `_hotel_id` -- sin esto, un owner de un hotel
-- podria programar un "horario" para un empleado de otro hotel/organizacion.
create or replace function public.upsert_staff_schedule(
  _hotel_id uuid,
  _staff_user_id uuid,
  _work_date date,
  _scheduled_start timestamptz,
  _scheduled_end timestamptz,
  _authorized_overtime_minutes integer default 0
)
returns public.staff_schedule
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff_schedule;
begin
  if not public.has_hotel_role(_hotel_id, array['owner', 'gm']::public.hotel_role[]) then
    raise exception 'rol_no_autorizado: solo owner/gm puede programar horarios de asistencia' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.hotel_staff where hotel_id = _hotel_id and user_id = _staff_user_id
  ) then
    raise exception 'staff_no_pertenece_al_hotel: el empleado no pertenece a este hotel' using errcode = 'P0001';
  end if;

  if _scheduled_end <= _scheduled_start then
    raise exception 'rango_invalido: scheduled_end debe ser posterior a scheduled_start' using errcode = 'P0001';
  end if;

  if coalesce(_authorized_overtime_minutes, 0) < 0 then
    raise exception 'overtime_invalido: authorized_overtime_minutes no puede ser negativo' using errcode = 'P0001';
  end if;

  insert into public.staff_schedule (
    hotel_id, staff_user_id, work_date, scheduled_start, scheduled_end, authorized_overtime_minutes, created_by
  )
  values (
    _hotel_id, _staff_user_id, _work_date, _scheduled_start, _scheduled_end,
    coalesce(_authorized_overtime_minutes, 0), auth.uid()
  )
  on conflict (hotel_id, staff_user_id, work_date)
  do update set
    scheduled_start = excluded.scheduled_start,
    scheduled_end = excluded.scheduled_end,
    authorized_overtime_minutes = excluded.authorized_overtime_minutes,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.upsert_staff_schedule(uuid, uuid, date, timestamptz, timestamptz, integer) from public;
grant execute on function public.upsert_staff_schedule(uuid, uuid, date, timestamptz, timestamptz, integer)
  to atiende_app, authenticated;

alter table public.staff_schedule enable row level security;
-- SELECT: el propio empleado ve su horario; owner/gm (administracion) ven el de
-- cualquiera del hotel. Mismo criterio de privacidad que attendance_log (0091): datos de
-- jornada laboral individual, no "transparencia total" como audit_log/agent_run.
create policy "staff_schedule_self_or_admin_select" on public.staff_schedule for select to authenticated
  using (
    staff_user_id = auth.uid()
    or public.has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
-- Sin policy de insert/update/delete para `authenticated`: toda escritura pasa por
-- upsert_staff_schedule() (SECURITY DEFINER); no hay borrado (un turno reprogramado se
-- sobrescribe via upsert, nunca desaparece sin dejar el valor previo visible en el propio
-- upsert -- si se necesitara historial de reprogramaciones, seria un modulo aparte).

grant select on public.staff_schedule to authenticated;
