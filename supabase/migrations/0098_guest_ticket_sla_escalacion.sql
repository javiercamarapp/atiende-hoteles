-- ORIGEN: packages/db/migrations/0098_guest_ticket_sla_escalacion.sql sha256:0864f76e52e414818d078a512610836eb700f0d0bac3b73314e7816dcf84d433
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-HUE-014 (docs/REQUISITOS.md/docs/ACEPTACION.md): "Cada mensaje/petición del
-- huésped debe convertirse en un ticket con departamento, habitación, prioridad y SLA
-- [...]; un ticket sin cierre dentro del SLA debe escalar automáticamente."
--
-- `guest_ticket` es una tabla NUEVA y separada de `maintenance_ticket` (0043) y
-- `housekeeping_task` (0041) a propósito: esas dos ya cubren el flujo OPERATIVO
-- especializado de sus propios REQ (costo/aprobación de mantenimiento REQ-HK-011,
-- checklist/inspección de camarista REQ-HK-001) y esta migración no las toca. Este
-- `guest_ticket` es la capa de TRIAGE genérica que exige REQ-HUE-014: registra que un
-- mensaje/petición del huésped (por CUALQUIER canal -- WhatsApp/voz cuando exista esa
-- credencial, QR/formulario propio o transcripción de staff hoy) se convirtió en un
-- ticket con departamento/habitación/prioridad/SLA, y quién debe atenderlo.
--
-- `department` reutiliza `public.hotel_role` (REQ-TEN-003, "8 roles hoteleros exactos",
-- 0003_membership_and_rls_helpers.sql) en vez de una taxonomía de departamento paralela
-- -- el mismo "modelo de tenencia contradictorio" que docs/auditoria-0/documentos.md ya
-- encontró una vez con una tabla `hotel` duplicada.
--
-- `channel`: 'qr' (formulario/QR en habitación) y 'staff' (recepción transcribe una
-- petición por teléfono/mostrador) son canales REALES verificables hoy sin ninguna
-- credencial externa. 'whatsapp'/'voz' quedan declarados en el enum para cuando el
-- canal conversacional real exista (REQ-HUE-001/002/004, credenciales Meta/Telnyx,
-- "pendiente-credenciales" en docs/TRAZABILIDAD.md) -- ningún código de este pase
-- produce un `guest_ticket.channel` de esos dos valores sin ese canal real conectado; se
-- documentan de antemano para no requerir otra migración destructiva el día que el canal
-- exista (expand-only, ADR-008).
create type public.guest_ticket_priority as enum ('alta', 'media', 'baja');
create type public.guest_ticket_status as enum ('abierto', 'en_progreso', 'cerrado', 'escalado', 'cancelado');
create type public.guest_ticket_channel as enum ('qr', 'staff', 'whatsapp', 'voz');

create table public.guest_ticket (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  room_id uuid references public.room(id) on delete set null,
  department public.hotel_role not null,
  priority public.guest_ticket_priority not null default 'media',
  status public.guest_ticket_status not null default 'abierto',
  channel public.guest_ticket_channel not null default 'staff',
  guest_message text not null,
  -- SLA resuelto y congelado AL CREAR el ticket (packages/domain-hotel/src/tickets/
  -- slaPolicy.ts::resolveSlaMinutes/computeSlaDueAt) -- cambiar despues la politica de
  -- `ticket_sla_policy` nunca mueve el vencimiento de un ticket ya abierto, solo el de
  -- los que se creen despues (mismo criterio que una tarifa ya cotizada no cambia sola).
  sla_minutes integer not null check (sla_minutes > 0),
  sla_due_at timestamptz not null,
  assigned_to uuid references public.staff_user(id) on delete set null,
  escalated_at timestamptz,
  -- Roles destinatarios de la escalacion (mismo patron `recipient_roles` jsonb que
  -- `fraud_alert`, 0095_fraude_alerta.sql, en vez de public.hotel_role[] -- ADR-003
  -- documenta que no todo comportamiento de Postgres es identico entre PGlite y
  -- embedded-postgres, y este esquema ya usa jsonb para listas de roles en todos lados).
  escalated_to_roles jsonb not null default '[]'::jsonb,
  resolution_note text,
  closed_at timestamptz,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_ticket_closed_at_coherente check (
    (status in ('cerrado', 'cancelado') and closed_at is not null)
    or (status not in ('cerrado', 'cancelado') and closed_at is null)
  ),
  constraint guest_ticket_escalated_at_coherente check (
    (status = 'escalado') = (escalated_at is not null)
  )
);
create index guest_ticket_tenant_hotel_idx on public.guest_ticket (tenant_id, hotel_id);
create index guest_ticket_room_idx on public.guest_ticket (room_id) where room_id is not null;
-- Escaneo de escalacion (apps/api/src/jobs/ticketEscalation.ts): tickets ABIERTOS cuyo
-- SLA ya vencio -- parcial sobre `status` para no escanear cerrados/cancelados/ya
-- escalados en cada corrida del planificador.
create index guest_ticket_open_sla_idx on public.guest_ticket (hotel_id, sla_due_at)
  where status in ('abierto', 'en_progreso');

