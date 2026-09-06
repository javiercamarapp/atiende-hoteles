-- ORIGEN: packages/db/migrations/0052_local_knowledge.sql sha256:47f5c5429447e51061e531bfc26b2e38cb0dd37c42c800d958a0520a4e6c6397
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-UX-005/REQ-HUE-026 (H08-024): "El sistema debe mantener un panel de
-- 'conocimiento local' (sargazo, clima, cierres de playa, horarios de ferry, eventos)
-- editable por el gerente y reflejado en las respuestas del agente conversacional en
-- <30 s." El agente conversacional de WhatsApp/voz aún no existe en este repo
-- (requiere credenciales reales de Meta/Telnyx, ver docs/cierre-p0/inventario.md §2) --
-- esta migración construye la parte real y verificable sin esa dependencia: la FUENTE
-- DE DATOS real (esta tabla) con lectura inmediata (sin caché) tras cada escritura, que
-- es exactamente lo que un agente consultaría en vivo el día que exista.
--
-- Expand-only (REQ-GOB-010): tabla nueva.

create table public.local_knowledge_entry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  category text not null check (category in ('sargazo', 'clima', 'playa', 'ferry', 'eventos', 'otro')),
  title text not null,
  content text not null,
  updated_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index local_knowledge_entry_tenant_hotel_idx on public.local_knowledge_entry (tenant_id, hotel_id);
create index local_knowledge_entry_category_idx on public.local_knowledge_entry (hotel_id, category);

alter table public.local_knowledge_entry enable row level security;

-- Lectura: cualquier staff del hotel (housekeeping/mantenimiento también consultan
-- "cierres de playa"/"eventos" al atender huéspedes, no es exclusivo de gerencia).
create policy "local_knowledge_entry_tenant_select" on public.local_knowledge_entry for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));

-- Escritura: "panel del GERENTE" (REQ-UX-005) -- owner/gm/frontdesk (frontdesk suele
-- ser quien primero se entera de un cierre de playa/cambio de horario de ferry en el
-- día a día, mismo criterio que MANAGE_RESERVATIONS_ROLES de apps/api).
create policy "local_knowledge_entry_tenant_insert" on public.local_knowledge_entry for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
  );
create policy "local_knowledge_entry_tenant_update" on public.local_knowledge_entry for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]));
create policy "local_knowledge_entry_tenant_delete" on public.local_knowledge_entry for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[]));

grant select, insert, update, delete on public.local_knowledge_entry to authenticated;
