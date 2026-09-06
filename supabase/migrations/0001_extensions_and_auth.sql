-- ORIGEN: packages/db/migrations/0001_extensions_and_auth.sql sha256:81e0641e8a823cc5035cba401e3ec7862af4a23ac7cba2506cde06da23268ceb
-- GENERADO por scripts/export-supabase-migrations.ts -- NO EDITAR A MANO: correr de
-- nuevo el script tras cambiar la migración fuente.

-- H12b · Transformado por scripts/export-supabase-migrations.ts a partir de
-- packages/db/migrations/0001_extensions_and_auth.sql (ver encabezado ORIGEN abajo).
--
-- OMITIDO respecto al original (Supabase ya lo provee vía GoTrue, ADR-003):
--   - `create schema auth` y `auth.uid()` (emulación LOCAL de PGlite/embedded-postgres).
--   - `create role authenticated/anon/service_role` -- YA EXISTEN en cualquier proyecto
--     Supabase; recrearlos fallaría o los tomaría con otro dueño/privilegios.
--
-- CONSERVADO: `gen_random_uuid()` sigue sin requerir `create extension pgcrypto` (nativo
-- desde Postgres 13, igual en Supabase); el bloqueo `revoke all ... from public` sobre el
-- esquema `public` (Supabase no lo hace por defecto); la creación de `atiende_app` (rol de
-- LOGIN propio del backend, no lo trae Supabase) y su membresía en `authenticated`.
--
-- ACCIÓN MANUAL REQUERIDA (docs/runbooks/migracion-a-supabase.md): tras aplicar esta
-- migración, ejecutar UNA VEZ, con una contraseña real generada aparte (nunca la de este
-- archivo, que es un placeholder que Postgres rechaza si se usara tal cual en producción
-- por ser previsible):
--   ALTER ROLE atiende_app WITH PASSWORD '<contraseña real, ej. openssl rand -base64 32>';
-- y usar esa contraseña real en `SUPABASE_DB_PASSWORD`/la cadena de conexión del backend
-- -- nunca commitear la contraseña real a este repositorio.

do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'atiende_app') then
    create role atiende_app login password 'CAMBIAR_ANTES_DE_PRODUCCION_ver_ALTER_ROLE_arriba'
      nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
  end if;
end
$do$;

grant authenticated to atiende_app;

-- Bloqueo por defecto sobre el esquema public (Supabase no lo aplica de fábrica); el
-- esquema auth NO se toca aquí -- es propiedad de supabase_auth_admin, no de este proyecto.
revoke all on schema public from public;
grant usage on schema public to atiende_app, authenticated;
