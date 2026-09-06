-- H6b · REQ-HK-011/013/014: ticket de mantenimiento correctivo. `origin` cubre las
-- fuentes exigidas (huesped/staff/agente/sensor); `estimated_cost`/`actual_cost` +
-- `approval_id` enlazan con `agent_approval` (0042) cuando el costo supera el umbral que
-- decide `apps/api` (tool "autorizar gasto de mantenimiento" en agent-core, needsApproval
-- money). RLS: `maintenance` solo lee/escribe SUS tickets asignados (ni siquiera ve el
-- costo de los de otro tecnico); `housekeeping` puede REPORTAR un ticket (insert) pero no
-- leerlo de vuelta ni cambiar su costo/estado (sin policy de select/update para ese rol,
-- fail-closed); recepcion/gerente ven y administran todos los del hotel.

create type public.maintenance_ticket_origin as enum ('huesped', 'staff', 'agente', 'sensor');
create type public.maintenance_ticket_severity as enum ('alta', 'media', 'baja');
create type public.maintenance_ticket_status as enum ('abierto', 'asignado', 'en_progreso', 'cerrado', 'cancelado');

create table public.maintenance_ticket (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid references public.room(id) on delete set null,
  title text not null,
  description text not null,
  origin public.maintenance_ticket_origin not null default 'staff',
  severity public.maintenance_ticket_severity not null default 'media',
  status public.maintenance_ticket_status not null default 'abierto',
  assigned_to uuid references public.staff_user(id) on delete set null,
  estimated_cost numeric(12, 2) not null default 0 check (estimated_cost >= 0),
  actual_cost numeric(12, 2) check (actual_cost is null or actual_cost >= 0),
  requires_approval boolean not null default false,
  approval_id uuid references public.agent_approval(id) on delete set null,
  part_used text,
  resolution_note text,
  evidence jsonb not null default '[]'::jsonb,
  marks_room_out_of_service boolean not null default false,
  created_by uuid references public.staff_user(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index maintenance_ticket_tenant_hotel_idx on public.maintenance_ticket (tenant_id, hotel_id);
create index maintenance_ticket_room_idx on public.maintenance_ticket (room_id) where room_id is not null;
create index maintenance_ticket_assigned_idx on public.maintenance_ticket (hotel_id, assigned_to, status);

alter table public.maintenance_ticket enable row level security;

-- `or created_by = auth.uid()`: sin esto, un INSERT con RETURNING desde un rol que
-- reporta pero no gestiona (housekeeping) es rechazado por Postgres como violacion de RLS
-- -- `INSERT ... RETURNING` verifica la fila resultante contra la policy de SELECT, no
-- solo contra el WITH CHECK de INSERT (comprobado empiricamente: sin esta clausula, la
-- camarista NUNCA puede crear un ticket, ni siquiera el suyo propio). Quien reporta puede
-- seguir SU PROPIO reporte; sigue sin poder ver ni cambiar el costo de tickets ajenos
-- (adversarial: "camarista no ve tareas de otro hotel ni cambia costo").
create policy "maintenance_ticket_manager_select" on public.maintenance_ticket for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and (
      has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
      or (has_hotel_role(hotel_id, array['maintenance']::public.hotel_role[]) and assigned_to = auth.uid())
      or created_by = auth.uid()
    )
  );
-- Cualquier miembro del staff del hotel puede REPORTAR un ticket (REQ-HK-011: camarista,
-- recepcion, o el propio agente en nombre de un huesped/sensor).
create policy "maintenance_ticket_staff_insert" on public.maintenance_ticket for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'housekeeping', 'maintenance']::public.hotel_role[]
    )
  );
-- UPDATE (incluye costo/estado/cierre): NUNCA housekeeping ni frontdesk -- solo owner/gm
-- o el tecnico de mantenimiento AL QUE ESTA ASIGNADO el ticket (adversarial: "camarista
-- no cambia costo").
create policy "maintenance_ticket_scope_update" on public.maintenance_ticket for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
    or (has_hotel_role(hotel_id, array['maintenance']::public.hotel_role[]) and assigned_to = auth.uid())
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
    or (has_hotel_role(hotel_id, array['maintenance']::public.hotel_role[]) and assigned_to = auth.uid())
  );
create policy "maintenance_ticket_manager_delete" on public.maintenance_ticket for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.maintenance_ticket to authenticated;
