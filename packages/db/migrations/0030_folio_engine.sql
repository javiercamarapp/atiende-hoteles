-- H5 · Motor de folio (REQ-REC-004/012, REQ-BO-001/002): conceptos de cargo,
-- descuentos con umbral de autorización, reverso/transferencia SIN borrado físico,
-- split de folio y cierre con saldo cero o cuenta por cobrar autorizada. Expand-only
-- sobre 0007 (REQ-GOB-011): ninguna migración ya aplicada se edita.

-- ---------------------------------------------------------------------------
-- charge: concepto + reverso/transferencia trazables + permitir monto negativo SOLO
-- para 'descuento'/'reverso' (nunca para un cargo real, que sigue exigiendo monto>=0).
-- ---------------------------------------------------------------------------
alter table public.charge add column concept text not null default 'otro'
  check (concept in ('hospedaje', 'ab', 'extras', 'ajuste', 'propina', 'descuento', 'reverso', 'otro'));
alter table public.charge add column stay_date date;
alter table public.charge add column reverses_charge_id uuid references public.charge(id) on delete set null;
alter table public.charge add column transferred_from_charge_id uuid references public.charge(id) on delete set null;
alter table public.charge add column discount_authorized_by uuid references public.staff_user(id) on delete set null;
alter table public.charge add column night_audit_run_id uuid;

alter table public.charge drop constraint charge_amount_check;
alter table public.charge add constraint charge_amount_check
  check (amount >= 0 or concept in ('descuento', 'reverso'));
alter table public.charge drop constraint charge_tax_amount_check;
alter table public.charge add constraint charge_tax_amount_check
  check (tax_amount >= 0 or concept = 'reverso');

-- Night audit nunca postea dos veces el mismo cargo de hospedaje para la misma noche
-- del mismo folio (idempotencia real, no solo "no se llamó dos veces" — ver
-- apps/api/src/jobs/nightAudit.ts). Los reversos de un cargo de hospedaje no llevan
-- `stay_date` (se documentan con `reverses_charge_id`), así que el índice parcial no
-- los bloquea.
create unique index charge_folio_stay_date_hospedaje_idx
  on public.charge (folio_id, stay_date)
  where concept = 'hospedaje' and stay_date is not null and reverses_charge_id is null;

-- Reverso de un cargo (REQ-REC-004): UPDATE restringido a esta función SECURITY
-- DEFINER porque `charge` solo tiene GRANT de select+insert para `authenticated`
-- (0010) — igual que `record_audit_log`, la autorización real ya ocurrió en la capa
-- de aplicación (assertRole + SELECT bajo RLS) antes de llamarla.
create or replace function public.mark_charge_reversed(_charge_id uuid, _reversal_charge_id uuid)
returns public.charge
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.charge;
begin
  update public.charge
  set reversed_by = _reversal_charge_id
  where id = _charge_id and reversed_by is null
  returning * into v_row;

  if not found then
    raise exception 'reverso_invalido: el cargo % no existe o ya fue reversado', _charge_id
      using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.mark_charge_reversed(uuid, uuid) from public;
grant execute on function public.mark_charge_reversed(uuid, uuid) to atiende_app, authenticated;

-- ---------------------------------------------------------------------------
-- folio: split (varios folios por reserva, uno "principal") + cierre (saldo cero o
-- cuenta por cobrar autorizada por un rol administrativo).
-- ---------------------------------------------------------------------------
drop index public.folio_reservation_idx;
alter table public.folio add column label text not null default 'Principal';
alter table public.folio add column is_primary boolean not null default true;
alter table public.folio add column closed_at timestamptz;
alter table public.folio add column close_reason text check (close_reason in ('saldo_cero', 'cuenta_por_cobrar'));
alter table public.folio add column ar_approved_by uuid references public.staff_user(id) on delete set null;
alter table public.folio add column ar_approved_reason text;

create index folio_reservation_idx on public.folio (reservation_id);
create unique index folio_reservation_primary_idx on public.folio (reservation_id) where is_primary;

-- ---------------------------------------------------------------------------
-- payment: estado real (máquina de estados de PaymentProviderPort) + referencia
-- opaca de token -- NUNCA PAN (REQ-REC-008/H19-005).
-- ---------------------------------------------------------------------------
alter table public.payment add column status text not null default 'capturado'
  check (status in ('pendiente', 'autorizado', 'capturado', 'fallido', 'reembolsado', 'expirado'));
alter table public.payment add column token_ref text;
alter table public.payment add column preauth_expires_at timestamptz;

alter table public.payment add constraint payment_token_ref_not_pan
  check (token_ref is null or token_ref !~ '^[0-9]{12,19}$');

-- ---------------------------------------------------------------------------
-- hotel_tax_config: umbral de descuento (REQ-REC-012 estilo, autorización por rol) +
-- DSA por cuarto-noche (REQ-BO-007), parametrizados por hotel -- nunca un valor fijo
-- en código.
-- ---------------------------------------------------------------------------
alter table public.hotel_tax_config add column discount_threshold numeric(12, 2) not null default 500
  check (discount_threshold >= 0);
alter table public.hotel_tax_config add column dsa_per_night numeric(12, 2) not null default 0
  check (dsa_per_night >= 0);
alter table public.hotel_tax_config add column state_code text not null default 'ROO';
-- RFC emisor del hotel (H16-007): sin valor por defecto -- un CFDI nunca se timbra con
-- un RFC "de verdad" fabricado en código; la ruta de CFDI responde 400 explícito si
-- esta columna es NULL (mismo patrón que `loadTaxConfig`/`loadHotelMoneyConfig`).
alter table public.hotel_tax_config add column rfc_emisor text;

comment on column public.hotel_tax_config.state_code is
  'Código de estado (INEGI/uso interno) para el que aplica ish_rate/dsa_per_night -- ISH/DSA varían por estado/municipio (H16-010/011), este módulo nunca asume Quintana Roo por defecto en el cálculo, solo en el dato sembrado.';
