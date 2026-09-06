-- H1 · outbox (ADR-004: toda escritura hacia un conector externo pasa por aqui, drenada
-- por un worker con backoff) e idempotency_key (ADR-004: UNIQUE (tenant_id, scope, key) +
-- INSERT ... ON CONFLICT). Ambas son tablas operativas del backend; RLS las acota por
-- tenant y las restringe a roles de gestion (owner/gm) para lectura/escritura directa vía
-- el rol `authenticated` (el flujo normal de outbox/idempotencia lo maneja el propio
-- backend con sus propias funciones de aplicacion, no un usuario final).

create type public.outbox_status as enum ('pendiente', 'enviado', 'fallido');

create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid references public.hotel(id) on delete set null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.outbox_status not null default 'pendiente',
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbox_tenant_status_available_idx on public.outbox (tenant_id, status, available_at);
create index outbox_aggregate_idx on public.outbox (aggregate_type, aggregate_id);

create table public.idempotency_key (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  scope text not null,
  key text not null,
  resource_id uuid,
  response jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, scope, key)
);
create index idempotency_key_tenant_scope_idx on public.idempotency_key (tenant_id, scope);

alter table public.outbox enable row level security;
alter table public.idempotency_key enable row level security;

create policy "outbox_tenant_manager_select" on public.outbox for select to authenticated
  using (tenant_id = any (current_tenant_ids()));
create policy "outbox_tenant_manager_insert" on public.outbox for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()));
create policy "outbox_tenant_manager_update" on public.outbox for update to authenticated
  using (tenant_id = any (current_tenant_ids()))
  with check (tenant_id = any (current_tenant_ids()));

create policy "idempotency_key_tenant_select" on public.idempotency_key for select to authenticated
  using (tenant_id = any (current_tenant_ids()));
create policy "idempotency_key_tenant_insert" on public.idempotency_key for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()));
