-- H? · REQ-AB-004 (P0/GOB): pedido de F&B con alergia/restricción alimentaria
-- declarada -- la orden SIEMPRE requiere confirmación humana de un cocinero (rol
-- 'fnb') antes de que cualquier capa del sistema pueda asegurar al huésped que el
-- platillo es seguro. Superficie MÍNIMA para esta regla: NO implementa el enrutamiento
-- a KDS/cocina, SLA de entrega, ni cargo a folio del REQ-AB-002 (ver
-- docs/TRAZABILIDAD.md -- ese requisito sigue pendiente-credenciales de PMS/POS y no
-- se duplica aquí).
--
-- Defensa en dos capas (mismo principio que 0062/0063/0065, "valida actor"):
-- `packages/domain-hotel/src/fnbAllergyGuard.ts` es la primera barrera (aplicación),
-- pero el último CHECK de abajo es la barrera ESTRUCTURAL real -- ninguna fila puede
-- persistir en un estado donde `safety_assurance_sent_at` esté lleno para un pedido
-- con alergia declarada sin que `kitchen_confirmed_at` también lo esté, sin importar
-- qué código (incluido un bug futuro que se salte la guarda de aplicación) intente el
-- UPDATE.

create table public.fnb_order (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid references public.room(id) on delete set null,
  items jsonb not null default '[]'::jsonb,
  notes text,
  allergy_declared boolean not null default false,
  -- 'estructurado' = el huésped/staff marcó el campo explícito; 'texto_libre' = la
  -- red de seguridad de `resolveAllergyDeclared()` lo detectó en una nota libre.
  allergy_declared_via text check (allergy_declared_via in ('estructurado', 'texto_libre')),
  kitchen_confirmed_by uuid references public.staff_user(id) on delete set null,
  kitchen_confirmed_at timestamptz,
  kitchen_confirmation_note text,
  -- Auditoría de la ÚNICA acción que "asegura" al huésped que el platillo es seguro
  -- (`POST .../asegurar-seguridad`) -- si esta columna nunca se llena para un pedido,
  -- es evidencia estructural de que el sistema nunca emitió esa afirmación.
  safety_assurance_sent_by uuid references public.staff_user(id) on delete set null,
  safety_assurance_sent_at timestamptz,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (allergy_declared = (allergy_declared_via is not null)),
  check ((kitchen_confirmed_by is null) = (kitchen_confirmed_at is null)),
  check (
    safety_assurance_sent_at is null
    or not allergy_declared
    or kitchen_confirmed_at is not null
  )
);
create index fnb_order_tenant_hotel_idx on public.fnb_order (tenant_id, hotel_id);
create index fnb_order_room_idx on public.fnb_order (room_id) where room_id is not null;
create index fnb_order_allergy_pendiente_idx on public.fnb_order (hotel_id, allergy_declared)
  where allergy_declared and kitchen_confirmed_at is null;

alter table public.fnb_order enable row level security;

-- Visibilidad: solo los roles con motivo operativo para ver pedidos de F&B (dirección,
-- recepción que los toma, y el propio F&B/cocina) -- housekeeping/mantenimiento/
-- reservaciones/contabilidad no tienen necesidad de leer esta tabla.
create policy "fnb_order_staff_select" on public.fnb_order for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'fnb']::public.hotel_role[])
  );

create policy "fnb_order_staff_insert" on public.fnb_order for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'fnb']::public.hotel_role[])
  );

-- UPDATE cubre TANTO "confirmar-cocina" (kitchen_confirmed_*) COMO "asegurar-seguridad"
-- (safety_assurance_sent_*) -- deliberadamente restringido a quien puede saber de
-- verdad si la cocina revisó el platillo (owner/gm de respaldo, o 'fnb' mismo). NUNCA
-- frontdesk: puede tomar el pedido (insert), pero no confirmar ni afirmar seguridad en
-- nombre de la cocina -- ampliar esto a más roles es una decisión de producto explícita
-- para cuando exista el canal de mensajería real hacia el huésped (REQ-AB-002).
create policy "fnb_order_kitchen_update" on public.fnb_order for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[]));

create policy "fnb_order_manager_delete" on public.fnb_order for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.fnb_order to authenticated;
