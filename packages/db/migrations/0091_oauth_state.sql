-- H12a · Google OAuth (Authorization Code + PKCE): `state` (anti-CSRF) y `nonce`
-- (anti-replay del id_token) se generan en `GET /auth/google/iniciar` y se validan en
-- `GET /auth/google/callback` -- ambos deben viajar por un almacén server-side de un
-- solo uso (nunca solo una cookie firmada: el encargo exige poder probar "state
-- inválido"/"nonce repetido" de forma determinista contra un servidor OAuth falso, ver
-- tests/support/fakeGoogleOAuth.ts). `code_verifier` (PKCE) se guarda aquí también --
-- nunca viaja de ida y vuelta por el navegador.
--
-- Solo el proceso de la API (cliente admin) lee/escribe esta tabla -- no hay ninguna
-- policy para `authenticated`: ni siquiera el propio usuario autenticado tiene ningún
-- motivo legítimo para leer un `state`/`nonce` en tránsito (defensa en profundidad,
-- RLS habilitada sin ninguna policy = 0 filas visibles para `authenticated`).

create table public.oauth_state (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('google')),
  -- REQ-LAUNCH: intención del flujo -- "login" vincula/inicia sesión de un staff YA
  -- invitado; "registro" crea org+hotel+owner nuevos al volver del proveedor (el
  -- callback decide cuál según esto, nunca según un parámetro que el cliente pudiera
  -- alterar en el `redirect_uri`).
  purpose text not null check (purpose in ('login', 'registro')),
  state text not null unique,
  nonce text not null,
  code_verifier text not null,
  redirect_uri text not null,
  -- Metadatos de la intención de "registro" (nombre de hotel, ciudad/estado) capturados
  -- ANTES de saltar a Google, para poder crear org+hotel+owner en el callback sin
  -- depender de un segundo formulario tras volver del proveedor.
  registro_payload jsonb,
  status text not null default 'pendiente' check (status in ('pendiente', 'usado', 'expirado')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index oauth_state_expires_idx on public.oauth_state (expires_at);

alter table public.oauth_state enable row level security;
-- Sin ninguna policy ni GRANT a `authenticated`: solo el rol admin (superusuario del
-- motor, bypassa RLS) del proceso backend accede a esta tabla.
