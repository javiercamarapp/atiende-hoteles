-- ORIGEN: packages/db/migrations/0130_housekeeping_linen_opt_out.sql sha256:64dd319082d681c2d7f20333ca3bdb4806eea13b2e109be22bf6d76556389bfe
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-HK-005 (P2/F): "El sistema debe registrar el opt-out de limpieza/reposición de
-- blancos con incentivo (sin culpar al huésped en el mensaje) y contar blancos/
-- amenidades por foto contra el consumo teórico, alertando desviaciones."
-- (docs/REQUISITOS.md; criterio literal en docs/ACEPTACION.md misma fila). Dependencia
-- externa: "ninguna" -- ambas tablas son puramente internas, sin credencial de terceros.
--
-- Dos tablas nuevas:
--
-- 1) housekeeping_linen_opt_out: un huésped puede pedir NO recibir limpieza/reposición
--    de blancos un día de su estancia (práctica de sostenibilidad hotelera, casi
--    siempre a cambio de un incentivo -- puntos, descuento en F&B/spa). El esquema no
--    tiene ninguna tabla que vincule una reservación/huésped a una habitación FÍSICA
--    específica (`reservation` solo referencia `room_type_id`, ver
--    0006_reservation.sql -- asignar habitación física a una reservación es un hueco
--    de producto documentado aparte, fuera de alcance de este REQ); por eso el opt-out
--    se registra contra la HABITACIÓN (mismo ancla que usa toda la operación de
--    housekeeping hoy, `housekeeping_task.room_id`) + la fecha del día de estancia que
--    aplica, no contra un `guest_id` que el modelo de datos todavía no permite resolver
--    de forma confiable para una habitación dada.
--
--    `message_text` persiste el texto EXACTO que se mostró/envió al huésped confirmando
--    su opt-out -- es lo que el criterio de aceptación exige poder verificar
--    ("verificado por texto del mensaje"): la ruta que inserta esta fila
--    (apps/api/src/routes/housekeeping.ts) llama
--    `assertLinenOptOutMessageDoesNotBlameGuest()` (@atiende-hoteles/domain-hotel,
--    packages/domain-hotel/src/housekeeping/linenOptOut.ts) ANTES del INSERT -- fail-
--    closed, un mensaje que culpa al huésped nunca llega a persistirse.
--    `incentive_description` es obligatorio (no nullable, no vacío): el REQ exige
--    registrar el opt-out "con incentivo", no como una posibilidad opcional.
--
-- 2) housekeeping_linen_count: conteo de blancos/amenidades contra el consumo teórico
--    esperado, con evidencia de foto OBLIGATORIA (`photo_evidence_url` not null y no
--    vacío -- "verificado por foto" del REQ no es opcional, un conteo sin foto no es un
--    conteo válido para este REQ) y el resultado de la comparación (unidades/porcentaje
--    de desviación + si cruzó el umbral configurado) ya resuelto por
--    `evaluateLinenCountDeviation()` (dominio puro) al momento de insertar, para que el
--    reporte de desviaciones (GET) no tenga que recalcular nada. `threshold_pct`
--    persiste el umbral vigente AL MOMENTO del conteo (auditoría honesta: si el umbral
--    configurado del hotel cambia después, los conteos históricos conservan el criterio
--    con el que de verdad se evaluaron, en vez de que un cambio futuro reescriba en
--    silencio el significado de una alerta pasada).

create type public.housekeeping_linen_item_type as enum ('blancos', 'amenidades');

create table public.housekeeping_linen_opt_out (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid not null references public.room(id) on delete cascade,
  stay_date date not null,
  incentive_description text not null check (char_length(trim(incentive_description)) > 0),
  message_text text not null check (char_length(trim(message_text)) > 0),
  registered_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (hotel_id, room_id, stay_date)
);
create index housekeeping_linen_opt_out_tenant_hotel_idx
  on public.housekeeping_linen_opt_out (tenant_id, hotel_id);
create index housekeeping_linen_opt_out_room_idx
  on public.housekeeping_linen_opt_out (room_id, stay_date);

create table public.housekeeping_linen_count (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid not null references public.room(id) on delete cascade,
  task_id uuid references public.housekeeping_task(id) on delete set null,
  item_type public.housekeeping_linen_item_type not null,
  counted_quantity integer not null check (counted_quantity >= 0),
  theoretical_quantity integer not null check (theoretical_quantity >= 0),
  deviation_units integer not null,
  deviation_pct numeric(7, 2) not null check (deviation_pct >= 0),
  threshold_pct numeric(7, 2) not null check (threshold_pct >= 0),
  alert_triggered boolean not null,
  photo_evidence_url text not null check (char_length(trim(photo_evidence_url)) > 0),
  counted_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index housekeeping_linen_count_tenant_hotel_idx
  on public.housekeeping_linen_count (tenant_id, hotel_id);
create index housekeeping_linen_count_room_idx
  on public.housekeeping_linen_count (room_id, created_at);
create index housekeeping_linen_count_alert_idx
  on public.housekeeping_linen_count (hotel_id, alert_triggered)
  where alert_triggered;

alter table public.housekeeping_linen_opt_out enable row level security;
alter table public.housekeeping_linen_count enable row level security;

-- RLS: mismo criterio que `housekeeping_task` (0041) -- protege la FILA (tenant/hotel
-- reales del membership), no la columna; qué acción puede hacer cada rol vive en
-- apps/api (`assertRole`). Se autoriza a los 4 roles operativos de piso
-- (owner/gm/frontdesk/housekeeping), los mismos que hoy administran `room`/
-- `housekeeping_task` -- ningún rol nuevo, ninguna restricción de visibilidad por
-- "asignado a mí" (a diferencia de `housekeeping_task`): tanto el opt-out como el
-- conteo son información operativa del HOTEL completo (reporte de desviaciones para
-- gerencia), no de una tarea individual de una camarista.
create policy "housekeeping_linen_opt_out_scope_select" on public.housekeeping_linen_opt_out for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and hotel_id = any (current_hotel_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'housekeeping']::public.hotel_role[])
  );
create policy "housekeeping_linen_opt_out_scope_insert" on public.housekeeping_linen_opt_out for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'housekeeping']::public.hotel_role[])
  );
create policy "housekeeping_linen_opt_out_manager_update" on public.housekeeping_linen_opt_out for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "housekeeping_linen_opt_out_manager_delete" on public.housekeeping_linen_opt_out for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

create policy "housekeeping_linen_count_scope_select" on public.housekeeping_linen_count for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and hotel_id = any (current_hotel_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'housekeeping']::public.hotel_role[])
  );
create policy "housekeeping_linen_count_scope_insert" on public.housekeeping_linen_count for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'housekeeping']::public.hotel_role[])
  );
create policy "housekeeping_linen_count_manager_update" on public.housekeeping_linen_count for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "housekeeping_linen_count_manager_delete" on public.housekeeping_linen_count for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.housekeeping_linen_opt_out to authenticated;
grant select, insert, update, delete on public.housekeeping_linen_count to authenticated;
