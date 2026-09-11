-- Patrón Likida/atiende.ai #3 ("rate limiting distribuido fail-open/closed explícito"):
-- `apps/api/src/lib/rateLimit.ts` (`MemoryRateLimitStore`) guarda el conteo en un `Map`
-- del proceso -- en despliegue serverless multi-instancia (Vercel/Fly con >1 máquina) el
-- límite deja de ser efectivo entre instancias concurrentes (LAUNCH-022, documentado en
-- `deploy/README.md`/`deploy/api/vercel/api/[[...route]].ts`). Por instrucción del audit
-- que originó este cambio NO se aprovisiona Redis nuevo -- pero este repo YA tiene un
-- store compartido real entre instancias: el mismo Postgres que todas comparten. Esta
-- tabla respalda `PostgresRateLimitStore` (rateLimit.ts), un store REAL (no un
-- esqueleto/fake) probado de extremo a extremo contra `embedded-postgres`/PGlite, ver
-- tests/unit/api/postgres-rate-limit-store.spec.ts.
--
-- Tabla puramente operativa/infra, sin dato de negocio ni PII (`key` es
-- "ip:<ip>"/"user:<uuid>", nunca un dato personal en texto libre). Se accede EXCLUSIVAMENTE
-- vía `deps.engine.admin` -- el rate limit corre ANTES de `authMiddleware`/`dbSession`
-- (ver `apps/api/src/server.ts`), así que nunca hay una sesión de usuario/claims que una
-- policy RLS pudiera evaluar. Mismo criterio que `public.schema_migrations`
-- (packages/db/migrations/0101_schema_migrations_grant_readonly.sql): tabla de sistema
-- SIN RLS, acceso acotado solo por GRANT explícito al rol `atiende_app` -- en producción
-- (`ManagedPostgresEngine`) `admin` conecta como `atiende_app` PELADO, sin
-- `set local role authenticated` (ver comentario de `openManagedPostgres`,
-- packages/db/src/engines.ts): sin este GRANT directo (no a `authenticated`), esta tabla
-- sería invisible para el rate limiter en producción real, aunque funcionara en local
-- (ahí `admin` es superusuario del cluster embebido).
create table public.rate_limit_bucket (
  key text primary key,
  count integer not null default 0 check (count >= 0),
  reset_at timestamptz not null,
  updated_at timestamptz not null default now()
);
-- Consulta operativa esperada (limpieza periódica opcional, no automática todavía --
-- ver comentario de `PostgresRateLimitStore`): buckets cuya ventana ya expiró.
create index rate_limit_bucket_reset_at_idx on public.rate_limit_bucket (reset_at);

grant select, insert, update on public.rate_limit_bucket to atiende_app;
