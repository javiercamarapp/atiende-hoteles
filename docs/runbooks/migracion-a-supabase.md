# Runbook — Migración de `embedded-postgres` a Supabase real

D-001 (`docs/BLOQUEOS.md`): producción **sigue siendo Supabase** (H20,
`docs/ARQUITECTURA.md` ADR-003) — este documento es el paso a paso para ejecutar esa
decisión cuando el fundador esté listo. **GOB-058**: los pasos marcados 👤 **USUARIO**
los ejecuta el fundador/operador desde su propia terminal con sus propias credenciales
— este repositorio (ni ningún agente) crea proyectos Supabase, ejecuta `supabase link`
ni corre `supabase db push` contra un proyecto real. Todo lo que un agente puede
preparar de antemano ya está hecho: `supabase/config.toml`, `supabase/migrations/`
(generadas por `scripts/export-supabase-migrations.ts`) y este runbook.

## 0. Qué ya está preparado (sin credenciales, verificado localmente)

| Pieza | Dónde | Verificado con |
|---|---|---|
| Config de Auth (email+Google, site_url/redirect por env) | `supabase/config.toml` | Lectura manual + sintaxis TOML válida |
| Migraciones portadas a Supabase | `supabase/migrations/*.sql` (generadas) | `node --experimental-strip-types scripts/export-supabase-migrations.ts --check`, `tests/unit/supabase-export.spec.ts` |
| Plantillas de correo de Auth (fallback de marca) | `supabase/templates/*.html` | Lectura manual (ver `supabase/templates/README.md`) |
| Backup/restore contra Supabase remoto | `docs/runbooks/backups-restauracion.md` §3 | Sintaxis de los comandos `pg_dump`/`pg_restore` documentada (ejecución real requiere el proyecto) |

## 1. 👤 USUARIO — Crear el proyecto Supabase

1. Crear el proyecto en https://supabase.com/dashboard (región cercana al público
   objetivo, ej. `us-east-1` si la mayoría de hoteles son de México/Caribe — Supabase
   no tiene región en México al momento de escribir esto).
2. Guardar, fuera de este repositorio (gestor de secretos, nunca un `.env` commiteado):
   - `SUPABASE_DB_HOST`, `SUPABASE_DB_PASSWORD` (Settings → Database → Connection string).
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Settings → API).
3. `supabase login` (CLI, autentica con el navegador — credencial personal del
   fundador, nunca compartida con un agente).

## 2. 👤 USUARIO — `supabase link`

```bash
supabase link --project-ref <ref-del-proyecto>
```

Esto escribe `project_id` en `supabase/config.toml` (hoy vacío a propósito, ver
comentario en ese archivo) y sincroniza el proyecto remoto con la CLI local.

## 3. 👤 USUARIO — Variables de entorno de Auth (antes de `db push`)

`supabase/config.toml` referencia estas variables como `env(...)` (nunca hardcodeadas,
para que el mismo archivo sirva para preview y producción):

| Variable | Ejemplo (no secreto) | Dónde se configura |
|---|---|---|
| `SUPABASE_AUTH_SITE_URL` | `https://app.atiendehoteles.com` | `supabase secrets set` o `.env` local de la CLI antes de `supabase link`/`db push` |
| `SUPABASE_AUTH_REDIRECT_URL` | `https://app.atiendehoteles.com/login` | igual |
| `SUPABASE_AUTH_GOOGLE_CLIENT_ID` | (del proyecto OAuth de Google, H12a) | igual — **secreto** |
| `SUPABASE_AUTH_GOOGLE_SECRET` | — | igual — **secreto** |
| `SUPABASE_AUTH_GOOGLE_REDIRECT_URI` | `https://<project-ref>.supabase.co/auth/v1/callback` | igual |

Ver `deploy/env-matrix.md` para la matriz completa (incluye qué es secreto y en qué
sistema vive cada variable — Vercel, Supabase, o ninguno de los dos).

## 4. Regenerar `supabase/migrations/` si hubo cambios desde la última exportación

```bash
node --experimental-strip-types scripts/export-supabase-migrations.ts          # regenera
node --experimental-strip-types scripts/export-supabase-migrations.ts --check  # verifica (usado en CI)
```

Qué hace exactamente (ver cabecera de `scripts/export-supabase-migrations.ts`): copia
cada migración de `packages/db/migrations/` tal cual, **excepto** la primera
(`0001_extensions_and_auth.sql`), donde omite la emulación LOCAL de `auth.uid()`/schema
`auth` (Supabase ya los trae vía GoTrue) y ajusta la creación de roles: no recrea
`authenticated`/`anon`/`service_role` (ya existen), solo crea `atiende_app` (el rol de
LOGIN propio del backend) y le otorga `authenticated`. Cada archivo generado conserva,
en su encabezado, el hash sha256 del archivo fuente — `tests/unit/supabase-export.spec.ts`
falla si algo queda desincronizado.

## 5. 👤 USUARIO — `supabase db push`

```bash
supabase db push
```

Aplica `supabase/migrations/*.sql` (las YA transformadas del paso 4, nunca las de
`packages/db/migrations/` directamente) contra el proyecto remoto. **Este agente nunca
ejecuta este comando** (GOB-058) — queda para que el fundador lo corra con sus propias
credenciales, después de revisar el diff de migraciones si lo desea.

## 6. 👤 USUARIO — Contraseña real de `atiende_app`

