-- REQ-CRM-002 (P1/F): clasificación automática de reseñas/encuestas por tema y
-- sentimiento, disparando la acción correspondiente (ticket, mensaje proactivo,
-- compensación reglada). Confirmado por grep antes de esta migración: no existía
-- ninguna tabla de reseñas/encuestas en este esquema (REQ-CRM-001, el inbox real de
-- Google/Booking/TripAdvisor, sigue "pendiente-credenciales" -- esta tabla NO asume
-- esa integración: `source`/`external_id` quedan listos para cuando exista, pero hoy
-- se alimenta típicamente de una encuesta propia capturada por el staff, ADR-007).
--
-- Dos tablas:
--   `guest_review`        -- la reseña/encuesta + su clasificación (temas/sentimiento).
--   `guest_review_action` -- cada acción que la clasificación disparó. El ticket de
--                            mantenimiento SÍ se ejecuta de inmediato (no depende de
--                            ninguna integración externa, `createMaintenanceTicketTool`
--                            ya existe); mensaje proactivo y compensación reglada
--                            quedan en `status='pendiente'` para ejecución HUMANA --
--                            enviar un WhatsApp real requiere una plantilla aprobada de
--                            Meta (ADR-007, ver messagingTools.ts) y aplicar una
--                            compensación mueve dinero (GOB-026: SIEMPRE aprobación
--                            humana) -- ninguna de las dos cosas es un problema de
--                            credenciales de ESTE requisito, por eso su dependencia en
--                            REQUISITOS.md es "ninguna": la clasificación + la creación
--                            del registro de la acción correcta no necesitan nada más.
-- Expand-only sobre el esquema existente (REQ-GOB-011): ninguna migración ya aplicada
-- se edita.

create type public.guest_review_source as enum ('google', 'booking', 'tripadvisor', 'expedia', 'encuesta_propia', 'otro');
create type public.guest_review_sentiment as enum ('muy_negativo', 'negativo', 'neutral', 'positivo', 'muy_positivo');
create type public.guest_review_stay_state as enum ('en_estancia', 'post_estancia', 'desconocido');

create table public.guest_review (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- `on delete set null`: si el huésped se borra (privacidad/ARCO, REQ-REC-011) la
  -- reseña YA CLASIFICADA se conserva (evidencia de la acción disparada), pierde solo
  -- el enlace directo a la identidad -- mismo criterio que `maintenance_ticket.created_by`.
  guest_id uuid references public.guest(id) on delete set null,
  folio_id uuid references public.folio(id) on delete set null,
  source public.guest_review_source not null,
  -- Id de la reseña en la plataforma de origen (Google/Booking/...) -- NULL para una
  -- encuesta propia capturada directamente (no tiene un id externo que deduplicar).
  external_id text,
  texto text not null check (char_length(texto) between 1 and 4000),
  idioma text not null default 'es',
  calificacion smallint check (calificacion between 1 and 5),
  stay_state public.guest_review_stay_state not null default 'desconocido',
  is_public boolean not null default true,
  -- Salida de `detectarTemas()` (packages/domain-hotel): [{topic, esConocido, menciones, palabrasClave}].
  topics jsonb not null default '[]'::jsonb,
  sentiment public.guest_review_sentiment not null,
  sentiment_score numeric(5, 3) not null check (sentiment_score between -1 and 1),
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
-- Idempotencia de ingesta por plataforma: la MISMA reseña externa nunca se clasifica
-- ni se dispara dos veces para el mismo hotel (parcial: una encuesta propia sin
-- `external_id` no tiene con qué deduplicar, cada envío es una fila nueva a propósito).
create unique index guest_review_source_external_idx
  on public.guest_review (hotel_id, source, external_id)
  where external_id is not null;
create index guest_review_tenant_hotel_created_idx on public.guest_review (tenant_id, hotel_id, created_at desc);
create index guest_review_guest_idx on public.guest_review (guest_id) where guest_id is not null;

alter table public.guest_review enable row level security;

-- Quién captura/clasifica una reseña y quién puede verla: owner/gm siempre (dueños del
-- resultado del negocio), frontdesk/reservations porque son quienes hoy capturan una
-- encuesta propia en el mostrador o por WhatsApp -- mismo subconjunto de
-- MANAGE_RESERVATIONS_ROLES (apps/api/src/domain/roles.ts) que ya gestiona al huésped.
create policy "guest_review_select" on public.guest_review for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations', 'accountant']::public.hotel_role[])
  );
create policy "guest_review_insert" on public.guest_review for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
-- Sin policy de update/delete para `authenticated`: una clasificación ya hecha es
-- append-only (mismo criterio que fraud_alert/audit_log) -- re-clasificar significa
-- insertar una fila nueva, nunca editar la de antes.

grant select, insert on public.guest_review to authenticated;

create type public.guest_review_action_type as enum ('ticket_mantenimiento', 'mensaje_proactivo', 'compensacion_reglada');
create type public.guest_review_action_status as enum ('pendiente', 'ejecutada', 'descartada');

create table public.guest_review_action (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  review_id uuid not null references public.guest_review(id) on delete cascade,
  action_type public.guest_review_action_type not null,
  status public.guest_review_action_status not null default 'pendiente',
  -- Solo poblado cuando `action_type = 'ticket_mantenimiento'` (el único caso que se
  -- ejecuta de inmediato, ver comentario de archivo) -- referencia al ticket real ya
  -- creado en `maintenance_ticket` por el mismo request que clasificó la reseña.
  ticket_id uuid references public.maintenance_ticket(id) on delete set null,
  -- Para 'mensaje_proactivo': {mensajeSugerido}. Para 'compensacion_reglada':
  -- {tema, compensacion:{tipo,valor,unidad}}. Estructura de `AccionReputacion`
  -- (packages/domain-hotel/src/reputacion/clasificador.ts), guardada tal cual.
  detail jsonb not null default '{}'::jsonb,
  reason text not null,
  resolved_by uuid references public.staff_user(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index guest_review_action_review_idx on public.guest_review_action (review_id);
create index guest_review_action_tenant_hotel_status_idx
  on public.guest_review_action (tenant_id, hotel_id, status);

alter table public.guest_review_action enable row level security;

-- Mismos roles que ven la reseña de origen pueden ver y resolver (marcar
-- ejecutada/descartada) la acción pendiente -- accountant se agrega explícitamente en
-- el UPDATE porque `compensacion_reglada` es dinero, mismo criterio que
-- `NIGHT_AUDIT_ROLES`/`FRAUD_SCAN_ROLES` en sus respectivas rutas.
create policy "guest_review_action_select" on public.guest_review_action for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations', 'accountant']::public.hotel_role[])
  );
create policy "guest_review_action_insert" on public.guest_review_action for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "guest_review_action_update" on public.guest_review_action for update to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  )
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
  );

grant select, insert, update on public.guest_review_action to authenticated;
