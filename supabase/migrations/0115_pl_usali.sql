-- ORIGEN: packages/db/migrations/0115_pl_usali.sql sha256:93b1e879395c505f936fb534d253894444c299ea8d9864ac61eb9a193cd1e255
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-BO-010 (P0/BP-024/BP-041/BP-071/H16-016/H16-017/H07-032/H17-002/H04-023): P&L
-- diario/mensual en formato-resumen USALI 12ª edición por departamento, punto de
-- equilibrio dinámico (recalculado con costos/ADR reales), owner's report y
-- proyección de caja a 13 semanas.
--
-- Alcance real de "formato USALI 12ª edición" en este esquema: el Summary Operating
-- Statement (jerarquía Ingresos por departamento -> Utilidad departamental -> Gastos
-- no distribuidos -> GOP -> cuota de administración -> EBITDA -> gastos no operativos
-- -> Utilidad neta), NO los 11 Schedules departamentales completos del manual USALI
-- (eso exigiría un catálogo contable completo fuera de alcance de este sistema hoy).
-- Documentado explícitamente para no sobre-prometer, mismo criterio que
-- `packages/domain-hotel/src/mrz.ts`/0051 documentan sus propios límites.
--
-- Los INGRESOS por departamento YA existen en el esquema (`charge.concept`, 0030):
-- 'hospedaje' -> Rooms, 'ab' -> Food & Beverage, 'extras'/'otro' -> Otros
-- Departamentos Operados, 'ajuste'/'descuento' se atribuyen a Rooms (limitación
-- conocida: la API de folios no registra a qué departamento aplica un descuento/ajuste
-- genérico, ver apps/api/src/domain/plUsali.ts), 'reverso' se resuelve al departamento
-- del cargo original vía `reverses_charge_id`, y 'propina' se EXCLUYE por completo (no
-- es contraprestación del hotel, mismo criterio que `folioEngine.ts` ya aplica para
-- impuestos). Esta migración solo agrega lo que NO existe todavía: el lado de GASTOS
-- reales por departamento -- sin esto, cualquier P&L sería ingresos reales contra
-- costos inventados ("P&L de mentiras"), que es exactamente lo que
-- docs/cierre-p0/inventario.md documentó como la razón de NO implementar antes.
--
-- Expand-only (REQ-GOB-011): ninguna migración ya aplicada se edita.

create type public.usali_department as enum (
  -- Departamentos operados (tienen ingreso propio via charge.concept).
  'rooms',
  'food_beverage',
  'otros_departamentos',
  -- Gastos no distribuidos (Undistributed Operating Expenses, sin ingreso propio).
  'admin_general',
  'ventas_marketing',
  'operacion_mantenimiento',
  'utilities',
  -- Debajo de GOP.
  'cuota_administracion',
  'no_operativo'
);

create type public.usali_expense_category as enum ('costo_ventas', 'nomina', 'otros_gastos');

create table public.expense_entry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  department public.usali_department not null,
  category public.usali_expense_category not null,
  description text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  expense_date date not null,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index expense_entry_hotel_date_idx on public.expense_entry (hotel_id, expense_date);
create index expense_entry_hotel_department_date_idx on public.expense_entry (hotel_id, department, expense_date);

alter table public.expense_entry enable row level security;

-- Ver/registrar el lado de gastos del P&L es más sensible que un cargo de folio
-- (revela costos/nómina/márgenes del negocio, no solo un cobro al huésped) -- por eso
-- NO reutiliza `can_access_money()` (0007, que incluye frontdesk/reservations/fnb),
-- sino un rol propio, mismo criterio de "destinatario correspondiente" que
-- `fraud_alert` (0095) ya aplicó para datos financieros sensibles.
create or replace function public.can_access_pl(_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select has_hotel_role(_hotel_id, array['owner', 'gm', 'accountant']::public.hotel_role[])
$$;

revoke all on function public.can_access_pl(uuid) from public;
grant execute on function public.can_access_pl(uuid) to atiende_app, authenticated;

create policy "expense_entry_pl_role_select" on public.expense_entry for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_pl(hotel_id));
create policy "expense_entry_pl_role_insert" on public.expense_entry for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and can_access_pl(hotel_id));

-- 0010_grants_and_lockdown.sql revocó TODO privilegio de tabla por default sobre el
-- esquema `public` -- una tabla nueva creada después de esa migración no hereda ningún
-- grant, y la RLS de arriba sola no basta (RLS filtra FILAS, Postgres exige además el
-- privilegio base sobre la TABLA). Mismo patrón que `fraud_alert` (0095) ya aplicó.
grant select, insert on public.expense_entry to authenticated;
-- Sin policy de update/delete: un gasto registrado no se edita ni se borra -- se
-- corrige con una contrapartida nueva (misma disciplina append-only que `charge`,
-- REQ-REC-004), evitando que el P&L de un periodo ya cerrado cambie por debajo del
-- reporte ya emitido al owner.
