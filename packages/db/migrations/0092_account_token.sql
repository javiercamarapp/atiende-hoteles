-- H12a · Tokens de un solo uso para los 4 flujos de autoservicio de cuenta (mismo
-- patrón que `checkin_link`, migración 0054: token de alta entropía generado en CÓDIGO
-- DE APLICACIÓN con `crypto.randomBytes`, columna `token` UNIQUE, `status`
-- pendiente/usado/expirado, nunca reutilizable):
--   - verificar_correo:      alta autoservicio (POST /registro) -- expira en 24h.
--   - restablecer_contrasena: "olvidé mi contraseña" -- expira en 1h.
--   - cambio_correo:          confirmar el nuevo correo de una cuenta existente.
--   - invitacion_staff:       un owner/gm invita a un colega con un rol -- expira en 7
--                             días; `staff_user_id` es NULL hasta que el invitado acepta
--                             (puede que la cuenta invitada todavía no exista).

create table public.account_token (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('verificar_correo', 'restablecer_contrasena', 'cambio_correo', 'invitacion_staff')),
  org_id uuid references public.org(id) on delete cascade,
  hotel_id uuid references public.hotel(id) on delete cascade,
  staff_user_id uuid references public.staff_user(id) on delete cascade,
  email text not null,
  -- Solo aplica a purpose='invitacion_staff'; NULL en cualquier otro caso (constraint
  -- abajo lo exige explícitamente, nunca queda ambiguo).
  role public.hotel_role,
  token text not null unique,
  status text not null default 'pendiente' check (status in ('pendiente', 'usado', 'expirado')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint account_token_role_solo_invitacion check (
    (purpose = 'invitacion_staff' and role is not null and hotel_id is not null)
    or (purpose <> 'invitacion_staff' and role is null)
  )
);
create index account_token_hotel_purpose_idx on public.account_token (hotel_id, purpose, status);
create index account_token_email_idx on public.account_token (email);
-- Una sola invitación PENDIENTE a la vez por (hotel, correo) -- invitar de nuevo debe
-- expirar la anterior primero (mismo criterio que `checkin_link_reservation_pendiente_idx`).
create unique index account_token_invitacion_pendiente_idx on public.account_token (hotel_id, lower(email))
  where purpose = 'invitacion_staff' and status = 'pendiente';

alter table public.account_token enable row level security;
-- Solo el propio owner/gm del hotel puede ver/gestionar SUS invitaciones enviadas
-- (p. ej. una pantalla "invitaciones pendientes" con botón de revocar) -- los otros 3
-- propósitos (verificación/reset/cambio de correo) son flujos SIN sesión de staff:
-- toda su lectura/escritura pasa por el cliente admin desde
-- apps/api/src/routes/registro.ts / auth.ts, nunca por el rol `authenticated`.
create policy "account_token_invitacion_select" on public.account_token for select to authenticated
  using (
    purpose = 'invitacion_staff'
    and hotel_id = any (current_hotel_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "account_token_invitacion_insert" on public.account_token for insert to authenticated
  with check (
    purpose = 'invitacion_staff'
    and hotel_id = any (current_hotel_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
create policy "account_token_invitacion_update" on public.account_token for update to authenticated
  using (
    purpose = 'invitacion_staff'
    and hotel_id = any (current_hotel_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  )
  with check (
    purpose = 'invitacion_staff'
    and hotel_id = any (current_hotel_ids())
    and has_hotel_role(hotel_id, array['owner', 'gm']::public.hotel_role[])
  );
grant select, insert, update on public.account_token to authenticated;
