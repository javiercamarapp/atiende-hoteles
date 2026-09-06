-- ORIGEN: packages/db/migrations/0031_night_audit.sql sha256:a788bbb13795c1b1645d5b5760335063a305341d02ceb690f796cf6c7d177e48
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H5 · Night audit propio (REQ-REV-013/H16-003), independiente del PMS del hotel:
-- postea hospedaje a folios en casa, marca no-shows (reutiliza jobs/noShow.ts),
-- congela el día y genera un resumen de caja. Idempotente por diseño: una segunda
-- corrida del MISMO (hotel_id, business_date) siempre devuelve el resumen ya
-- guardado, sin volver a postear nada (verificado en
-- tests/integration/revenue/night-audit.spec.ts).

create table public.night_audit_run (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  business_date date not null,
  status text not null default 'en_progreso' check (status in ('en_progreso', 'completado')),
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (hotel_id, business_date)
);
create index night_audit_run_tenant_hotel_idx on public.night_audit_run (tenant_id, hotel_id);

alter table public.night_audit_run enable row level security;
create policy "night_audit_run_money_role_select" on public.night_audit_run for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
-- GRANT + RLS son independientes (ver 0010): sin este GRANT la política de arriba
-- nunca llega a evaluarse -- `authenticated` solo puede SELECT (la única escritura
-- sancionada son las dos funciones SECURITY DEFINER de abajo).
grant select on public.night_audit_run to authenticated;
-- Sin policy de insert/update para `authenticated`: toda escritura pasa por las dos
-- funciones SECURITY DEFINER de abajo, para poder tomar el advisory lock y resolver
-- la carrera "dos corridas concurrentes del mismo día" de forma atómica dentro de la
-- función, no en el código de aplicación.

-- night_audit_claim(): serializa dos corridas concurrentes del MISMO
-- (hotel_id, business_date) con un advisory lock de transacción y reclama la corrida
-- con `insert ... on conflict do nothing`. Si ya existe una corrida completada, la
-- devuelve tal cual (already_completed = true) para que el llamador NUNCA vuelva a
-- postear cargos.
create or replace function public.night_audit_claim(
  _tenant_id uuid,
  _hotel_id uuid,
  _business_date date
)
returns table (run_id uuid, already_completed boolean, summary jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.night_audit_run;
begin
  perform pg_advisory_xact_lock(hashtext('night_audit:' || _hotel_id::text || ':' || _business_date::text));

  insert into public.night_audit_run (tenant_id, hotel_id, business_date, status)
  values (_tenant_id, _hotel_id, _business_date, 'en_progreso')
  on conflict (hotel_id, business_date) do nothing
  returning * into v_row;

  if found then
    return query select v_row.id, false, v_row.summary;
    return;
  end if;

  select * into v_row from public.night_audit_run
  where hotel_id = _hotel_id and business_date = _business_date;

  return query select v_row.id, (v_row.status = 'completado'), v_row.summary;
end;
$$;

revoke all on function public.night_audit_claim(uuid, uuid, date) from public;
grant execute on function public.night_audit_claim(uuid, uuid, date) to atiende_app, authenticated;

create or replace function public.night_audit_finish(_run_id uuid, _summary jsonb)
returns public.night_audit_run
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.night_audit_run;
begin
  update public.night_audit_run
  set status = 'completado', summary = _summary, completed_at = now()
  where id = _run_id
  returning * into v_row;

  if not found then
    raise exception 'night_audit_run_no_encontrado: %', _run_id using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.night_audit_finish(uuid, jsonb) from public;
grant execute on function public.night_audit_finish(uuid, jsonb) to atiende_app, authenticated;
