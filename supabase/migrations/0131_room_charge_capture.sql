-- ORIGEN: packages/db/migrations/0131_room_charge_capture.sql sha256:1aa5739b231f6dc9b5b3d428c35e68c96c28a225125bd264329596a943f18bec
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-AB-012 (P1/NF), mitad "reporte de tasa de captura de cargos ≥99.5%" (H10-020):
-- "El sistema debe lograr una captura de cargos posteados/cheques cerrados a
-- habitación superior a un umbral objetivo (p.ej. ≥99.5%), minimizando fuga manual."
-- La otra mitad del mismo REQ (doble verificación de identidad, H10-022) ya está
-- cerrada por `assertRoomChargeIdentityVerified` (packages/domain-hotel/src/folioEngine.ts,
-- migración 0030) -- esta migración NO la toca.
--
-- Distinto de REQ-REC-014 (`packages/domain-hotel/src/fraude/deteccion.ts`,
-- `cargo_fnb_no_posteado`): ese patrón de fraude compara nuestros libros contra un
-- INSUMO EXTERNO de venta POS que hoy no existe (ADR-007, "sin_pos_configurado") --
-- depende de una integración POS real. Este REQ declara explícitamente "Dependencia
-- externa: ninguna" (docs/REQUISITOS.md), así que la tasa de captura se mide contra un
-- registro que SÍ es enteramente nuestro: el "intento" que el propio staff declara al
-- CERRAR un consumo a una habitación (comanda de F&B, vale de spa, cargo manual de
-- recepción), capturado en el momento -- antes de, y sin depender de, que exista un
-- feed POS. Un intento que nunca se vincula a un `charge` real ES la fuga manual que
-- este requisito exige minimizar; si se midiera solo contando filas de `charge`, la
-- tasa sería siempre 100% por construcción (un cargo nunca posteado jamás aparecería).
--
-- Expand-only sobre 0007/0030 (REQ-GOB-011): ninguna migración ya aplicada se edita.

-- ---------------------------------------------------------------------------
-- Umbral objetivo por hotel -- NUNCA un número fijo en el reporte (mismo principio que
-- `discount_threshold`, migración 0030): el REQ dice "p.ej. ≥99.5%", no un valor único
-- obligatorio para todos los hoteles.
-- ---------------------------------------------------------------------------
alter table public.hotel_tax_config add column charge_capture_rate_target numeric(5, 4) not null default 0.9950
  check (charge_capture_rate_target > 0 and charge_capture_rate_target <= 1);

comment on column public.hotel_tax_config.charge_capture_rate_target is
  'REQ-AB-012/H10-020: umbral objetivo de tasa de captura de cargos posteados/cheques cerrados a habitación (0.995 = 99.5% por defecto), parametrizado por hotel.';

