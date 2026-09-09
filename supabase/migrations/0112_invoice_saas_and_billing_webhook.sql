-- ORIGEN: packages/db/migrations/0112_invoice_saas_and_billing_webhook.sql sha256:f5c9d532fa817f7fa905915b2185fb9585e9a7c4d2e8543f5e6c39f4529cc565
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H12c · `invoice_saas`: CFDI del SaaS (Atiende factura al hotel), distinto del CFDI de
-- hospedaje que el hotel emite a SU huésped (`packages/mcp-servers/cfdi`, `cfdi_emision`
-- de la migración 0032) -- este reutiliza el MISMO `CfdiPort` (README de
-- packages/mcp-servers/billing) porque Atiende también es un emisor de CFDI 4.0 frente al
-- SAT por sus propios ingresos de plataforma.
--
-- `billing_webhook_event`: idempotencia PERSISTIDA (además del `InMemoryReplayGuard` que
-- ya trae cada adaptador de `packages/mcp-servers/billing`, que se pierde si el proceso
-- reinicia) -- mismo criterio que `idempotency_key` (0009): un webhook de
-- Stripe/Conekta reenviado (at-least-once delivery, documentado por ambos proveedores)
-- nunca debe aplicar el mismo efecto dos veces.

create table public.invoice_saas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  subscription_id uuid not null references public.subscription(id) on delete restrict,
  period_start date not null,
  period_end date not null check (period_end > period_start),
  amount_mxn_cents integer not null check (amount_mxn_cents >= 0),
  currency text not null default 'MXN',
  status text not null default 'borrador' check (status in ('borrador', 'emitida', 'pagada', 'cancelada')),
  external_invoice_id text,
  -- CFDI del SaaS -- NULL mientras no exista timbrado real (CfdiPort fake por defecto,
  -- ver README): nunca se inventa un UUID de CFDI.
  cfdi_uuid text,
  cfdi_xml_url text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index invoice_saas_org_idx on public.invoice_saas (org_id, period_start desc);

create table public.billing_webhook_event (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'conekta', 'fake')),
  external_event_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, external_event_id)
);

alter table public.invoice_saas enable row level security;
alter table public.billing_webhook_event enable row level security;

-- SELECT: transparencia total dentro del org (cualquier staff puede ver el historial de
-- facturas del SaaS de su propio negocio) -- mismo criterio que `subscription`.
create policy "invoice_saas_org_select" on public.invoice_saas for select to authenticated
  using (org_id = any (current_tenant_ids()));
-- INSERT/UPDATE: el webhook/checkout los produce la API con el cliente ADMIN (proceso de
-- infraestructura, igual que el worker de outbox) -- `authenticated` normal nunca
-- fabrica su propia factura. Sin policy de insert/update para `authenticated` (deny by
-- default).
grant select on public.invoice_saas to authenticated;

-- `billing_webhook_event` es puramente de infraestructura (idempotencia del webhook
-- público sin sesión) -- ningún rol de `authenticated` lo lee ni lo escribe; solo el
-- cliente admin (mismo criterio que `night_audit_run`, sin policy de insert/update para
-- `authenticated`, todo pasa por la función de abajo).
create or replace function public.claim_billing_webhook_event(
  _provider text, _external_event_id text, _event_type text, _payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  _claimed boolean;
begin
  insert into public.billing_webhook_event (provider, external_event_id, event_type, payload, processed_at)
  values (_provider, _external_event_id, _event_type, _payload, now())
  on conflict (provider, external_event_id) do nothing;
  _claimed := found;
  return _claimed;
end;
$$;
revoke all on function public.claim_billing_webhook_event(text, text, text, jsonb) from public;
grant execute on function public.claim_billing_webhook_event(text, text, text, jsonb) to atiende_app;
