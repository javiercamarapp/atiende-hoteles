-- ORIGEN: packages/db/migrations/0090_hotel_staff_identity.sql sha256:7b2d911d84c602e539d0dd29dcfe4ab53cb6f07259c655670c9c4be165da2a9f
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H12a · REQ-LAUNCH: Google OAuth (Authorization Code + PKCE, ADR-004 "JWT propio, sin
-- Supabase Auth") necesita un lugar donde vincular la identidad externa (proveedor +
-- `sub`) a la cuenta de `staff_user` que ya usa el login por contraseña -- una cuenta
-- puede tener AMBOS métodos a la vez (password + Google), nunca se reemplaza uno con
-- el otro. `provider_sub` es el identificador ESTABLE de Google (el campo `sub` del
-- id_token, nunca el correo -- un usuario puede cambiar su correo de Google, `sub` no
-- cambia) -- por eso el UNIQUE real es (provider, provider_sub), no el correo.
--
-- Sin credenciales de Google en este entorno, esta tabla queda vacía (ninguna fila se
-- inserta hasta que exista un intercambio de código real u OAuth falso de prueba,
-- ver apps/api/src/routes/auth-google.ts) -- la tabla en sí no depende de credenciales.

create table public.hotel_staff_identity (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references public.staff_user(id) on delete cascade,
  provider text not null check (provider in ('google')),
  provider_sub text not null,
  email text not null,
  email_verified boolean not null default false,
  created_at timestamptz not null default now(),
  unique (provider, provider_sub)
);
create index hotel_staff_identity_staff_user_idx on public.hotel_staff_identity (staff_user_id);

alter table public.hotel_staff_identity enable row level security;
-- Un staff puede ver SUS PROPIAS identidades vinculadas (p. ej. una futura pantalla de
-- "cuenta" que muestre "Google vinculado: sí/no") -- nunca las de un colega, aunque
-- comparta hotel (a diferencia de `staff_user`, esto no es información operativa del
-- equipo). Toda escritura (vincular/desvincular) pasa por el cliente ADMIN desde
-- apps/api/src/routes/auth-google.ts (mismo patrón pre-sesión que el login de
-- contraseña en routes/auth.ts) -- sin policy de insert/update/delete para
-- `authenticated`.
create policy "hotel_staff_identity_self_select" on public.hotel_staff_identity for select to authenticated
  using (staff_user_id = auth.uid());
grant select on public.hotel_staff_identity to authenticated;
