-- ORIGEN: packages/db/migrations/0130_minibar_consumption.sql sha256:b5c3504993b8cdb656b8917ed1a2434b64d385d0c51c132a03280c3d51552791
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H10 · REQ-AB-005 (P2/F): "El sistema debe registrar consumo de minibar/honor bar
-- mediante foto o checklist con evidencia asociada al cargo, manteniendo la tasa de
-- disputas bajo un umbral objetivo (<3%)." Defensa en dos capas (mismo principio que
-- 0084_fnb_order.sql, "REQ-AB-004"): `packages/domain-hotel/src/minibarEvidence.ts`
-- valida en aplicación (`assertMinibarEvidencePresent`), el CHECK de abajo es la
-- barrera ESTRUCTURAL real -- ninguna fila puede persistir con evidencia ausente o a
-- medias, sin importar qué código (incluido un bug futuro que se salte la guarda de
-- aplicación) intente el INSERT.
--
-- 1 fila = 1 cargo de minibar con su evidencia (`charge_id` UNIQUE). El acceso a
-- dinero/folio sigue EXACTAMENTE la misma frontera que 0007_folio.sql
-- (`can_access_money`): housekeeping/maintenance quedan excluidos de esta tabla igual
-- que de `charge`, aunque housekeeping suela ser quien detecta el consumo al hacer el
-- servicio de la habitación -- la persona con rol de dinero (frontdesk/fnb/owner/gm)
-- es quien postea el cargo con la evidencia que housekeeping le hace llegar por otro
-- canal (mismo patrón operativo que REQ-AB-002/pedidos de F&B tomados por frontdesk;
-- ampliar el acceso de housekeeping a `charge` es una decisión de producto/seguridad
-- explícita que este requisito P2 no está autorizado a tomar por su cuenta).
--
-- Disputas (segunda mitad del criterio de aceptación): un huésped puede disputar el
-- cargo de minibar; se registra `disputed_at`/`disputed_reason`, y se resuelve con
-- `dispute_resolution` ('procede' → el cargo original se reversa con el mecanismo YA
-- existente de `mark_charge_reversed()` de 0030_folio_engine.sql -- esta tabla NO
-- reimplementa el reverso, solo referencia auditable de que hubo una disputa y cómo
-- se resolvió, insumo del reporte periódico de tasa de disputas).

create type public.minibar_evidence_type as enum ('foto', 'checklist');
create type public.minibar_dispute_resolution as enum ('procede', 'improcede');

create table public.minibar_consumption (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  charge_id uuid not null unique references public.charge(id) on delete cascade,
  room_id uuid references public.room(id) on delete set null,
  evidence_type public.minibar_evidence_type not null,
  photo_url text,
  checklist jsonb,
  registered_by uuid references public.staff_user(id) on delete set null,
  registered_at timestamptz not null default now(),
  disputed_at timestamptz,
  disputed_reason text,
  dispute_resolution public.minibar_dispute_resolution,
  dispute_resolved_by uuid references public.staff_user(id) on delete set null,
  dispute_resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Fail-closed estructural: 'foto' exige una URL no vacía y NADA de checklist;
  -- 'checklist' exige un arreglo jsonb no vacío y NADA de photo_url -- nunca ambos
  -- null, nunca los dos poblados a la vez (evidencia ambigua sobre cuál es la real).
  check (
    (evidence_type = 'foto' and photo_url is not null and length(trim(photo_url)) > 0 and checklist is null)
    or
    (evidence_type = 'checklist' and checklist is not null and jsonb_typeof(checklist) = 'array' and jsonb_array_length(checklist) > 0 and photo_url is null)
  ),
  check ((disputed_at is null) = (disputed_reason is null)),
  check (dispute_resolution is null or disputed_at is not null),
  check ((dispute_resolution is null) = (dispute_resolved_at is null)),
  check ((dispute_resolved_at is null) = (dispute_resolved_by is null))
);

create index minibar_consumption_tenant_hotel_idx on public.minibar_consumption (tenant_id, hotel_id);
create index minibar_consumption_room_idx on public.minibar_consumption (room_id) where room_id is not null;
-- Soporta el cómputo del reporte periódico de tasa de disputas (REQ-AB-005): filtrar
-- por hotel + ventana de `registered_at`.
create index minibar_consumption_hotel_registered_idx on public.minibar_consumption (hotel_id, registered_at);
create index minibar_consumption_disputed_idx on public.minibar_consumption (hotel_id) where disputed_at is not null;

alter table public.minibar_consumption enable row level security;

create policy "minibar_consumption_money_role_select" on public.minibar_consumption for select to authenticated
  using (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));

create policy "minibar_consumption_money_role_insert" on public.minibar_consumption for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and can_access_money(hotel_id));

-- UPDATE cubre EXCLUSIVAMENTE el ciclo de disputa (disputed_*/dispute_resolution*) --
-- no hay caso de negocio para editar evidence_type/photo_url/checklist ya creados
-- (igual que `charge`: la evidencia de un cargo posteado no se "corrige", se reversa y
-- se vuelve a capturar si estaba mal). La aplicación (apps/api/src/routes/minibar.ts)
-- es responsable de no tocar esas columnas en el UPDATE de disputa; la RLS aquí
-- protege la FILA (quién puede tocarla), no la columna -- mismo criterio documentado
-- explícitamente en 0041_housekeeping_task.sql.
create policy "minibar_consumption_money_role_update" on public.minibar_consumption for update to authenticated
  using (can_access_money(hotel_id))
  with check (can_access_money(hotel_id));

grant select, insert, update on public.minibar_consumption to authenticated;