-- ---------------------------------------------------------------------------
-- room_charge_capture_attempt: un renglón por cada "cheque cerrado a habitación" que
-- el staff declara, ANTES de saber si terminará posteado. Máquina de estados de 3
-- valores, nunca se borra ni se edita libremente (solo vía la función SECURITY
-- DEFINER de abajo, mismo patrón que `mark_charge_reversed`, migración 0030):
--   pendiente  -> recién declarado, sin resolver todavía (dentro de la operación del
--                 día; el reporte lo cuenta como NO capturado, ver comentario en
--                 packages/domain-hotel/src/chargeCaptureReport.ts sobre por qué).
--   capturado  -> se vinculó a un `charge` real ya posteado en el MISMO folio.
--   fuga       -> un rol administrativo determinó que este intento nunca se va a
--                 postear (se dio por perdido), con motivo y quién lo reconcilió --
--                 mismo criterio de "decisión con implicación de dinero requiere rol
--                 administrativo" que `evaluateFolioClose`/cuenta_por_cobrar.
-- ---------------------------------------------------------------------------
create table public.room_charge_capture_attempt (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  folio_id uuid not null references public.folio(id) on delete restrict,
  source text not null check (source in ('frontdesk_manual', 'fnb', 'spa', 'minibar', 'otro')),
  description text not null,
  amount numeric(12, 2) not null check (amount > 0),
  -- Cuándo el consumo se CERRÓ a la habitación en el mundo real (no cuándo se
  -- registra el intento en el sistema, que puede ser momentos después).
  occurred_at timestamptz not null,
  captured_by uuid not null references public.staff_user(id) on delete restrict,
  -- Solo se llena cuando reconciled_status='capturado' -- el `charge` real que
  -- corresponde a este intento.
  charge_id uuid references public.charge(id) on delete set null,
  reconciled_status text not null default 'pendiente' check (reconciled_status in ('pendiente', 'capturado', 'fuga')),
  reconciled_by uuid references public.staff_user(id) on delete set null,
  reconciled_at timestamptz,
  leak_reason text,
  created_at timestamptz not null default now(),
  check ((reconciled_status = 'capturado') = (charge_id is not null)),
  check (reconciled_status <> 'fuga' or (reconciled_by is not null and reconciled_at is not null and leak_reason is not null)),
  check (reconciled_status <> 'pendiente' or (charge_id is null and reconciled_by is null and reconciled_at is null and leak_reason is null))
);
-- Consulta principal del reporte: "todos los intentos de este hotel en [desde, hasta]".
create index room_charge_capture_attempt_hotel_period_idx on public.room_charge_capture_attempt (hotel_id, occurred_at);
create index room_charge_capture_attempt_folio_idx on public.room_charge_capture_attempt (folio_id);
create index room_charge_capture_attempt_charge_idx on public.room_charge_capture_attempt (charge_id) where charge_id is not null;

-- Resolución (pendiente -> capturado|fuga): UPDATE restringido a esta función SECURITY
-- DEFINER porque la tabla solo tiene GRANT de select+insert para `authenticated` (ver
-- abajo) -- misma razón y mismo patrón que `mark_charge_reversed` (migración 0030): la
-- autorización real (¿puede este actor declarar una fuga?) ya ocurrió en la capa de
-- aplicación antes de llamar esta función.
create or replace function public.resolve_room_charge_capture_attempt(
  _attempt_id uuid,
  _charge_id uuid,
  _leak_reason text,
  _reconciled_by uuid
)
returns public.room_charge_capture_attempt
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.room_charge_capture_attempt;
begin
  if (_charge_id is null) = (_leak_reason is null) then
    raise exception 'resolucion_invalida: debe indicarse EXACTAMENTE uno de _charge_id (capturado) o _leak_reason (fuga)'
      using errcode = 'P0001';
  end if;

  update public.room_charge_capture_attempt
  set charge_id = _charge_id,
      reconciled_status = case when _charge_id is not null then 'capturado' else 'fuga' end,
      reconciled_by = _reconciled_by,
      reconciled_at = now(),
      leak_reason = _leak_reason
  where id = _attempt_id and reconciled_status = 'pendiente'
  returning * into v_row;

  if not found then
    raise exception 'intento_no_encontrado_o_ya_resuelto: el intento % no existe o ya fue resuelto', _attempt_id
      using errcode = 'P0001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.resolve_room_charge_capture_attempt(uuid, uuid, text, uuid) from public;
grant execute on function public.resolve_room_charge_capture_attempt(uuid, uuid, text, uuid) to atiende_app, authenticated;

alter table public.room_charge_capture_attempt enable row level security;

-- Mismo criterio de acceso que `charge`/`payment` (0007_folio.sql): cualquier rol de
-- dinero del hotel puede ver/declarar un intento; la restricción más estrecha a quién
-- puede MARCAR una fuga (decisión administrativa) vive en la capa de aplicación
-- (`apps/api/src/routes/capturaCargos.ts`), igual que otras rutas de folio.
create policy "room_charge_capture_attempt_money_role_select" on public.room_charge_capture_attempt for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
create policy "room_charge_capture_attempt_money_role_insert" on public.room_charge_capture_attempt for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
-- Sin policy de UPDATE/DELETE: la resolución SOLO ocurre vía `resolve_room_charge_capture_attempt()`.

grant select, insert on public.room_charge_capture_attempt to authenticated;