alter table public.guest_ticket enable row level security;

-- Mismo criterio que `maintenance_ticket` (0043): owner/gm/frontdesk ven/administran
-- TODOS los tickets del hotel (son quienes reciben la peticion del huesped primero);
-- el departamento asignado ve/gestiona los suyos; quien reporto (created_by, tipicamente
-- quien atendio al huesped) puede seguir SU PROPIO reporte -- sin esta ultima clausula,
-- un INSERT ... RETURNING desde un rol que solo reporta (p.ej. housekeeping reportando
-- un ticket de fnb) se rechazaria por RLS al validar la fila resultante contra la policy
-- de SELECT (comprobado empiricamente en 0043, mismo comentario alli).
create policy "guest_ticket_scope_select" on public.guest_ticket for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and (
      has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
      or has_hotel_role(hotel_id, array[department])
      or created_by = auth.uid()
    )
  );
-- Cualquier miembro del staff del hotel puede REGISTRAR un ticket a partir de una
-- peticion de huesped (REQ-HUE-014: "cada mensaje/peticion"), sin importar su propio rol
-- -- quien contesta el QR de la habitacion 204 puede ser cualquier departamento.
create policy "guest_ticket_staff_insert" on public.guest_ticket for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant']::public.hotel_role[]
    )
  );
-- UPDATE (incluye cierre/reasignacion/escalacion manual): owner/gm/frontdesk de
-- cualquier ticket del hotel, o el departamento asignado del suyo propio. La escalacion
-- AUTOMATICA por SLA (apps/api/src/jobs/ticketEscalation.ts) corre sobre la conexion
-- admin del proceso (superusuario, igual que night audit/purgas), no bajo esta policy.
create policy "guest_ticket_scope_update" on public.guest_ticket for update to authenticated
  using (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
    or has_hotel_role(hotel_id, array[department])
  )
  with check (
    has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk']::public.hotel_role[])
    or has_hotel_role(hotel_id, array[department])
  );
create policy "guest_ticket_manager_delete" on public.guest_ticket for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.guest_ticket to authenticated;

-- Politica de SLA CONFIGURABLE por hotel (REQ-HUE-014: "SLA configurado"): una fila por
-- (hotel, departamento, prioridad) que sobreescribe
-- `DEFAULT_SLA_MINUTES_BY_PRIORITY` de packages/domain-hotel/src/tickets/slaPolicy.ts
-- cuando existe. Sin fila -> se usa el default por prioridad (documentado como
-- placeholder de negocio en ese archivo, igual que otros defaults de este esquema).
create table public.ticket_sla_policy (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  department public.hotel_role not null,
  priority public.guest_ticket_priority not null,
  sla_minutes integer not null check (sla_minutes > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, department, priority)
);
create index ticket_sla_policy_hotel_idx on public.ticket_sla_policy (hotel_id);

alter table public.ticket_sla_policy enable row level security;

-- Solo owner/gm ESCRIBEN el SLA del hotel, pero CUALQUIER staff que pueda crear un
-- `guest_ticket` (guest_ticket_staff_insert, arriba) necesita LEER esta tabla -- es
-- justo lo que `crear_ticket_huesped` (packages/agent-core/src/tools/ticketTools.ts)
-- consulta para resolver el SLA a congelar en el ticket que esa MISMA persona está
-- creando. Restringir el SELECT a owner/gm únicamente rompía la resolución de SLA
-- configurado para cualquier ticket creado por otro rol (detectado por
-- tests/integration/tickets/sla-escalado.spec.ts: el SLA configurado se ignoraba en
-- silencio y siempre caía al default). No es dato sensible (solo minutos por
-- departamento/prioridad), así que ampliar el SELECT no expone nada que ese staff no
-- pueda ya inferir de sus propios tickets.
create policy "ticket_sla_policy_staff_select" on public.ticket_sla_policy for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant']::public.hotel_role[]
    )
  );
create policy "ticket_sla_policy_manager_insert" on public.ticket_sla_policy for insert to authenticated
  with check (tenant_id = any (current_tenant_ids()) and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "ticket_sla_policy_manager_update" on public.ticket_sla_policy for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));
create policy "ticket_sla_policy_manager_delete" on public.ticket_sla_policy for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, update, delete on public.ticket_sla_policy to authenticated;
