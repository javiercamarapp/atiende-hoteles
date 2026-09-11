-- REQ-RES-015 (P2/F): "El motor de reservas debe operar en modo multi-moneda
-- (USD/MXN), gestionando activamente el efecto del tipo de cambio sobre tarifas
-- fijadas en una divisa distinta a la de reporte." El requisito no depende de ninguna
-- credencial externa ("ninguna" en REQUISITOS.md) precisamente porque NO se conecta a
-- ningún feed de tipo de cambio en vivo -- el hotel REGISTRA su propio tipo de cambio
-- vigente (misma filosofía que `hotel_tax_config`: un parámetro configurable por el
-- hotel, nunca una verdad externa fija en código ni consultada en tiempo real por un
-- LLM). `packages/domain-hotel/src/reservas/multiMoneda.ts` es el único lugar que
-- decide qué fila de esta tabla es la "vigente" para una fecha dada y hace la
-- conversión -- esta tabla solo persiste el registro.

create table public.hotel_exchange_rate (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- Divisa en la que está fijada la tarifa (ej. 'USD'); nunca igual a `to_currency` --
  -- una conversión de una moneda a sí misma no se registra ni se necesita (el motor de
  -- dominio la trata como passthrough exacto, ver `convertToReportingCurrency`).
  from_currency text not null check (from_currency = upper(from_currency) and length(from_currency) = 3),
  -- Divisa de reporte del hotel. Default 'MXN' porque el criterio de aceptación de
  -- REQ-RES-015 fija la moneda de reporte en MXN para el par piloto USD/MXN; se deja
  -- como columna (no una constante) para no tener que migrar de nuevo el día que un
  -- hotel fuera de México reporte en otra divisa.
  to_currency text not null default 'MXN' check (to_currency = upper(to_currency) and length(to_currency) = 3),
  -- Cuántas unidades de `to_currency` equivalen a 1 unidad de `from_currency`
  -- (ej. rate=18.50 => 1 USD = 18.50 MXN). numeric(18,6) para no perder precisión en
  -- pares con tipos de cambio de muchos decimales.
  rate numeric(18, 6) not null check (rate > 0),
  -- Fecha desde la que esta tasa es la vigente (inclusive) para el par de divisas,
  -- hasta que se registre una fila más reciente para el mismo par -- nunca se edita
  -- una fila ya registrada (correguir un error de captura es registrar una fila nueva
  -- con la fecha correcta, igual que `rate_plan`/H1 nunca sobreescribe una tarifa ya
  -- cobrada).
  effective_date date not null,
  created_at timestamptz not null default now(),
  check (from_currency <> to_currency),
  unique (hotel_id, from_currency, to_currency, effective_date)
);
create index hotel_exchange_rate_lookup_idx
  on public.hotel_exchange_rate (hotel_id, from_currency, to_currency, effective_date desc);

alter table public.hotel_exchange_rate enable row level security;

-- Mismo criterio de roles que `hotel_tax_config` (0013): registrar un tipo de cambio
-- es una decisión financiera que afecta directamente cuánto reporta el hotel en su
-- moneda base, restringida a owner/gm; cualquier rol con acceso a dinero puede
-- CONSULTARLO para cotizar/convertir (frontdesk/reservations/accountant también lo
-- necesitan para folios en la reserva del día a día, no solo owner/gm).
create policy "hotel_exchange_rate_tenant_select" on public.hotel_exchange_rate for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
create policy "hotel_exchange_rate_tenant_insert" on public.hotel_exchange_rate for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
-- Sin policy de UPDATE/DELETE: una tasa ya registrada no se edita ni se borra (mismo
-- principio append-only que `charge`/`payment` en 0007) -- un error de captura se
-- corrige registrando una fila nueva con la fecha correcta.

grant select, insert on public.hotel_exchange_rate to authenticated;
