-- ORIGEN: packages/db/migrations/0075_aprobacion_delegado.sql sha256:f4f3348af01fc68dc03e970d1cf8b2a1941c29864263240654069ced520fbdaa
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- A6 (auditoria-2 agentico ALTO, GOB-026): la doble confirmación de dinero exige DOS
-- ROLES de staff distintos -- estructuralmente imposible en un hotel con un solo
-- administrador (owner O gm, no ambos), el perfil típico del cliente objetivo (hotel
-- independiente pequeño, el propio caso ancla del blueprint). Antes, cualquier tool
-- effect="money" quedaba permanentemente inutilizable para ese hotel: la solicitud
-- expiraba a los 15 minutos sin ningún camino para completarla, sin ninguna alerta ni
-- sugerencia de acción.
--
-- Política configurable por hotel, con default explícito y documentado: SIN delegado
-- configurado, el comportamiento NO cambia (dos administradores reales siguen siendo
-- el camino normal, y un hotel de un solo administrador sigue sin poder completar
-- aprobaciones de dinero -- exactamente como antes). El owner/gm ÚNICO de un hotel
-- puede DESIGNAR a otro miembro real del staff (de cualquier rol -- housekeeping,
-- frontdesk, accountant, etc.) como "segundo aprobador delegado" para dinero: su rol
-- real ya es distinto del owner/gm que dio la primera confirmación, así que
-- `decide()` (packages/agent-core) sigue exigiendo roles distintos SIN NINGUNA
-- excepción -- lo único que cambia es QUIÉN tiene permiso de decidir sobre
-- `agent_approval`, nunca la regla de negocio de "dos roles distintos" en sí.
create table public.hotel_approval_delegate (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  org_id uuid not null references public.org(id) on delete cascade,
  user_id uuid not null references public.staff_user(id) on delete cascade,
  designated_by uuid not null references public.staff_user(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hotel_approval_delegate_org_idx on public.hotel_approval_delegate (org_id);

alter table public.hotel_approval_delegate enable row level security;

-- SELECT: transparencia total dentro del hotel (cualquier rol de staff puede ver quién
-- es el delegado vigente, mismo criterio que agent_approval/agent_config).
create policy "hotel_approval_delegate_hotel_select" on public.hotel_approval_delegate for select to authenticated
  using (hotel_id = any (current_hotel_ids()));

-- INSERT/UPDATE/DELETE: designar o revocar al delegado es una decisión de owner/gm,
-- igual que cambiar el gate de un agente o el techo de costo.
create policy "hotel_approval_delegate_manager_insert" on public.hotel_approval_delegate for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_approval_delegate_manager_update" on public.hotel_approval_delegate for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_approval_delegate_manager_delete" on public.hotel_approval_delegate for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.hotel_approval_delegate to authenticated;

-- Extiende (sin debilitar) las policies existentes de agent_approval/
-- agent_approval_confirmation (0042) para aceptar TAMBIÉN al delegado designado del
-- hotel, además de owner/gm -- sin cambios de comportamiento cuando no hay delegado.
drop policy "agent_approval_manager_update" on public.agent_approval;
create policy "agent_approval_manager_update" on public.agent_approval for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
    or exists (
      select 1 from public.hotel_approval_delegate d
      where d.hotel_id = agent_approval.hotel_id and d.user_id = auth.uid()
    )
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
    or exists (
      select 1 from public.hotel_approval_delegate d
      where d.hotel_id = agent_approval.hotel_id and d.user_id = auth.uid()
    )
  );

drop policy "agent_approval_confirmation_manager_insert" on public.agent_approval_confirmation;
create policy "agent_approval_confirmation_manager_insert" on public.agent_approval_confirmation for insert to authenticated
  with check (
    exists (
      select 1 from public.agent_approval a
      where a.id = approval_id
        and (
          has_hotel_role(a.hotel_id, array['owner', 'gm']::public.hotel_role[])
          or exists (
            select 1 from public.hotel_approval_delegate d
            where d.hotel_id = a.hotel_id and d.user_id = auth.uid()
          )
        )
    )
  );
