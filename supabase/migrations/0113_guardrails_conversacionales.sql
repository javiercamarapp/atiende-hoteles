-- ORIGEN: packages/db/migrations/0113_guardrails_conversacionales.sql sha256:2147566192e0fce4d58d01b137c5504370517a2af702e99b95c5331f36b73c17
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- REQ-HUE-023 (P0/SEG): "guardrails de seguridad conversacional: [...] exigir OTP al
-- canal original ante cambios de contacto [...] y no generar notas discriminatorias."
--
-- Dos superficies NUEVAS (confirmado por grep antes de este archivo: ni "cambio de
-- contacto"/"otp" ni ninguna tabla de notas de huésped existían en el repositorio):
--
-- 1) `guest_contact_change_request`: registra una solicitud de cambio de
--    teléfono/correo de un huésped y el ciclo de vida de su verificación por OTP.
--    `otp_sent_to_phone` congela el CANAL ORIGINAL (el `guest.phone` ya registrado
--    ANTES del cambio) en el momento de crear la solicitud -- el OTP SIEMPRE se envía
--    ahí, nunca al valor nuevo solicitado (`requested_value`), sin importar si el campo
--    que se está cambiando es el propio teléfono o el correo. Solo se guarda el HASH
--    del código (mismo esquema `scrypt` que `staff_user.password_hash`, reutilizando
--    `hashPassword`/`verifyPassword` de `@atiende-hoteles/db` desde
--    `apps/api/src/routes/huespedes.ts` -- nunca un segundo esquema de hashing en este
--    repo), nunca el código en texto plano.
--
-- 2) `guest_note`: nota interna asociada a un huésped (p. ej. redactada por el agente
--    conversacional o transcrita por staff) -- `packages/domain-hotel/src/
--    conversationalGuardrails.ts::containsDiscriminatoryContent` se evalúa ANTES de
--    cualquier INSERT en esta tabla (`apps/api/src/routes/huespedes.ts`); una nota que
--    hace match se rechaza por completo (0 filas insertadas), nunca se guarda una
--    versión "suavizada".
create type public.guest_contact_field as enum ('email', 'telefono');
create type public.guest_contact_change_status as enum (
  'pendiente', 'confirmado', 'rechazado_expirado', 'rechazado_intentos_agotados', 'cancelado'
);

create table public.guest_contact_change_request (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  field public.guest_contact_field not null,
  requested_value text not null,
  -- Canal ORIGINAL (telefono ya registrado ANTES del cambio) al que se envio el OTP --
  -- ver cabecera de este archivo. Nunca nulo: crear la solicitud se rechaza en la app
  -- (no en esta tabla) si el huesped no tiene telefono registrado todavia, porque no
  -- existiria ningun canal original contra el cual verificar (packages/domain-hotel/src/
  -- guestContactChangeOtp.ts documenta la regla; el rechazo real vive en la ruta HTTP,
  -- que es la unica que INSERTa aqui).
  otp_sent_to_phone text not null,
  otp_code_hash text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  status public.guest_contact_change_status not null default 'pendiente',
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  requested_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint guest_contact_change_request_max_attempts_positivo check (max_attempts > 0),
  constraint guest_contact_change_request_attempts_no_negativo check (attempts >= 0)
);
create index guest_contact_change_request_guest_idx on public.guest_contact_change_request (guest_id);
create index guest_contact_change_request_hotel_idx on public.guest_contact_change_request (hotel_id);
-- Consulta de "solicitudes pendientes vencidas" (limpieza/observabilidad futura) --
-- parcial sobre status, mismo criterio que guest_ticket_open_sla_idx (0098).
create index guest_contact_change_request_pendiente_idx on public.guest_contact_change_request (hotel_id, expires_at)
  where status = 'pendiente';

alter table public.guest_contact_change_request enable row level security;

-- Mismo patron de roles que guest_ticket (0098): owner/gm/frontdesk/reservations
-- gestionan cambios de contacto de cualquier huesped del hotel -- son quienes reciben
-- la peticion del huesped (telefono/mostrador/WhatsApp) y la tramitan.
create policy "guest_contact_change_request_scope_select" on public.guest_contact_change_request for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "guest_contact_change_request_scope_insert" on public.guest_contact_change_request for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
-- UPDATE cubre incrementar `attempts` y fijar el `status` final tras cada intento de
-- confirmacion (packages/domain-hotel/src/guestContactChangeOtp.ts::evaluateOtpConfirmation) --
-- mismos roles que pueden verla/crearla.
create policy "guest_contact_change_request_scope_update" on public.guest_contact_change_request for update to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]))
  with check (has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[]));

grant select, insert, update on public.guest_contact_change_request to authenticated;

create table public.guest_note (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  hotel_id uuid not null references public.hotel(id) on delete cascade,
  guest_id uuid not null references public.guest(id) on delete cascade,
  body text not null,
  created_by uuid references public.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index guest_note_guest_idx on public.guest_note (guest_id);
create index guest_note_hotel_idx on public.guest_note (hotel_id);

alter table public.guest_note enable row level security;

-- Mismo patron amplio que guest_ticket_staff_insert (0098): cualquier miembro del staff
-- del hotel puede registrar una nota (quien atiende al huesped puede ser cualquier
-- departamento), pero solo owner/gm/frontdesk/reservations la LEEN de vuelta -- una nota
-- interna sobre un huesped no es informacion operativa de housekeeping/mantenimiento/fnb.
create policy "guest_note_scope_select" on public.guest_note for select to authenticated
  using (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm', 'frontdesk', 'reservations']::public.hotel_role[])
  );
create policy "guest_note_staff_insert" on public.guest_note for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and has_hotel_role(
      hotel_id,
      array['owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant']::public.hotel_role[]
    )
  );
create policy "guest_note_manager_delete" on public.guest_note for delete to authenticated
  using (has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[]));

grant select, insert, delete on public.guest_note to authenticated;
