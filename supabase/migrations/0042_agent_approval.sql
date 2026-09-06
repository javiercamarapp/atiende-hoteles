-- ORIGEN: packages/db/migrations/0042_agent_approval.sql sha256:c166d7095c3de6ba1069b3689b7caadc03a8bc0786215b28612cbe96be7c0dbc
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H6b · Persistencia de la cola de aprobacion humana (ADR-006, GOB-026) descrita como
-- pendiente en `packages/agent-core/src/approval.ts`/README (H6a): el CONTRATO
-- (`ApprovalQueue`) no cambia, esta tabla es el respaldo para una implementacion
-- `PostgresApprovalQueue` que lo cumpla sin tocar `AgentRunner` ni las tools. Espejo de
-- `ApprovalRequest`/`ApprovalConfirmation` de agent-core: una fila por solicitud, una
-- tabla de confirmaciones aparte para soportar la doble confirmacion de dinero (2 filas
-- de actores/roles distintos, GOB-026).

create type public.agent_approval_status as enum ('pendiente', 'aprobada', 'rechazada', 'expirada');
create type public.agent_approval_decision as enum ('aprobar', 'rechazar');

create table public.agent_approval (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  tool_name text not null,
  input_hash text not null,
  -- Resumen legible del input REAL (redactado) que recibio la tool -- GOB-026: el
  -- aprobador no firma a ciegas. Ver agent-core `describeApprovalInput`.
  input_summary text not null,
  texto_mostrado text not null,
  -- Ambito de conversacion/actor que pidio la accion (p.ej. "agent:<agente>:<actor.id>")
  -- -- forma parte de la llave de idempotencia junto con (hotel, tool, hash(input)) para
  -- que dos conversaciones distintas NUNCA compartan la misma solicitud (aud-1
  -- tool-calling.md CRITICO #1, ver agent-core/src/approval.ts).
  requested_by text not null,
  is_money boolean not null default false,
  required_confirmations integer not null default 1 check (required_confirmations > 0),
  status public.agent_approval_status not null default 'pendiente',
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Indice de apoyo para la busqueda de idempotencia (hotel, tool, hash(input),
-- requested_by) ordenada por vigencia -- ver PostgresApprovalQueue.request() en
-- packages/agent-core. Sin UNIQUE: una solicitud VENCIDA no bloquea crear una nueva con
-- la misma llave (mismo contrato que InMemoryApprovalQueue), asi que puede haber varias
-- filas historicas con la misma llave.
create index agent_approval_lookup_idx
  on public.agent_approval (hotel_id, tool_name, input_hash, requested_by, expires_at desc);
create index agent_approval_hotel_status_idx on public.agent_approval (hotel_id, status);

create table public.agent_approval_confirmation (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.agent_approval(id) on delete cascade,
  actor text not null,
  -- Rol declarado del aprobador; obligatorio en la app para aprobar dinero (GOB-026: DOS
  -- ROLES distintos, no solo dos actores) -- ver agent-core `decide()`.
  role text,
  decision public.agent_approval_decision not null,
  texto_exacto text not null,
  decided_at timestamptz not null default now()
);
create index agent_approval_confirmation_approval_idx on public.agent_approval_confirmation (approval_id);

-- Advisory lock (mismo patron que `lock_availability`, 0004): serializa request() por
-- (hotel, tool, hash(input), requested_by) para que dos llamadas concurrentes con la
-- MISMA llave de idempotencia nunca creen dos solicitudes duplicadas.
create or replace function public.lock_agent_approval_key(
  _hotel_id uuid, _tool_name text, _input_hash text, _requested_by text
)
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(_hotel_id::text || ':' || _tool_name || ':' || _input_hash || ':' || _requested_by, 0)
  );
end;
$$;

alter table public.agent_approval enable row level security;
alter table public.agent_approval_confirmation enable row level security;

-- SELECT: transparencia total dentro del hotel (cualquier rol de staff puede ver la
-- bandeja de aprobaciones de su hotel, incluida la propia badge de pendientes del header).
create policy "agent_approval_hotel_select" on public.agent_approval for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
-- INSERT: cualquier miembro del staff del hotel puede generar una solicitud (la produce
-- el agente en nombre de una accion que un miembro del staff disparo desde la UI/WhatsApp).
create policy "agent_approval_hotel_insert" on public.agent_approval for insert to authenticated
  with check (hotel_id = any (current_hotel_ids()));
-- UPDATE (decidir/expirar): autoridad de aprobacion reservada a owner/gm -- mismo nivel
-- que "quien puede aprobar dinero" en el resto del sistema (ver `can_access_money`,
-- 0007, que SI incluye frontdesk/reservations/fnb/accountant para operaciones de folio;
-- aqui es mas estricto a proposito porque una aprobacion de agente puede autorizar
-- CUALQUIER tool "external"/"money" registrada, no solo cargos de folio).
create policy "agent_approval_manager_update" on public.agent_approval for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "agent_approval_confirmation_hotel_select" on public.agent_approval_confirmation for select to authenticated
  using (
    exists (
      select 1 from public.agent_approval a
      where a.id = approval_id and a.hotel_id = any (current_hotel_ids())
    )
  );
create policy "agent_approval_confirmation_manager_insert" on public.agent_approval_confirmation for insert to authenticated
  with check (
    exists (
      select 1 from public.agent_approval a
      where a.id = approval_id
        and has_hotel_role(a.hotel_id, array['owner', 'gm']::public.hotel_role[])
    )
  );

grant select, insert, update on public.agent_approval to authenticated;
grant select, insert on public.agent_approval_confirmation to authenticated;
grant execute on function public.lock_agent_approval_key(uuid, text, text, text) to atiende_app, authenticated;