La migración transformada (`supabase/migrations/0001_...sql`) crea el rol `atiende_app`
con un placeholder que **no debe usarse en producción**. Inmediatamente después de
`db push`, desde `psql`/el SQL Editor de Supabase Studio:

```sql
alter role atiende_app with password '<contraseña real, ej. `openssl rand -base64 32`>';
```

Guardar esa contraseña real como `SUPABASE_DB_PASSWORD_APP` (o el nombre que use el
secreto de Vercel/el host del API) — **nunca** commitear esta contraseña a git.

## 7. Plantillas de correo de Auth

`supabase/config.toml` ya apunta `[auth.email.template.*]` a `supabase/templates/*.html`
(fallback de marca mínimo, ver `supabase/templates/README.md`). Si para este momento
`packages/email` (H12a) ya existe con un shell de correo (`renderCorreo()`/similar),
regenerar esos 5 archivos con ese shell antes de vincular — mismo criterio de "un solo
lugar de verdad para el shell de correo" que el resto del repo. Verificar visualmente en
Supabase Studio → Authentication → Email Templates después de `db push`, no solo por
lectura del HTML.

## 8. Migrar datos existentes desde `embedded-postgres` (si hay datos reales que conservar)

Si el hotel ya operó sobre el Postgres embebido local/de staging (no el seed de
desarrollo) y hay datos reales que preservar:

```bash
# 1) Backup del embedded-postgres de origen (ver docs/runbooks/backups-restauracion.md §1)
./scripts/backup.sh backups/

# 2) 👤 USUARIO: restaurar ese dump contra el proyecto Supabase (pg_restore acepta el
#    formato -Fc que produce scripts/backup.ts sin cambios) -- EJEMPLO, adaptar host/
#    usuario/base a los del proyecto real:
PGPASSWORD="$SUPABASE_DB_PASSWORD" pg_restore \
  -h db.<project-ref>.supabase.co -p 5432 -U postgres -d postgres \
  --no-owner --role=postgres \
  backups/atiende-hoteles-postgres-<timestamp>.dump

# 3) Verificar conteos de filas por tabla ANTES y DESPUÉS (docs/runbooks/
#    backups-restauracion.md documenta el hallazgo LAUNCH-003: restore.sh corregido
#    para no reportar "conteo igual" sobre un backup vacío -- repetir esa misma
#    verificación explícita aquí, tabla por tabla, no solo confiar en el exit code).
```

`--no-owner` es obligatorio: el dump fue creado con el rol `postgres` del cluster
embebido local, que no existe en Supabase con los mismos privilegios — `pg_restore`
reasigna la propiedad al rol de conexión (`postgres` del proyecto Supabase) en vez de
fallar por un `ALTER ... OWNER TO` a un rol inexistente.

## 9. Salud post-migración

```bash
curl https://<tu-api-de-producción>/health
curl https://<tu-api-de-producción>/ready   # confirma migrationsApplied > 0
```

`apps/api` debe apuntar su `pg.Pool` de producción a `SUPABASE_DB_HOST`/
`SUPABASE_DB_PASSWORD_APP` (ver `deploy/env-matrix.md`) en vez de arrancar
`embedded-postgres` — esa rama de `apps/api/src/db.ts` sigue pendiente hasta que el
fundador confirme el proyecto real (no tiene sentido escribirla y dejarla sin ejercitar
contra nada).

## 10. Lo que solo se puede verificar CON Docker/Supabase CLI real (PENDIENTE)

Esta máquina no tiene Docker/`supabase` CLI funcional (`docs/BLOQUEOS.md` B-002) — lo
de abajo quedó preparado y verificado de forma **estática** (sin ejecutar contra un
Postgres/GoTrue real), pero necesita repetirse cuando exista el proyecto real:

- **PENDIENTE**: `supabase db push` real contra un proyecto — hoy solo se verificó que
  `supabase/migrations/*.sql` no contiene objetos prohibidos y conserva su hash de
  origen (prueba estática, `tests/unit/supabase-export.spec.ts`), no que el SQL
  aplica sin error contra un Postgres 15 con GoTrue instalado.
- **PENDIENTE**: que `auth.uid()` real de GoTrue (JWT de Supabase Auth, claims
  `request.jwt.claims`) sea 100% compatible con las políticas RLS escritas contra la
  emulación local (`current_setting('request.jwt.claim.sub', true)`) — ambas leen el
  mismo claim `sub`, pero la firma/verificación completa del JWT y el resto de
  `request.jwt.claims` (rol, `aud`, etc.) solo se puede comparar con GoTrue real.
- **PENDIENTE**: que el flujo de Google OAuth (H12a) complete el `redirect_uri` exacto
  que Supabase expone (`https://<project-ref>.supabase.co/auth/v1/callback`) — el
  valor real de `<project-ref>` no existe hasta el paso 2.
- **PENDIENTE**: verificación end-to-end de `pg_restore` (paso 8) contra un proyecto
  Supabase real — la sintaxis del comando está documentada y probada contra
  `embedded-postgres` (`docs/runbooks/backups-restauracion.md`), no contra Supabase.
- **PENDIENTE**: performance/latencia real de RLS con `pg_advisory_xact_lock` bajo la
  red de Supabase (vs. loopback local) — la lógica de concurrencia ya se verificó
  contra `embedded-postgres` real (ADR-003), pero no contra latencia de red real.
