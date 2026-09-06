-- H12c · LAUNCH-017: centro de notificaciones in-app (patrón de
-- `atiende-restaurantes/src/components/admin/NotificacionesSection.tsx` y
-- `likida/src/app/dashboard/notificaciones/page.tsx`, adaptado a RLS multi-tenant real en
-- vez de una sola cuenta). `body` es texto de negocio (tipo de habitación, folio, título
-- de ticket) -- NUNCA nombre/teléfono/email/CURP/RFC de huésped (REQ-SEG "sin PII" —
-- verificado en tests/adversarial/notificaciones-sin-pii.spec.ts). Una notificación es
-- para UN usuario concreto (`recipient_user_id`) O para un ROL dentro de un hotel
-- (`recipient_role`, broadcast) -- nunca ambos a la vez (constraint explícito).
create type public.notification_type as enum (
  'reserva_nueva',
  'aprobacion_pendiente',
  'ticket_urgente',
  'night_audit_cerrado',
  'limite_plan',
  'sistema'
);

create table public.notification (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.org(id) on delete restrict,
  -- NULL solo para avisos de nivel de cuenta (p. ej. `limite_plan`, que aplica a todo el
  -- org, no a un hotel en particular).
  hotel_id uuid references public.hotel(id) on delete cascade,
  recipient_user_id uuid references public.staff_user(id) on delete cascade,
  recipient_role public.hotel_role,
  type public.notification_type not null,
  title text not null,
  body text not null,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (recipient_user_id is not null and recipient_role is null)
    or (recipient_user_id is null and recipient_role is not null)
  ),
  -- Un broadcast por rol SIEMPRE necesita hotel_id (¿rol de qué hotel?) salvo que sea un
  -- aviso de org completo, que en ese caso solo llega a owner/gm (ver policy de abajo).
  check (recipient_role is null or hotel_id is not null or recipient_role in ('owner', 'gm'))
);
create index notification_recipient_idx on public.notification (recipient_user_id, read_at, created_at desc);
create index notification_role_idx on public.notification (hotel_id, recipient_role, read_at, created_at desc);
create index notification_tenant_idx on public.notification (tenant_id, created_at desc);

alter table public.notification enable row level security;

-- SELECT: el destinatario exacto, o cualquier staff del hotel con el rol de broadcast
-- (owner/gm también reciben los avisos de nivel-org sin hotel_id).
create policy "notification_recipient_select" on public.notification for select to authenticated
  using (
    recipient_user_id = auth.uid()
    or (
      recipient_role is not null
      and (
        (hotel_id is not null and has_hotel_role(hotel_id, array[recipient_role]))
        or (hotel_id is null and tenant_id = any (current_tenant_ids()) and is_org_admin(tenant_id))
      )
    )
  );
-- INSERT: cualquier staff del hotel puede generar una notificación DENTRO de su propio
-- hotel/org (el disparo real en producción viene de triggers SECURITY DEFINER, ver
-- 0114, que no dependen de esta policy porque corren con el cliente admin) -- se deja
-- una vía de aplicación explícita para pruebas/uso manual, nunca cross-tenant.
create policy "notification_hotel_insert" on public.notification for insert to authenticated
  with check (
    tenant_id = any (current_tenant_ids())
    and (hotel_id is null or hotel_id = any (current_hotel_ids()))
  );
-- UPDATE (marcar leída): SOLO el propio destinatario, o un miembro del rol de broadcast
-- correspondiente marcando SU copia lógica como leída para sí mismo -- en la práctica el
-- "marcar todo como leído" solo aplica a filas con recipient_user_id = auth.uid() (ver
-- routes/notificaciones.ts); las de broadcast por rol se marcan leídas individualmente
-- porque son compartidas por varios usuarios del mismo rol.
create policy "notification_recipient_update" on public.notification for update to authenticated
  using (recipient_user_id = auth.uid())
  with check (recipient_user_id = auth.uid());

grant select, insert, update on public.notification to authenticated;

-- Preferencia por usuario (opt-out de un tipo de notificación) -- REQ-UX "preferencia
-- por usuario". `enabled = false` significa "no generar/mostrar este tipo para mí";
-- el default (sin fila) es `true` para todos los tipos.
create table public.notification_preference (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.staff_user(id) on delete cascade,
  type public.notification_type not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (user_id, type)
);
alter table public.notification_preference enable row level security;
create policy "notification_preference_self" on public.notification_preference for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
grant select, insert, update, delete on public.notification_preference to authenticated;

-- "Marcar todo como leído" atómico -- aprende del fix real de Restaurantes
-- `fix(notifications): atomically clear dashboard badges` (docs/referencia/
-- 08-inventario-punta-a-punta.md): un UPDATE ... WHERE ... en una sola sentencia, nunca
-- un SELECT de ids seguido de N UPDATEs desde la aplicación (esa carrera es exactamente
-- lo que dejaba badges "atorados" en Restaurantes: una notificación nueva llegaba entre
-- el SELECT y el último UPDATE y quedaba marcada leída sin que el usuario la viera, o al
-- revés, el contador no bajaba a 0 aunque todo se hubiera marcado). Alcance: SOLO las
-- propias del usuario (recipient_user_id = auth.uid()); las de broadcast por rol no las
-- toca (cada quien las marca individualmente, ver arriba).
create or replace function public.mark_all_notifications_read()
returns integer
language sql
security invoker
set search_path = public
as $$
  with actualizadas as (
    update public.notification
    set read_at = now()
    where recipient_user_id = auth.uid() and read_at is null
    returning 1
  )
  select count(*)::integer from actualizadas
$$;
grant execute on function public.mark_all_notifications_read() to authenticated;
