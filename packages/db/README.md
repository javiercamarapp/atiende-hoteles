# @atiende-hoteles/db

Esquema core, migraciones versionadas, runner idempotente, seeds de desarrollo y
utilidades de los dos motores de persistencia local (ADR-003, `docs/ARQUITECTURA.md`):

- **PGlite** (`@electric-sql/pglite`): unit tests rápidos de RLS/lógica, sin concurrencia
  real (serializa todo internamente).
- **`embedded-postgres`** (Postgres 18.4 real): integración/concurrencia real (advisory
  locks, idempotencia bajo contención real entre dos conexiones de sistema operativo
  distintas).

El mismo SQL de `migrations/*.sql` corre sin reescritura contra ambos motores y, en el
futuro, contra un proyecto Supabase real (mismo patrón de claims: `auth.uid()`,
`current_setting('request.jwt.claim.sub', true)`).

## Estructura

```
packages/db/
├── migrations/           # 0001_....sql .. 0012_....sql, expand-only (REQ-GOB-010)
├── src/
│   ├── types.ts          # contrato DbClient compartido por ambos motores
│   ├── engines.ts        # openPglite() / openEmbeddedPostgres()
│   ├── runner.ts         # applyMigrations() / dropAllMigratedObjects()
│   ├── seed.ts           # seedDev(): datos de desarrollo
│   ├── cli.ts            # `migrate` | `reset` | `seed` (usa embedded-postgres real)
│   └── index.ts          # barrel export (`@atiende-hoteles/db`)
└── README.md
```

## Cómo correr todo

Desde la raíz del monorepo (usa `npm workspaces`, Node >=22, probado con Node 25.6.1):

```bash
npm install

# Aplica las migraciones contra un Postgres real embebido, persistido en
# packages/db/.pgdata (gitignored). Idempotente: correrlo dos veces no reaplica nada.
npm run db:migrate

# Borra todo el esquema (public + auth + roles) y vuelve a aplicar las migraciones desde
# cero. ÚSALO SOLO EN DESARROLLO: borra los datos del data dir configurado.
npm run db:reset

# Siembra los datos de desarrollo (2 hoteles, tipos de habitación, habitaciones, tarifas
# y disponibilidad de 30 días, 2 usuarios por hotel con roles distintos).
node packages/db/src/cli.ts seed
```

Variables de entorno opcionales para el CLI (`packages/db/src/cli.ts`):

| Variable | Default | Uso |
|---|---|---|
| `DB_DATA_DIR` | `packages/db/.pgdata` | Directorio de datos del Postgres embebido (persistente entre corridas). |
| `DB_PORT` | `54329` | Puerto TCP local del Postgres embebido. |

## Pruebas

```bash
# Vitest + PGlite (rápido, sin proceso de SO, sin concurrencia real).
npm run test:unit

# Vitest + embedded-postgres (Postgres real, concurrencia/contención real).
# Se corre con --pool=forks --poolOptions.forks.singleFork para que los archivos de
# integración no compitan entre sí por puertos/datadirs del mismo proceso worker.
npm run test:integration
```

Los fixtures compartidos viven en `tests/support/pglite-fixture.ts` y
`tests/support/pg-fixture.ts`: abren el motor correspondiente, aplican todas las
migraciones desde cero y siembran los datos de desarrollo antes de cada suite.

## Roles y conexión (ADR-003/ADR-004)

- `atiende_app`: rol de **login** que usa el pool de conexiones del backend
  (equivalente al `authenticator` de PostgREST/Supabase). **Sin BYPASSRLS**, sin
  superusuario. Contraseña de desarrollo local fija (`atiende_app_dev_only_local`,
  ver `migrations/0001_extensions_and_auth.sql`) — nunca se usa fuera de PGlite/
  `embedded-postgres` en esta máquina.
- `authenticated`: rol **sin login** al que se conmuta por transacción
  (`set local role authenticated` + `select set_config('request.jwt.claim.sub', ...)`),
  mismo nombre y mismo patrón de claims que usa Supabase/`atiende-restaurantes`, para
  que las mismas políticas RLS sean portables 1:1 contra un proyecto Supabase real.
- El runner de migraciones y los seeds corren con el rol **owner/superusuario** del
  motor (`postgres` en `embedded-postgres`, el rol implícito de PGlite), que
  **bypassa RLS** por ser dueño de las tablas — nunca se usa así en producción.

## Esquema (H1)

`org` → `location` (kind=`hotel`|`restaurant`) → `hotel` (1:1 con `location`,
kind forzado por trigger) → `room_type` / `room` / `rate_plan` / `availability`
(única por `(hotel_id, room_type_id, date)`) → `reservation` (máquina de estados con
tabla `reservation_status_transition` + trigger, bitácora en
`reservation_status_event`) → `guest`, `folio` / `charge` / `payment` (dinero siempre
`numeric(12,2)`, reverso vía `charge.reversed_by`), `staff_user` / `hotel_staff` (8 roles
de `REQ-TEN-003`), `audit_log` (append-only, hash encadenado por tenant),
`outbox` (drenado por un worker futuro, H2), `idempotency_key`
(`UNIQUE (tenant_id, scope, key)`).

