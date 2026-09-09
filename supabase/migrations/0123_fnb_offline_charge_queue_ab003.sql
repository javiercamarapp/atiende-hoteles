-- ORIGEN: packages/db/migrations/0123_fnb_offline_charge_queue_ab003.sql sha256:25484845f1309253d76b82e5d76970bdaa86428bad9592e5cc73954ada699d7b
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-AB-003 (P1/F): "Todo cargo de F&B posteado al folio debe soportar
-- reverso/anulación como transacción negativa auditable, con cola offline y
-- reconciliación al recuperar conectividad en zonas sin señal (playa/alberca)."
--
-- El reverso/anulación EN LÍNEA de cualquier cargo (incluido F&B, concept='ab') ya
-- existe genéricamente desde 0030_folio_engine.sql (`mark_charge_reversed`,
-- `POST /hoteles/:hotelId/folios/:folioId/cargos/:chargeId/reverso`). Esta migración
-- cubre la pieza que faltaba: la cola offline. Un dispositivo en playa/alberca sin
-- señal NUNCA llama a este servidor mientras está offline (por definición no hay
-- señal) -- la cola vive del lado del dispositivo; esta tabla es el REGISTRO DE
-- RECONCILIACIÓN append-only del momento en que, al recuperar conectividad, el
-- dispositivo sincroniza cada operación capturada. Por eso cada fila se inserta YA
-- resuelta (aplicado/rechazado) en la MISMA transacción que crea (o rechaza) el cargo
-- resultante -- nunca queda un estado "pendiente" server-side que alguien deba volver
-- a tocar con un UPDATE (de ahí que esta tabla NUNCA reciba UPDATE, solo INSERT/SELECT,
-- igual que `reservation_status_event`: un log de eventos, no un estado mutable).
--
-- Deduplicación real (REQ-AB-003 "reconciliación"): `client_operation_id` es un UUID
-- que el DISPOSITIVO genera al capturar la operación offline -- si la sincronización
-- se reintenta (conexión inestable, doble tap, app que reinicia a medias) el índice
-- único de abajo hace que el segundo intento choque en vez de duplicar el cargo; la
-- ruta (`apps/api/src/routes/fnbOfflineQueue.ts`) usa el mismo mecanismo de
-- `withIdempotency` que el resto de la API (ADR-004) con este id como llave.

create table public.fnb_offline_charge_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  client_operation_id text not null,
  operation_type text not null check (operation_type in ('cargo', 'reverso')),
  folio_id uuid not null references public.folio(id) on delete restrict,
  -- Requerido SOLO para 'reverso' (qué cargo original se está anulando); debe ser
  -- null para 'cargo' -- ver CHECK de abajo. SIN referencia FK a propósito: un
  -- dispositivo offline puede declarar un id que ya no existe/nunca existió (reloj
  -- desincronizado, cargo capturado por otro dispositivo y ya reversado, error de
  -- captura) -- ese caso debe poder registrarse como 'rechazado' con evidencia de qué
  -- id se reclamó, nunca reventar el INSERT del registro de auditoría por una FK.
  -- La integridad real para el camino 'aplicado' la garantiza la aplicación
  -- (`reverseCharge()` ya exige que el cargo exista antes de reversarlo).
  original_charge_id uuid,
  description text not null,
  amount numeric(12, 2) not null check (amount > 0),
  captured_by uuid not null references public.staff_user(id) on delete restrict,
  -- Cuándo el DISPOSITIVO capturó la operación mientras estaba offline -- casi
  -- siempre bastante antes de `reconciled_at` (el tiempo real sin señal en
  -- playa/alberca), nunca posterior (ver CHECK).
  captured_offline_at timestamptz not null,
  device_id text not null,
  reconciled_by uuid not null references public.staff_user(id) on delete restrict,
  reconciled_at timestamptz not null default now(),
  reconciled_status text not null check (reconciled_status in ('aplicado', 'rechazado')),
  -- El cargo/reverso REAL que resultó de aplicar este ítem (concept='ab' para
  -- 'cargo', concept='reverso' para 'reverso') -- NULL solo si `reconciled_status` es
  -- 'rechazado' (ver CHECK: un 'aplicado' sin cargo resultante sería un hueco de
  -- auditoría, dinero fantasma que el sistema dice haber posteado sin evidencia real).
  result_charge_id uuid references public.charge(id) on delete set null,
  rejection_reason text,
  created_at timestamptz not null default now(),

  check (operation_type = 'cargo' or original_charge_id is not null),
  check (operation_type = 'reverso' or original_charge_id is null),
  check (reconciled_status <> 'aplicado' or result_charge_id is not null),
  check (reconciled_status <> 'rechazado' or rejection_reason is not null),
  check (reconciled_status <> 'aplicado' or rejection_reason is null),
  -- Tolerancia de sesgo de reloj de dispositivo (mismo principio documentado en
  -- `fnbOfflineQueueGuard.ts`): lo capturado offline no puede ser, salvo un margen
  -- chico, "posterior" al momento en que se reconcilia -- si lo fuera, el timestamp de
  -- captura no es confiable como evidencia de cuándo ocurrió realmente el consumo.
  -- Exigido SOLO para 'aplicado' -- dinero real movido -- a propósito: un 'rechazado'
  -- debe poder registrar EXACTAMENTE lo que el dispositivo declaró (incluido un
  -- timestamp absurdo/en el futuro), como evidencia de auditoría de por qué se
  -- rechazó, sin que el propio registro de auditoría sea imposible de insertar.
  check (reconciled_status <> 'aplicado' or captured_offline_at <= reconciled_at + interval '5 minutes')
);

-- La deduplicación real de REQ-AB-003: un mismo `client_operation_id` del mismo
-- dispositivo/tenant/hotel jamás produce dos filas (y por lo tanto nunca dos cargos).
create unique index fnb_offline_queue_dedupe_idx
  on public.fnb_offline_charge_queue (tenant_id, hotel_id, client_operation_id);
create index fnb_offline_queue_folio_idx on public.fnb_offline_charge_queue (folio_id);
create index fnb_offline_queue_captured_idx
  on public.fnb_offline_charge_queue (hotel_id, captured_offline_at);

alter table public.fnb_offline_charge_queue enable row level security;

-- Mismo espíritu de acceso que `charge` (0007): solo roles con motivo operativo para
-- ver/capturar consumo de F&B -- dirección, quien lo toma en el punto de venta
-- (frontdesk/fnb). A diferencia de `charge`, esta tabla es un log append-only propio
-- (no hereda el `can_access_money` genérico) para no ampliar innecesariamente quién
-- puede ver el detalle de auditoría offline (reservations/accountant no necesitan
-- verlo, solo el resultado ya reflejado en el folio).
create policy "fnb_offline_queue_staff_select" on public.fnb_offline_charge_queue for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'fnb']::public.hotel_role[])
  );

create policy "fnb_offline_queue_staff_insert" on public.fnb_offline_charge_queue for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'fnb']::public.hotel_role[])
  );

-- Sin policy de UPDATE/DELETE: cada fila se inserta ya resuelta (aplicado/rechazado)
-- en la misma transacción que crea el cargo resultante -- un log de eventos, nunca un
-- estado que se edite después (mismo patrón que `reservation_status_event`).

grant select, insert on public.fnb_offline_charge_queue to authenticated;
