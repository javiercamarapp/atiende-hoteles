-- REQ-AB-010 (P2/F): "El sistema debe registrar merma de inventario F&B por causa
-- (clima, robo, caducidad, etc.) en todos los centros de consumo." H10-015 exige "el
-- 100% de los ajustes de merma quedan clasificados por causa en el registro de
-- inventario" -- por eso `centro_consumo` y `causa` son CHECK cerrados aquí, nunca
-- texto libre: ningún UPDATE/INSERT (ni siquiera uno que se salte
-- `packages/domain-hotel/src/fnbMermaGuard.ts` por un bug futuro) puede persistir un
-- valor fuera de los enums, igual que el patrón de defensa en dos capas de
-- 0084_fnb_order.sql (aplicación + estructural).
--
-- Enums replicados EXACTOS de `fnbMermaGuard.ts` (`FNB_CENTROS_CONSUMO`/
-- `FNB_MERMA_CAUSAS`, ver comentarios ahí sobre por qué "clima"/"huracan" quedan
-- separados y por qué "otro" exige nota) -- si esa lista cambia, esta migración debe
-- cambiar junto con ella en la misma revisión.
--
-- Deliberadamente SIN política de UPDATE: un registro de merma es un ajuste de
-- inventario ya consumido/perdido -- corregir una captura equivocada se hace borrando
-- el registro (rol owner/gm, ver política de DELETE) e insertando uno nuevo correcto,
-- nunca reescribiendo en sitio un ajuste que ya pudo haber entrado a un reporte
-- histórico (mismo criterio de inmutabilidad que un asiento contable).
create table public.fnb_merma (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  centro_consumo text not null check (
    centro_consumo in ('restaurante', 'pool_bar', 'room_service', 'desayuno', 'minibar', 'eventos')
  ),
  item text not null check (length(trim(item)) > 0),
  cantidad numeric(10, 3) not null check (cantidad > 0),
  unidad text not null default 'unidad' check (length(trim(unidad)) > 0),
  causa text not null check (causa in ('clima', 'huracan', 'robo', 'caducidad', 'otro')),
  -- Estructuralmente exigido: causa 'otro' sin nota no es una clasificación útil para
  -- la auditoría que pide H10-015 (mismo principio que el CHECK de
  -- `allergy_declared_via` en 0084_fnb_order.sql).
  nota text check (causa <> 'otro' or (nota is not null and length(trim(nota)) > 0)),
  registered_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);

create index fnb_merma_tenant_hotel_idx on public.fnb_merma (tenant_id, hotel_id);
create index fnb_merma_hotel_causa_idx on public.fnb_merma (hotel_id, causa);
create index fnb_merma_hotel_centro_idx on public.fnb_merma (hotel_id, centro_consumo);

alter table public.fnb_merma enable row level security;

-- Visibilidad/captura: owner/gm (control total del hotel) y 'fnb' (quien opera los
-- centros de consumo y de verdad ve la merma en el momento) -- igual que
-- `fnb_order`/`pedidosFnb.ts`, frontdesk/housekeeping/maintenance no tienen motivo
-- operativo para leer o capturar ajustes de inventario de F&B.
create policy "fnb_merma_staff_select" on public.fnb_merma for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[])
  );

create policy "fnb_merma_staff_insert" on public.fnb_merma for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'fnb']::public.hotel_role[])
  );

-- Borrar (para corregir una captura equivocada, ver comentario de arriba) queda
-- restringido a owner/gm -- 'fnb' puede capturar merma pero no borrar el rastro de
-- auditoría de lo que ya capturó.
create policy "fnb_merma_manager_delete" on public.fnb_merma for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, delete on public.fnb_merma to authenticated;