RLS habilitada en todas las tablas de tenant, con `REVOKE ALL FROM PUBLIC` explícito y
grants mínimos otorgados solo al rol `authenticated` (ver `migrations/0010_grants_and_lockdown.sql`).
`housekeeping`/`maintenance` quedan explícitamente sin acceso a `folio`/`charge`/`payment`
(`can_access_money()`).

## Cambios de H2 (`apps/api`, expand-only sobre H1)

- `migrations/0011_staff_auth_and_idempotency_hash.sql`: agrega `staff_user.password_hash`
  (login por email/contraseña, ver `src/password.ts` — `scrypt`, no `argon2id`, para no
  sumar una dependencia nativa) con GRANT por columnas explícito (ningún compañero de
  hotel puede leer el hash de otro vía RLS); agrega `idempotency_key.request_hash` +
  `GRANT UPDATE`/policy de UPDATE (patrón de reclamo-antes-de-mutar de
  `apps/api/src/lib/idempotency.ts`).
- `migrations/0012_audit_log_sequence.sql`: agrega `audit_log.seq` (identity monótona)
  para desempatar la fila "anterior" del hash encadenado sin depender de `id` (UUID
  aleatorio) cuando dos inserciones del mismo tenant comparten `created_at` — corrige un
  flake real detectado en `tests/unit/audit-log.spec.ts` (bug pre-existente de H1, no
  cambia la fórmula del hash en sí, solo cómo se localiza la fila previa).
- `DEV_SEED_PASSWORD` (export de `src/seed.ts`): contraseña de desarrollo compartida por
  todos los usuarios sembrados (`atiende-dev-2026`), documentada en `apps/api/README.md`.
  `seedDev()` ahora crea los 8 roles de `REQ-TEN-003` por hotel (antes solo `gm`/
  `housekeeping`) para poder probar la matriz de roles completa en H2.
- `openEmbeddedPostgres()` acepta `{databaseDir, port, persistent}` opcionales (antes
  siempre efímero/aleatorio) para que `apps/api/src/db.ts` pueda levantar un servidor de
  desarrollo persistente reutilizando exactamente el mismo motor que las pruebas.

## Qué falta (fuera de alcance de H1, declarado explícitamente)

- `pms_mirror` (REQ-GOB-013): no existe todavía — no hay conector PMS que escriba ahí.
  Se construye en H4/H5 junto con el conector PMS real.
- Bóveda de identidad aislada para `guest.identity_ref` (REQ-REC-011): la columna existe
  como puntero, la bóveda en sí no se construye en H1.
- RPC `SECURITY DEFINER` para escritura anónima con recálculo server-side de precio
  (REQ-TEN-004): es una pieza de la capa HTTP (H2, Hono), no del esquema en sí.
- `housekeeping_task` / `maintenance_ticket`: quedan para H6 (no forman parte del listado
  explícito de tablas de H1).

## Cambios de H6b (migraciones 0040-0045, expand-only sobre H1-H4)

- `room.housekeeping_status` (enum `sucia|limpia|inspeccionada|fuera_de_servicio`) +
  `room_housekeeping_status_event` (historial append-only, trigger `SECURITY DEFINER`,
  mismo patrón que `reservation_status_event`) — **distinto** de `room.status` (H1,
  disponibilidad/venta): una habitación puede estar "disponible" para reservar y "sucia"
  para housekeeping a la vez.
- `housekeeping_task`: RLS — housekeeping solo ve/opera SUS tareas asignadas
  (`assigned_to = auth.uid()`); owner/gm/frontdesk ven/administran todas del hotel.
- `agent_approval` / `agent_approval_confirmation`: respaldo persistente de
  `ApprovalQueue` (`@atiende-hoteles/agent-core`, ver su README §H6b) — decidir
  (`UPDATE`) reservado a owner/gm. `0045` agrega `input_json` (el input real ya validado
  que recibió la tool, para que `apps/api` pueda ejecutarla tras completarse la doble
  confirmación fuera de una corrida de agente).
- `maintenance_ticket`: origen huésped/staff/agente/sensor, `approval_id` enlaza con
  `agent_approval` cuando el cierre exige autorización de gasto. RLS: housekeeping puede
  REPORTAR (insert) pero solo ve/edita sus PROPIOS reportes (`created_by = auth.uid()`,
  necesario ademas para que `INSERT ... RETURNING` no choque con la política de SELECT,
  ver comentario en `0043_maintenance_ticket.sql`); nunca ve/cambia el costo de tickets
  ajenos.
- `hotel_messaging_config` / `conversation` / `message`: bandeja de WhatsApp por huésped
  sobre `packages/mcp-servers/whatsapp` (siempre `FakeWhatsappAdapter` en este hito,
  `message.simulated=true`); `transactional_templates` decide qué plantillas se
  auto-aprueban sin espera humana. Índices únicos por hotel para idempotencia de envío
  (`client_message_id`) y de webhook (`external_message_id`).
