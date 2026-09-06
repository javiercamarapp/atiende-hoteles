-- H1 · Esquema base: identidad compatible con Supabase (auth.uid()) + roles de conexión.
--
-- No se usa `create extension pgcrypto`: `gen_random_uuid()` es nativo desde Postgres 13
-- y las funciones SHA-2 (`sha256`, usadas por audit_log) son nativas desde Postgres 11.
-- docs/referencia/07-stack-viabilidad.md Experimento 1 confirma que `pgcrypto` standalone
-- falla en PGlite 0.5.8 aunque `gen_random_uuid()` funciona sin la extensión — por eso este
-- esquema evita cualquier `create extension` para mantenerse portable entre PGlite y
-- `embedded-postgres` (ADR-003).

create schema if not exists auth;

-- Emulación LOCAL (solo PGlite/embedded-postgres) de auth.uid() de Supabase: lee el claim
-- `sub` que la capa de sesión (ADR-004) inyecta con
-- `select set_config('request.jwt.claim.sub', <user_id>, true)` antes de cada query de
-- negocio. Contra un proyecto Supabase real, auth.uid() ya existe con la misma firma;
-- esta función nunca se despliega ahí (ver ADR-003, "Consecuencias").
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

comment on function auth.uid() is
  'Emulacion local (PGlite/embedded-postgres) de auth.uid() de Supabase. No desplegar contra Supabase real: ahi ya existe esta funcion.';

-- Roles de conexion (ADR-003/ADR-004):
--   atiende_app    -> rol de LOGIN que usa el pool del backend (equivalente al
--                     `authenticator` de PostgREST/Supabase). Sin BYPASSRLS.
--   authenticated  -> rol SIN login al que se conmuta por transaccion
--                     (`set local role authenticated`), mismo nombre que usa
--                     Supabase/Restaurantes para que las mismas políticas RLS
--                     sean portables 1:1.
do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'atiende_app') then
    create role atiende_app login password 'atiende_app_dev_only_local'
      nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
  end if;
end
$do$;

grant authenticated to atiende_app;

-- Bloqueo por defecto: nada de PUBLIC en los esquemas de la aplicacion. Los grants
-- explicitos por tabla/función se hacen en cada migración y se refuerzan en
-- 0010_grants_and_lockdown.sql.
revoke all on schema public from public;
revoke all on schema auth from public;
grant usage on schema public to atiende_app, authenticated;
grant usage on schema auth to atiende_app, authenticated;
grant execute on function auth.uid() to atiende_app, authenticated;
