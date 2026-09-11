-- REQ-AB-003 (P1/F): "Todo cargo de F&B posteado al folio debe soportar
-- reverso/anulación como transacción negativa auditable, con cola offline y
-- reconciliación al recuperar conectividad en zonas sin señal (playa/alberca)."
--
-- Tabla append-only: cada solicitud de reconciliación (`POST
-- /hoteles/:hotelId/fnb-offline-queue/reconciliar`, apps/api/src/routes/fnbOfflineQueue.ts)
-- inserta EXACTAMENTE una fila, aplicada o rechazada -- nunca se actualiza ni se borra
-- una fila existente (misma filosofía que `charge`: el registro de qué pasó es
-- inmutable, aunque el intento se reintente después con un nuevo Idempotency-Key).
create table public.fnb_offline_charge_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  -- El Idempotency-Key de la solicitud HTTP (ADR-004) -- también sirve como el
  -- identificador de operación del dispositivo para deduplicar reintentos offline.
  client_operation_id text not null,
  operation_type text not null check (operation_type in ('cargo', 'reverso')),
  folio_id uuid not null references public.folio(id) on delete restrict,
  -- Solo para operation_type='reverso' (el cargo original que se está anulando). SIN
  -- FK a `charge`: es lo que el DISPOSITIVO reportó, capturado tal cual incluso cuando
  -- resulta ser inexistente (esa es precisamente la razón de un 'reverso' rechazado) --
  -- una FK aquí abortaría la transacción completa de la request al insertar la fila de
  -- rechazo, justo el caso que esta cola existe para registrar de forma auditable.
  original_charge_id uuid,
  description text not null,
  amount numeric(12, 2) not null check (amount > 0),
  captured_by uuid not null,
  captured_offline_at timestamptz not null,
  device_id text not null,
  reconciled_by uuid not null,
  reconciled_status text not null check (reconciled_status in ('aplicado', 'rechazado')),
  -- El cargo/reverso real que resultó de aplicar este ítem (`null` si fue rechazado).
  result_charge_id uuid references public.charge(id) on delete set null,
  rejection_reason text,
  reconciled_at timestamptz not null default now(),
  check (
    (reconciled_status = 'aplicado' and result_charge_id is not null and rejection_reason is null)
    or (reconciled_status = 'rechazado' and result_charge_id is null and rejection_reason is not null)
  )
);
create index fnb_offline_charge_queue_hotel_idx on public.fnb_offline_charge_queue (hotel_id, captured_offline_at desc);
create index fnb_offline_charge_queue_folio_idx on public.fnb_offline_charge_queue (folio_id);
-- Deduplica reintentos del MISMO dispositivo para el MISMO ítem (nunca aplica dos
-- veces el mismo Idempotency-Key en un hotel) -- `withIdempotency` ya cubre la
-- respuesta HTTP; este índice es la garantía a nivel de dato contra dos filas del
-- mismo intento si algún día se inserta fuera de esa ruta.
create unique index fnb_offline_charge_queue_dedupe_idx on public.fnb_offline_charge_queue (tenant_id, hotel_id, client_operation_id);

alter table public.fnb_offline_charge_queue enable row level security;
-- Mismo criterio de acceso que `charge`/`payment` (0007_folio.sql): cualquier rol de
-- dinero puede ver/insertar filas de reconciliación de su hotel -- la restricción más
-- estrecha a los roles que de verdad capturan consumo en el punto de venta
-- (owner/gm/frontdesk/fnb) vive en la capa de aplicación (`OFFLINE_QUEUE_ROLES`,
-- apps/api/src/routes/fnbOfflineQueue.ts), igual que otras rutas de folio.
create policy "fnb_offline_charge_queue_money_role_select" on public.fnb_offline_charge_queue for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
create policy "fnb_offline_charge_queue_money_role_insert" on public.fnb_offline_charge_queue for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));
grant select, insert on public.fnb_offline_charge_queue to authenticated;
