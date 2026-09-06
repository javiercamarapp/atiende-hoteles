-- H12c · LAUNCH-015 (docs/referencia/08-inventario-punta-a-punta.md): facturación SaaS
-- del hotel (cobro de Atiende AL hotel, distinto de `packages/mcp-servers/payments`, que
-- cobra al huésped). `plan` es catálogo de producto (Starter/Pro/Enterprise); `subscription`
-- es UNA por organización (`org`, no por hotel individual): un grupo con 2 hoteles bajo el
-- mismo `org_id` (ver packages/db/src/seed.ts) comparte un solo plan/suscripción, igual que
-- Likida (`likida/src/lib/saas/suscripcion.ts`) factura por cuenta, no por sucursal.
--
-- Precios (`price_mxn_cents`): docs/BLOQUEOS.md D-006 — son una PROPUESTA basada en H18
-- (benchmarks Cloudbeds/Mews/Canary/HiJiffy) y el techo de costo de LLM-026
-- (~USD 27-158/hotel/mes según Opción A/B/C), NUNCA una decisión de precio de lista: fijar
-- precio de lista es una decisión reservada al fundador (REQ-GOB-012). `es_propuesta = true`
-- en las 3 filas sembradas aquí; solo el fundador puede poner una fila en `es_propuesta =
-- false` (no hay ningún código en este hito que lo haga automáticamente).

create type public.subscription_status as enum ('trial', 'activa', 'vencida', 'cancelada');

create table public.plan (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  -- NULL = "contactar ventas" (Enterprise, sin precio de lista público, H18 benchmark de
  -- competidores enterprise-only como Mews/Oracle OHIP).
  price_mxn_cents integer check (price_mxn_cents is null or price_mxn_cents >= 0),
  currency text not null default 'MXN',
  billing_cycle text not null default 'mensual' check (billing_cycle in ('mensual', 'anual')),
  -- Límites de plan. NULL = ilimitado (solo Enterprise). Nunca se aplican "en silencio":
  -- ver public.check_entitlement() (0111) y apps/api/src/lib/entitlement.ts -- superarlos
  -- siempre produce un error explícito, jamás un bloqueo sin explicación.
  max_hoteles integer check (max_hoteles is null or max_hoteles > 0),
  max_habitaciones integer check (max_habitaciones is null or max_habitaciones > 0),
  max_agentes_activos integer check (max_agentes_activos is null or max_agentes_activos > 0),
  max_mensajes_mes integer check (max_mensajes_mes is null or max_mensajes_mes > 0),
  -- true en TODA fila sembrada por este repo (REQ-GOB-012): el precio de lista real lo
  -- fija el fundador, nunca un valor por defecto de construcción. Ver README de
  -- packages/mcp-servers/billing.
  es_propuesta boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.plan
  (code, name, price_mxn_cents, max_hoteles, max_habitaciones, max_agentes_activos, max_mensajes_mes, es_propuesta)
values
  -- Propuesta H18 (banda baja de Cloudbeds/Duve/Asksuite para 1 propiedad boutique
  -- ≤20 habitaciones) — PENDIENTE DE APROBACIÓN DEL FUNDADOR.
  ('starter', 'Starter', 249900, 1, 20, 3, 2000, true),
  -- Propuesta H18 (banda media, hotel boutique ancla tipo Petit Lafitte 40-60 hab) —
  -- PENDIENTE DE APROBACIÓN DEL FUNDADOR.
  ('pro', 'Pro', 649900, 3, 80, 10, 10000, true),
  -- Enterprise: sin precio de lista público (cotización directa), sin techos de uso —
  -- PENDIENTE DE APROBACIÓN DEL FUNDADOR (incluida la existencia misma del tier).
  ('enterprise', 'Enterprise', null, null, null, null, null, true);

-- Una suscripción por organización (tenant) -- REQ-TEN-001: la org, no el hotel
-- individual, es la unidad de facturación del SaaS (mismo criterio que `outbox`/
-- `idempotency_key`, que también son por `tenant_id`).
create table public.subscription (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.org(id) on delete restrict,
  plan_id uuid not null references public.plan(id) on delete restrict,
  status public.subscription_status not null default 'trial',
  -- 14 días de trial (H18 "onboarding funcional <1 semana" + margen de evaluación) --
  -- PROPUESTA, no un plazo legal fijado por ninguna fuente; documentado en README.
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default (now() + interval '14 days'),
  currency text not null default 'MXN',
  -- 'fake' hasta que exista una cuenta real de Stripe/Conekta (BillingPort, ver
  -- packages/mcp-servers/billing) -- nunca un valor que insinúe una integración real sin
  -- credenciales verificadas.
  billing_provider text not null default 'fake' check (billing_provider in ('fake', 'stripe', 'conekta')),
  external_customer_id text,
  external_subscription_id text,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscription_status_idx on public.subscription (status);

-- Helper de autoridad a nivel de ORG (no de hotel individual): "es owner/gm de AL MENOS
-- un hotel de este org" -- mismo criterio que idempotency_key_money_role_* (0017) para
-- una tabla que vive a nivel org y no tiene columna hotel_id.
create or replace function public.is_org_admin(_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.hotel_staff
    where user_id = auth.uid()
      and org_id = _org_id
      and role = any (array['owner', 'gm']::public.hotel_role[])
  )
$$;
revoke all on function public.is_org_admin(uuid) from public;
grant execute on function public.is_org_admin(uuid) to atiende_app, authenticated;

alter table public.plan enable row level security;
alter table public.subscription enable row level security;

-- `plan` es catálogo público de producto (precios propuestos, visible a cualquier
-- staff autenticado para poder mostrar "mejora tu plan" en /suscripcion) -- nunca datos
-- de otro tenant, no hay tenant_id en esta tabla.
create policy "plan_authenticated_select" on public.plan for select to authenticated using (true);
grant select on public.plan to authenticated;

-- SELECT: cualquier miembro del staff del org ve el estado de su propia suscripción
-- (transparencia, igual que agent_approval) -- NUNCA la de otro org (aislamiento
-- verificado en tests/adversarial/facturacion-saas.spec.ts).
create policy "subscription_org_select" on public.subscription for select to authenticated
  using (org_id = any (current_tenant_ids()));
-- INSERT/UPDATE (upgrade, cancelar, portal): reservado a owner/gm -- mismo nivel que
-- decidir gasto de dinero del hotel.
create policy "subscription_org_admin_insert" on public.subscription for insert to authenticated
  with check (is_org_admin(org_id));
create policy "subscription_org_admin_update" on public.subscription for update to authenticated
  using (is_org_admin(org_id))
  with check (is_org_admin(org_id));

grant select, insert, update on public.subscription to authenticated;
