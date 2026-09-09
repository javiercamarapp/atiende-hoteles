-- REQ-HUE-007: "El sistema debe auditar semanalmente una muestra de
-- conversaciones/llamadas (p. ej. 30) para detectar errores del bot
-- (disponibilidad/precio erróneo, políticas inventadas, identidad no verificada,
-- idioma incorrecto, alucinaciones)." (H03-024). Dependencia externa declarada en
-- docs/REQUISITOS.md: "ninguna" -- el universo auditado es `conversation`/`message`
-- (0044_conversation_message.sql), que ya existe hoy sobre el canal WhatsApp simulado
-- (FakeWhatsappAdapter, ADR-007); no depende de telefonía real.
--
-- `conversation_audit_sample` registra, por hotel y semana ISO, qué conversaciones
-- entraron a la muestra semanal (seleccionadas determinísticamente por
-- `selectWeeklyAuditSample`, packages/domain-hotel/src/qa/conversationAudit.ts) y el
-- veredicto de quien la revisó. Es un registro NUEVO y separado de `guest_ticket`
-- (0098, REQ-HUE-014) a propósito: un ticket es una petición del huésped que alguien
-- debe resolver; una fila de auditoría es una revisión retrospectiva de calidad del
-- bot sobre una conversación ya cerrada o en curso -- dos conceptos distintos, aunque
-- ambos puedan citar la misma `conversation_id`.
create type public.conversation_audit_category as enum (
  'ninguno',
  'disponibilidad_o_precio_incorrecto',
  'politica_inventada',
  'identidad_no_verificada',
  'idioma_incorrecto',
  'alucinacion'
);

create table public.conversation_audit_sample (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  conversation_id uuid not null references public.conversation(id) on delete cascade,
  -- Lunes (UTC) de la semana ISO auditada -- identificador estable de "qué semana",
  -- calculado por `resolveIsoWeekStart` en la capa de aplicación, nunca en SQL, para
  -- que la definición de "semana" viva en un solo lugar (el mismo módulo puro que
  -- selecciona la muestra).
  week_of date not null,
  sampled_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.staff_user(id) on delete set null,
  category public.conversation_audit_category,
  notes text,
  created_at timestamptz not null default now(),
  -- Coherencia revisado/no revisado: una fila sin revisar no tiene categoría ni
  -- reviewed_at; una revisada exige ambos (mismo criterio de coherencia por CHECK que
  -- `guest_ticket_closed_at_coherente`, 0098).
  constraint conversation_audit_sample_reviewed_coherente check (
    (reviewed_at is null and category is null and reviewed_by is null)
    or (reviewed_at is not null and category is not null and reviewed_by is not null)
  )
);

-- Una conversación entra a la muestra de una semana dada UNA sola vez -- re-generar la
-- muestra de una semana ya generada no debe duplicar filas (idempotencia, ver
-- apps/api/src/routes/auditoriaConversaciones.ts).
create unique index conversation_audit_sample_hotel_week_conversation_idx
  on public.conversation_audit_sample (hotel_id, week_of, conversation_id);
create index conversation_audit_sample_tenant_hotel_idx
  on public.conversation_audit_sample (tenant_id, hotel_id, week_of);
-- Cola de pendientes por revisar (parcial, mismo criterio que
-- `guest_ticket_open_sla_idx`, 0098): solo indexa lo que el panel de auditoría
-- necesita escanear seguido.
create index conversation_audit_sample_pending_idx
  on public.conversation_audit_sample (hotel_id, week_of)
  where reviewed_at is null;

alter table public.conversation_audit_sample enable row level security;

-- La auditoría de calidad del bot es una función gerencial (revisa si el agente
-- conversacional está mintiendo/alucinando/cotizando mal) -- a diferencia de
-- `guest_ticket` (cualquier departamento atiende lo suyo), aquí solo owner/gm generan
-- la muestra y registran el veredicto. Ningún otro rol necesita ver ni escribir esta
-- tabla.
create policy "conversation_audit_sample_manager_select" on public.conversation_audit_sample for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "conversation_audit_sample_manager_insert" on public.conversation_audit_sample for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "conversation_audit_sample_manager_update" on public.conversation_audit_sample for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.conversation_audit_sample to authenticated;
