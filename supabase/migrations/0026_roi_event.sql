-- ORIGEN: packages/db/migrations/0026_roi_event.sql sha256:6a8d202c905dc7f839a2f112bbc75119844b8cda8caef28b6868503adcbaa06f
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H7 · REQ-AGT-003/REQ-REV-018 (H17-001/BP-131/GOB-037): un `ROIEvent` por cada acción de
-- agente con valor económico -- `monto_verificado`/`monto_estimado`/`metodo_contrafactual`/
-- `confianza`, exactamente los 4 campos que exige H17-001, más el versionado explícito del
-- supuesto usado (`supuesto_version`, p.ej. "H17-v1" -> docs/referencia/03-investigacion-H12-H21.md
-- §H17) para que un cambio de fórmula/parámetro nunca reescriba en silencio el histórico ya
-- mostrado al dueño del hotel. `estimado = true` mientras no exista `monto_verificado`
-- (REQ-REV-018 "ningún cobro por resultado se activa sin línea base firmada" -- esta tabla
-- CAPTURA el evento con su supuesto, la lógica de línea base firmada y facturación por
-- resultado sobre esta captura queda pendiente de un hito posterior, ver README de este
-- paquete).
--
-- Append-only (mismo criterio que audit_log/agent_run): un evento de ROI ya registrado no
-- se corrige por UPDATE, se corrige con un evento nuevo -- el histórico de "qué se mostró
-- en cada momento" es en sí mismo parte de la transparencia prometida al dueño (H18-005).
create table public.roi_event (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  agent_name text not null,
  -- Tipo de evento de valor (p.ej. "checkin_asistido", "reserva_directa_atribuida",
  -- "hora_staff_liberada", "gasto_evitado_revenue") -- catálogo abierto a propósito
  -- (texto, no enum): H17 define 16 agentes con fórmulas de valor distintas y en
  -- evolución, un enum cerrado obligaría a migrar el esquema en cada ajuste de fórmula.
  tipo_evento text not null,
  monto_estimado numeric(12, 2),
  monto_verificado numeric(12, 2),
  metodo_contrafactual text not null,
  confianza numeric(4, 3) not null check (confianza >= 0 and confianza <= 1),
  supuesto_version text not null default 'H17-v1',
  -- true mientras no haya monto_verificado (contra línea base firmada, REQ-REV-018);
  -- se recalcula en el trigger de abajo, nunca se confía en el valor que mande la app.
  estimado boolean not null default true,
  referencia_tipo text not null default 'ninguna'
    check (referencia_tipo in ('reserva', 'folio', 'tarea', 'conversacion', 'ninguna')),
  -- Identificador de NEGOCIO (folio/código de reserva, no una FK) -- evita acoplar esta
  -- tabla a la forma exacta de cada entidad referenciada y evita filtrar un id de otro
  -- hotel: la fila ya está acotada por hotel_id, este campo es solo trazabilidad legible.
  referencia_codigo text,
  notas text,
  created_by text,
  created_at timestamptz not null default now(),
  check (monto_estimado is not null or monto_verificado is not null)
);

create index roi_event_hotel_created_idx on public.roi_event (hotel_id, created_at desc);
create index roi_event_hotel_agent_idx on public.roi_event (hotel_id, agent_name);

-- `estimado` es una columna DERIVADA de si hay monto_verificado -- se recalcula aquí en
-- vez de confiar en lo que la aplicación mande, para que la UI nunca pueda mostrar
-- "verificado" cuando en realidad nadie confirmó un monto contra línea base.
create or replace function public.roi_event_set_estimado()
returns trigger
language plpgsql
as $$
begin
  new.estimado := (new.monto_verificado is null);
  return new;
end;
$$;

create trigger roi_event_set_estimado_trg
  before insert on public.roi_event
  for each row execute function public.roi_event_set_estimado();

alter table public.roi_event enable row level security;
create policy "roi_event_hotel_select" on public.roi_event for select to authenticated
  using (hotel_id = any (current_hotel_ids()));
create policy "roi_event_hotel_insert" on public.roi_event for insert to authenticated
  with check (hotel_id = any (current_hotel_ids()));
-- Sin policy de UPDATE/DELETE: append-only (ver comentario de archivo).

grant select, insert on public.roi_event to authenticated;
