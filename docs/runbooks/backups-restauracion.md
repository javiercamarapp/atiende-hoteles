# Runbook — Backups y restauración

ADR-008: "`pg_dump` programado contra el Postgres real (aplica a `embedded-postgres`
en desarrollo y a Supabase remoto en producción); no se implementa backup de PGlite
(es efímero, solo pruebas)".

## 0. Binarios cliente (`pg_dump`/`psql`/`pg_restore`)

El paquete npm `embedded-postgres` (usado en local, ADR-003) **no incluye** estos
binarios — solo trae `postgres`/`pg_ctl`/`initdb`
(`node_modules/@embedded-postgres/<plataforma>/native/bin/`, verificado el
2026-09-06; documentado como parte del hueco de toolchain B-002 de
`docs/BLOQUEOS.md`). `scripts/backup.sh`/`scripts/restore.sh` los buscan en este
orden:
1. `PG_DUMP_BIN`/`PG_PSQL_BIN`/`PG_RESTORE_BIN` (variables de entorno explícitas).
2. `PATH` (`which pg_dump` etc.) — así es como los encuentra un runner de CI
   `ubuntu-latest`, que trae `postgresql-client` de fábrica.
3. `/opt/homebrew/opt/libpq/bin/` (macOS con Homebrew) — instalado en esta máquina
   con `brew install libpq` (gratis, 100% local, keg-only: no se symlinkea a
   `/opt/homebrew/bin` porque choca con un `postgresql` completo).

Si ninguno existe, el script falla con un mensaje explícito indicando cómo instalarlo
— nunca intenta simular un dump con SQL hecho a mano.

## 1. Backup — Local (`embedded-postgres`, desarrollo/pruebas)

```bash
./scripts/backup.sh [directorio_de_salida]   # default: backups/ (gitignored)
```

Qué hace (`scripts/backup.ts`):
1. Si NO hay un servidor escuchando en `127.0.0.1:$DB_PORT` (default `54329`),
   arranca uno temporal apuntando al data dir persistente (`packages/db/.pgdata`) y
   lo detiene al terminar. Si ya había uno corriendo (ej. `npm run dev` de `apps/api`
   activo), lo reutiliza y lo deja vivo.
2. Corre `pg_dump -Fc` (formato "custom": comprimido, soporta restauración parcial y
   `pg_restore --no-owner` limpio) contra esa base.
3. Escribe `atiende-hoteles-postgres-<timestamp-ISO>.dump` en el directorio de salida.

Salida real verificada el 2026-09-06 (`docs/logs/h8-backup-restore-real.log`): dump de
144.0 KiB sobre una BD recién migrada+sembrada (23 tablas, 336 filas totales).

Frecuencia sugerida en un despliegue real de un solo desarrollador/piloto: antes de
cualquier `db:reset`, antes de aplicar una migración nueva contra datos reales, y como
mínimo diario si hay datos de un hotel piloto corriendo.

## 2. Restauración — Local (verificación real, "BD nueva y conteo igual")

```bash
./scripts/restore.sh backups/atiende-hoteles-postgres-<timestamp>.dump [nombre_bd_opcional]
```

Qué hace (`scripts/restore.ts`):
1. Crea una base de datos **NUEVA** (`restore_check_<epoch>` por default, o el nombre
   que se pase) en el MISMO cluster — **nunca sobrescribe la base origen**.
2. `pg_restore --no-owner --no-privileges` el dump ahí.
3. Cuenta filas reales (`select count(*)`, no el estimado `n_live_tup` de
   `pg_stat_user_tables`, que puede leer 0 justo después de un restore) por cada
   tabla de `public` en la base ORIGEN y en la RESTAURADA, y compara.
4. Imprime tabla por tabla `OK`/`DIFF` y un total; sale con código de error si algo no
   coincide.

Salida real verificada el 2026-09-06 (`docs/logs/h8-backup-restore-real.log`): 23
tablas, conteo idéntico en las 23 (336 filas cada lado) — `audit_log`,
`availability`, `hotel`, `hotel_staff`, `org`, `rate_plan`, `room`, `room_type`,
`schema_migrations`, `staff_user`, etc.

**Limpieza**: la base `restore_check_*` queda en el cluster de desarrollo tras la
verificación (para poder inspeccionarla a mano si algo no cuadró) — bórrala cuando ya
no la necesites: `psql -h 127.0.0.1 -p 54329 -U postgres -d postgres -c 'drop database "restore_check_...";'`.

## 3. Producción (Supabase, ADR-003)

`scripts/backup.sh`/`restore.sh` están escritos para el cluster embebido local —
en producción se usa `pg_dump`/`pg_restore` DIRECTO contra Supabase (que expone
Postgres real vía conexión directa, puerto 5432, o el "connection pooler" en modo
sesión para `pg_dump`):

```bash
# Backup (correr desde un entorno con acceso de red a Supabase, ej. un job de CI/CD
# con el secreto SUPABASE_DB_PASSWORD inyectado, nunca en texto plano en el repo):
PGPASSWORD="$SUPABASE_DB_PASSWORD" pg_dump \
  -h "$SUPABASE_DB_HOST" -p 5432 -U postgres -d postgres \
  -Fc -f "backups/supabase-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Restauración de verificación (SIEMPRE en un proyecto Supabase NUEVO/de prueba,
# nunca sobre producción):
PGPASSWORD="$SUPABASE_DB_PASSWORD_PROYECTO_NUEVO" pg_restore \
  -h "$SUPABASE_DB_HOST_PROYECTO_NUEVO" -p 5432 -U postgres -d postgres \
  --no-owner --no-privileges "backups/supabase-<timestamp>.dump"
```

Adicionalmente, Supabase gestionado ya incluye backups automáticos administrados por
el proveedor (frecuencia según el plan) — esto NO reemplaza esa capa, es el mecanismo
propio para (a) poder restaurar en un entorno controlado por el equipo sin depender
del panel de Supabase, y (b) verificar activamente que un dump propio sí restaura
(un backup nunca verificado no es un backup confiable).

Frecuencia en producción: diaria como mínimo, más frecuente (cada pocas horas) cuando
haya un hotel piloto con reservas/pagos reales — decisión pendiente de definir junto
con el runbook de guardia/on-call (`docs/runbooks/operacion.md` §7).

## 4. Qué NO se respalda (y por qué)

- **PGlite** (motor de las pruebas unitarias, ADR-003): en memoria, se destruye al
  terminar el proceso de prueba — nunca contiene datos reales, no aplica backup.
- **`.env`/secretos**: nunca van en un backup de BD; su respaldo/rotación se cubre en
  `docs/runbooks/operacion.md` §6 (rotación de secretos) — un backup de BD que
  incluyera secretos en columnas sin cifrar sería en sí mismo un hallazgo de
  seguridad (REQ-SEG-012/013).
- **Logs**: fuera del alcance de este runbook (se cubren por la retención del agregador
  de logs que se use en producción, no definido todavía en este repo).
