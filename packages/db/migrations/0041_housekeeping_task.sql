-- H6b · REQ-HK-001/002/003/020: tarea de housekeeping (asignacion diaria de camarista +
-- checklist + evidencia de inspeccion). RLS: `housekeeping` solo ve/actualiza las tareas
-- asignadas a ELLA (auth.uid() = assigned_to); owner/gm/frontdesk ven y administran todas
-- las del hotel (tablero de supervision). `started_at`/`finished_at` son la base minima
-- del registro de minutos reales (REQ-HK-020) -- el calculo agregado contra nomina queda
-- fuera de alcance de este hito, documentado, no simulado.

create type public.housekeeping_task_priority as enum ('alta', 'media', 'baja');
create type public.housekeeping_task_status as enum ('pendiente', 'en_progreso', 'completada', 'cancelada');

create table public.housekeeping_task (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid not null references public.room(id) on delete cascade,
  assigned_to uuid references public.staff_user(id) on delete set null,
  priority public.housekeeping_task_priority not null default 'media',
  status public.housekeeping_task_status not null default 'pendiente',
  sla_due_at timestamptz,
  checklist jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  notes text,
  started_at timestamptz,
  finished_at timestamptz,
  inspected_by uuid references public.staff_user(id) on delete set null,
  inspected_at timestamptz,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index housekeeping_task_tenant_hotel_idx on public.housekeeping_task (tenant_id, hotel_id);
create index housekeeping_task_room_idx on public.housekeeping_task (room_id);
create index housekeeping_task_assigned_idx on public.housekeeping_task (hotel_id, assigned_to, status);

alter table public.housekeeping_task enable row level security;

create policy "housekeeping_task_scope_select" on public.housekeeping_task for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and hotel_id = any (current_hotel_ids())
    and (
      has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
      or (has_hotel_role(hotel_id, array['housekeeping']::public.hotel_role[]) and assigned_to = auth.uid())
    )
  );
create policy "housekeeping_task_supervisor_insert" on public.housekeeping_task for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
  );
-- UPDATE: la propia camarista puede avanzar SU tarea (inicio/termino/checklist/evidencia);
-- owner/gm/frontdesk pueden reasignar/inspeccionar/cancelar cualquiera del hotel. La
-- restriccion de QUE columnas puede tocar cada rol vive en apps/api (RLS aqui protege la
-- FILA, no la columna) -- documentado explicitamente, no fingido como control de columna.
create policy "housekeeping_task_scope_update" on public.housekeeping_task for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
    or (has_hotel_role(hotel_id, array['housekeeping']::public.hotel_role[]) and assigned_to = auth.uid())
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
    or (has_hotel_role(hotel_id, array['housekeeping']::public.hotel_role[]) and assigned_to = auth.uid())
  );
create policy "housekeeping_task_supervisor_delete" on public.housekeeping_task for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.housekeeping_task to authenticated;
