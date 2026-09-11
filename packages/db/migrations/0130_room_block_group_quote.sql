-- REQ-RES-012 (P1/F, fuentes BP-089/H01-008/H02-013/H02-015/H02-016/H05-011/H05-012/
-- H05-013): "cotización, contrato, bloqueo de habitaciones (room block) y seguimiento
-- de cut-off para grupos/bodas/eventos". Una sola tabla cubre el ciclo de vida real
-- (cotizado -> confirmado -> liberado/cancelado) porque es la MISMA solicitud de grupo
-- de principio a fin -- nunca dos filas distintas que puedan divergir sobre cuántas
-- habitaciones se pidieron originalmente.
--
-- El CÁLCULO (desplazamiento de ADR, SLA de 15 min, alerta de cut-off) vive en
-- `@atiende-hoteles/domain-hotel` (`reservas/groupQuote.ts` + `reservas/roomBlock.ts`,
-- puros, sin I/O) -- esta migración solo agrega el estado real. `nightly_displacement`
-- se congela en jsonb en el momento de la cotización (mismo criterio que
-- `hotel_waitlist_entry.offer_amount`, migración 0119): es la evidencia de QUÉ
-- consultó el motor de Revenue para fijar este precio, nunca recalculada después.
--
-- Alcance deliberado de este cierre (para no fingir más de lo construido): el
-- CONTRATO en PDF (H02-016) y el seguimiento automático de RFPs sin respuesta
-- (REQ-RES-013, ya su propia fila/job) quedan fuera -- esta tabla persiste la
-- cotización y el bloqueo/liberación REAL de inventario, que es lo que
-- `tests/integration/grupos/cotizacion.spec.ts` (criterio literal de
-- docs/ACEPTACION.md) y el seguimiento de cut-off (H05-013) necesitan.
create table public.room_block (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_type_id uuid not null references public.room_type(id) on delete restrict,
  created_by uuid references public.staff_user(id) on delete set null,

  organizer_name text not null check (length(trim(organizer_name)) > 0),
  organizer_email text not null check (length(trim(organizer_email)) > 0),
  event_type text not null check (event_type in ('boda', 'evento_corporativo', 'retiro', 'otro')),

  check_in_date date not null,
  check_out_date date not null,
  rooms_requested integer not null check (rooms_requested > 0),
  currency text not null default 'MXN',

  -- H02-013/H05-011: momentos reales de la solicitud y de la cotización (nunca
  -- inferidos) -- ver GROUP_QUOTE_SLA_MINUTES en domain-hotel/src/reservas/groupQuote.ts.
  requested_at timestamptz not null,
  quoted_at timestamptz not null,
  sla_minutes integer not null,
  within_sla boolean not null,

  -- H02-015: precio manual propuesto por ventas ANTES del ajuste de desplazamiento,
  -- el costo de desplazamiento consultado al motor de Revenue, y el precio final que
  -- SIEMPRE internaliza ese costo (`group_price = manual_price + displacement_cost`,
  -- ver computeGroupQuote) -- por eso NO hay constraint de igualdad entre ambos: son
  -- iguales únicamente cuando displacement_cost = 0, y eso lo decide el cálculo, no un
  -- valor que la fila pueda fijar por su cuenta.
  manual_price numeric(12, 2) not null check (manual_price >= 0),
  displacement_cost numeric(12, 2) not null default 0 check (displacement_cost >= 0),
  group_price numeric(12, 2) not null check (group_price >= 0),
  nightly_displacement jsonb not null,

  -- H02-016/H05-013: ciclo de vida del bloqueo real de inventario. 'cotizado' no ha
  -- tocado `availability` todavía (solo existe el número, ver routes/grupos.ts); al
  -- pasar a 'confirmado' se invoca `book_availability` por cada noche (bloqueo real);
  -- 'liberado'/'cancelado' invocan `release_availability` por lo que quedó SIN
  -- recoger (`rooms_requested - rooms_picked_up`, ver roomsToRelease en
  -- domain-hotel/src/reservas/roomBlock.ts) -- nunca se libera más de lo bloqueado.
  status text not null default 'cotizado' check (status in ('cotizado', 'confirmado', 'liberado', 'cancelado')),
  cutoff_date date,
  rooms_picked_up integer not null default 0 check (rooms_picked_up >= 0),
  confirmed_at timestamptz,
  released_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (check_out_date > check_in_date),
  check (rooms_picked_up <= rooms_requested),
  -- Equivalencia real, pero en el sentido correcto: `confirmed_at` es evidencia
  -- histórica de CUÁNDO se confirmó, y debe SOBREVIVIR a una liberación/cancelación
  -- posterior (mismo criterio que `hotel_waitlist_entry.offered_at`, migración 0119:
  -- limpiar evidencia al avanzar de estado no gana nada) -- por eso la equivalencia es
  -- "cotizado <=> confirmed_at es null" (nunca "confirmado <=> confirmed_at no es
  -- null"), que sí cubre los 4 estados: solo 'cotizado' puede tener confirmed_at nulo,
  -- los otros 3 ('confirmado'/'liberado'/'cancelado') exigen haber pasado por
  -- 'confirmado' antes.
  check ((status = 'cotizado') = (confirmed_at is null)),
  check ((status in ('liberado', 'cancelado')) = (released_at is not null)),
  -- 'confirmado' es un requisito previo real de 'liberado'/'cancelado' (no se puede
  -- liberar inventario que nunca se bloqueó) -- SQL no expresa "estado anterior" sin
  -- una máquina de estados completa (fuera de alcance de este cierre); en su lugar la
  -- API (routes/grupos.ts) es la única vía de escritura de `status` y exige el orden.
  check (cutoff_date is null or cutoff_date >= check_in_date - interval '1 year')
);

create index room_block_hotel_room_type_dates_idx on public.room_block (hotel_id, room_type_id, check_in_date, check_out_date);
create index room_block_tenant_hotel_idx on public.room_block (tenant_id, hotel_id);
create index room_block_status_cutoff_idx on public.room_block (hotel_id, status, cutoff_date) where status = 'confirmado';

alter table public.room_block enable row level security;

-- Mismos roles que ya gestionan reservaciones (MANAGE_RESERVATIONS_ROLES,
-- apps/api/src/domain/roles.ts): cotizar/bloquear un grupo es una operación de
-- reservaciones, no de housekeeping/F&B/contabilidad.
create policy "room_block_tenant_select" on public.room_block for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and hotel_id = any (current_hotel_ids()));
create policy "room_block_tenant_insert" on public.room_block for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "room_block_tenant_update" on public.room_block for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));

grant select, insert, update on public.room_block to authenticated;
