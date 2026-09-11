-- ORIGEN: packages/db/migrations/0130_housekeeping_daily_report.sql sha256:f273a860b7b0658505b49d7d1d63ffa1dbc75496a19a1eb801894350084a3e1c
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-HK-010: "El sistema debe generar un reporte diario al gerente con minutos reales
-- vs. estándar por camarista, habitaciones listas a una hora objetivo, re-limpiezas,
-- incidencias y tickets generados." Tres piezas nuevas, expand-only sobre el esquema
-- existente (REQ-GOB-011):
--
--  1) `room_type.standard_clean_minutes`: el estándar contra el que se mide cada
--     tarea de housekeeping NO existía en ningún lado del esquema (verificado: 0 columnas
--     "estandar"/"standard" antes de esta migración) -- se ancla a `room_type`, no a un
--     número global de hotel, porque una suite y una habitación estándar no toman lo
--     mismo en limpiar. Default 30 (documentado como estimación razonable de industria,
--     NO un dato del cliente real -- cada hotel debe ajustarlo por tipo de habitación
--     antes de que el reporte le sirva para evaluar desempeño real).
--
--  2) `hotel_housekeeping_config`: la "hora objetivo" de habitación lista es una
--     decisión operativa POR HOTEL (mismo criterio que `hotel_pms_outbound_config`/
--     `hotel_voice_agent_config`: configuración con alcance de hotel, nunca un valor
--     hardcodeado en el código). Default 15:00 (3pm, el check-in estándar de la
--     industria hotelera mexicana) -- un valor de partida razonable, nunca impuesto: el
--     gerente lo cambia desde el panel antes de que el reporte lo use para calcular
--     "listas a tiempo".
--
--  3) `housekeeping_daily_report`: snapshot PERSISTIDO del reporte ya calculado para un
--     (hotel, día) -- mismo patrón de idempotencia que `conversation_audit_sample`
--     (0124): una vez generado el reporte de un día, volver a pedirlo devuelve la MISMA
--     fila (`unique (hotel_id, report_date)`), nunca se recalcula en silencio con datos
--     que pudieron cambiar después (ej. una tarea que se cerró tarde). Para regenerarlo
--     a propósito (dato corregido a mano) existe el UPDATE explícito vía
--     `ON CONFLICT ... DO UPDATE` en la ruta/script que lo genera -- ver
--     `apps/api/src/routes/housekeeping.ts` y `scripts/housekeeping/reporte-diario.ts`.
--     `camaristas` es JSONB (arreglo variable de personal por día, mismo criterio que
--     `checklist`/`evidence` de `housekeeping_task`, 0041) en vez de una tabla hija: no
--     se necesita consultar por camarista individual fuera del reporte completo, y el
--     dominio puro (`buildHousekeepingDailyReport`) ya lo arma serializado.
--
-- Visibilidad: SOLO owner/gm ("reporte... al gerente", literal del criterio de
-- aceptación) -- ni housekeeping ni frontdesk lo leen, a diferencia del tablero
-- operativo (0041) que sí les pertenece. Contiene desempeño individual por camarista
-- (minutos reales vs. estándar): un dato de evaluación de personal, no un dato
-- operativo del día a día.

alter table public.room_type
  add column standard_clean_minutes integer not null default 30 check (standard_clean_minutes > 0);

-- Hallazgo al construir REQ-HK-010: el veredicto de inspección
-- (POST .../tareas/:taskId/inspeccionar, apps/api/src/routes/housekeeping.ts) SOLO se
-- reflejaba como un efecto lateral transitorio (`room.housekeeping_status` pasa a
-- 'inspeccionada' o vuelve a 'sucia') -- verificado leyendo 0041/la ruta: ninguna
-- columna de `housekeeping_task` guardaba el veredicto en sí. Sin esto, "incidencias"
-- (inspecciones rechazadas del día) sería irreconstruible después del hecho, porque el
-- estado de la habitación pudo cambiar de nuevo por una tarea posterior. Se persiste
-- el veredicto EN LA TAREA que lo recibió, expand-only, nunca se reescribe la columna
-- `notes` existente (que guarda la nota libre, no el veredicto).
create type public.housekeeping_inspection_result as enum ('aprobada', 'rechazada');
alter table public.housekeeping_task
  add column inspection_result public.housekeeping_inspection_result;

create table public.hotel_housekeeping_config (
  hotel_id uuid primary key references public.hotel(id) on delete cascade,
  tenant_id uuid not null references public.org(id) on delete restrict,
  target_ready_time time not null default '15:00:00',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.hotel_housekeeping_config enable row level security;

create policy "hotel_housekeeping_config_manager_select" on public.hotel_housekeeping_config for select to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_housekeeping_config_manager_insert" on public.hotel_housekeeping_config for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_housekeeping_config_manager_update" on public.hotel_housekeeping_config for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "hotel_housekeeping_config_manager_delete" on public.hotel_housekeeping_config for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.hotel_housekeeping_config to authenticated;

create table public.housekeeping_daily_report (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  report_date date not null,
  target_ready_time time not null,
  -- [{staffUserId, fullName, roomsCleaned, actualMinutes, standardMinutes, varianceMinutes}]
  -- -- espejo serializado de `CamaristaDailyStats[]` (packages/domain-hotel).
  camaristas jsonb not null default '[]'::jsonb,
  rooms_cleaned integer not null default 0 check (rooms_cleaned >= 0),
  rooms_ready_by_target integer not null default 0 check (rooms_ready_by_target >= 0),
  re_cleans integer not null default 0 check (re_cleans >= 0),
  incidents integer not null default 0 check (incidents >= 0),
  tickets_generated integer not null default 0 check (tickets_generated >= 0),
  generated_by uuid references public.staff_user(id) on delete set null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, report_date),
  check (rooms_ready_by_target <= rooms_cleaned)
);
create index housekeeping_daily_report_tenant_hotel_idx on public.housekeeping_daily_report (tenant_id, hotel_id);

alter table public.housekeeping_daily_report enable row level security;

create policy "housekeeping_daily_report_manager_select" on public.housekeeping_daily_report for select to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "housekeeping_daily_report_manager_insert" on public.housekeeping_daily_report for insert to authenticated
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "housekeeping_daily_report_manager_update" on public.housekeeping_daily_report for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update on public.housekeeping_daily_report to authenticated;
