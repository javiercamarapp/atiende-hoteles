# Runbook — Migraciones

Patrón: **expand-only** (GOB-011/REQ-QA-007/REQ-GOB-010). Nunca se edita un archivo de
`packages/db/migrations/*.sql` ya mergeado a `main`; todo cambio de esquema es una
migración NUEVA con el número consecutivo más alto.

## 1. Rangos asignados por frente (evitar colisiones entre agentes en paralelo)

Registrado en el despacho de H8 (coordinación entre agentes trabajando en worktrees
simultáneos sobre el mismo repo):

| Rango | Frente | Rutas asociadas |
|---|---|---|
| `0001`-`0023` | ya mergeado (H1-H7/auditoría-1 BD) | núcleo (org/hotel/reservation/folio/audit_log/outbox) |
| `0024`-`0029` | H8 (observabilidad/CI/runbooks) | reservado, sin usar (este hito no necesitó cambios de esquema) |
| `0030`+ | H5 | folios/night-audit/CFDI |
| `0040`+ | H6b | housekeeping/mantenimiento/aprobaciones/mensajería |

Antes de crear una migración nueva: confirmar el rango del frente actual y el número
más alto YA EXISTENTE en el árbol (`ls packages/db/migrations/`) — el siguiente
consecutivo dentro del rango asignado, nunca reutilizar un número.

## 2. Cómo crear una migración nueva

1. Archivo: `packages/db/migrations/NNNN_descripcion-corta.sql` (4 dígitos,
   guion-bajo, minúsculas, mismo estilo que las existentes).
2. Encabezado de comentario: qué hito la trae y por qué (mismo estilo que
   `0020_outbox_last_error.sql`, `0023_hotel_timezone.sql`, etc.) — facilita el
   `grep` de "por qué existe esta columna" meses después.
3. Contenido: **expand** primero. Añadir columnas/tablas NUEVAS con default o
   nullable (nunca `NOT NULL` sin default sobre una tabla con filas existentes sin
   backfill previo). RLS/políticas nuevas siguen el patrón de `0003_membership_and_
   rls_helpers.sql` (funciones `current_tenant_ids()`/`has_hotel_role()`, nunca un
   valor de sesión sin verificar).
4. `npm run db:reset && npm run db:migrate` (local) para confirmar que aplica desde
   cero sin error.
5. `npm run check:migraciones` (`scripts/check-migraciones.ts`) — falla si:
   - el archivo de una migración YA en el manifiesto base
     (`scripts/checks/migraciones-checksums.json`) cambió de contenido (protección
     estática, sin necesitar BD — complementa la protección en runtime de
     `packages/db/src/runner.ts::applyMigrations`, que lanza `migracion_modificada`
     si el checksum de una migración ya aplicada no coincide).
   - la migración NUEVA contiene `DROP COLUMN`/`DROP TABLE`/`TRUNCATE`/
     `ALTER COLUMN ... TYPE` sin un comentario `-- CONTRACT-APPROVED: <justificación>`
     en el mismo archivo.
6. Una vez el PR se mergea a `main`, regenerar el manifiesto base para que la
   migración recién mergeada quede "congelada" contra ediciones futuras:
   ```bash
   node --experimental-strip-types scripts/check-migraciones.ts --write
   git add scripts/checks/migraciones-checksums.json
   ```
   (esto se hace UNA VEZ, justo después de mergear — nunca antes, y nunca como parte
   de un PR que todavía puede cambiar).

## 3. Fase "contract" (DROP real de una columna/tabla con datos)

Patrón expand → migrate → contract:
1. **Expand**: migración que añade la columna/tabla nueva (nullable o con default).
2. **Migrate**: backfill de datos existentes hacia la columna/tabla nueva (puede ser
   una migración SQL con `UPDATE ... WHERE nueva_columna IS NULL`, por lotes si la
   tabla es grande) + el código de aplicación empieza a escribir en AMBOS lados
   (viejo y nuevo) durante la transición.
3. **Contract**: una vez confirmado que el backfill llegó a 0 filas pendientes y que
   ningún código sigue leyendo la columna vieja, una migración nueva hace el `DROP`
   real. Este archivo DEBE incluir el marcador:
   ```sql
   -- CONTRACT-APPROVED: backfill verificado en docs/logs/<archivo>.log (N filas,
   -- 0 pendientes al <fecha>); código de aplicación ya no lee/escribe la columna vieja
   -- desde el commit <hash>.
   drop table ...; -- o alter table ... drop column ...;
   ```
   Sin ese marcador, `scripts/check-migraciones.ts` bloquea el merge (o, si la
   migración ya fue mergeada sin el marcador en el pasado, el check la reporta como
   **advertencia** de deuda heredada, no como error bloqueante retroactivo).

## 4. Qué hacer si `applyMigrations` falla con `migracion_modificada`

Significa que el checksum guardado en `schema_migrations` (BD) para un archivo no
coincide con el contenido actual de ese archivo en disco — alguien editó una
migración ya aplicada. Nunca "arreglar" borrando la fila de `schema_migrations` a
mano para forzar el re-aplicado: eso oculta el problema real (los estados
"debería tener este esquema" y "el archivo dice esto otro" quedan de todos modos
divergentes entre entornos que aplicaron la versión vieja vs. la nueva). En su lugar:
1. Revertir el archivo editado a su contenido original (`git checkout -- packages/db/migrations/NNNN_....sql`).
2. Crear una migración NUEVA con el cambio que realmente se quería hacer.

## 5. Migraciones y RLS (recordatorio, no específico de este runbook pero crítico)

Cualquier tabla nueva con datos de tenant/hotel DEBE llevar `tenant_id`/`hotel_id` +
política RLS desde la misma migración que la crea (nunca "la añado después") — el
patrón ya establecido en `0004_room_inventory.sql`/`0006_reservation.sql`/
`0007_folio.sql` (RLS doble-acotada `tenant_id` **y** `hotel_id`/`has_hotel_role()`).
Una tabla sin RLS es, por default, invisible para `authenticated` (falla cerrado) salvo
que se otorgue `GRANT` explícito — pero documentar la intención en la migración evita
que alguien añada el `GRANT` sin la política.
