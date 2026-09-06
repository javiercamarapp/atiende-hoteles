# Corrección de hallazgos — auditoría 1, base de datos / seguridad multi-tenant

Método Likida aplicado hallazgo por hallazgo, en orden CRÍTICO → ALTO → MEDIO → BAJO,
sobre `docs/auditoria-1/seguridad.md`, `docs/auditoria-1/datos.md`,
`docs/auditoria-1/backend.md` (solo los ALTO/MEDIO que H4 no había cerrado) y
`docs/auditoria-1/pruebas.md` (solo el ALTO/MEDIO asignados a este frente). Para cada
hallazgo cerrado: verificación → prueba que lo reproduce (roja) → arreglo mínimo →
verde → suite completa verde → commit `fix(aud-1/bd): ...`. Migraciones nuevas
`0016`–`0023` (expand-only, ninguna migración ya aplicada se editó). Rango asignado a
este frente: `0016`–`0029`; H5 usa `0030+`, H6b usa `0040+`.

## `docs/auditoria-1/seguridad.md`

| Hallazgo | Estado |
|---|---|
| **[CRÍTICO] S-C1** `record_audit_log()` (SECURITY DEFINER) permite falsificar el audit_log de cualquier organización | **Arreglado** `6eb87fe` — migración `0016`: valida `_tenant_id`/`_hotel_id` contra `current_tenant_ids()`/`current_hotel_ids()` del actor de sesión SOLO cuando existe un actor real (`auth.uid()` no nulo) — no rompe `cancel_reservation_public()`/runner/seed (llamadas sin sesión, ya autorizadas por su cuenta). Reproducido y cerrado con sesión RLS real: `tests/adversarial/auditoria-1-bd-criticos.spec.ts` (housekeeping ya no puede firmar audit_log de un org/hotel ajeno; un owner de un hotel tampoco puede firmar a nombre de otro hotel de su propio org). |
| **[CRÍTICO] S-C2** `outbox`/`idempotency_key` solo aíslan por organización, no por hotel ni por rol | **Arreglado** `ea0269e` — migración `0017`: las policies ahora exigen además `hotel_id = any(current_hotel_ids())` y `can_access_money(hotel_id)` (mismo criterio que `folio`/`charge`/`payment`, 0007) para `outbox`; `idempotency_key` (sin columna `hotel_id`) exige rol de dinero en el org. Los roles reales que escriben aquí (`MANAGE_RESERVATIONS_ROLES` ⊂ `MONEY_ROLES`) no se rompen. Verificado en `tests/adversarial/auditoria-1-bd-criticos.spec.ts`. |
| **[MEDIO]** CORS sin restricción de origen en toda la API | **Pendiente** — fuera del mandato explícito de este frente (BD/seguridad multi-tenant); vive en `apps/api/src/app.ts`, corresponde al frente backend/API. No tocado. |
| **[BAJO]** Límite de tasa en memoria de proceso, sin compartir entre instancias | **Pendiente** — mismo criterio: vive en `apps/api/src/lib/rateLimit.ts`, deuda ya declarada en el propio código; no está en la lista de hallazgos asignados a este frente. |

## `docs/auditoria-1/datos.md`

| Hallazgo | Estado |
|---|---|
| **[CRÍTICO] D-C1** `room_type_id` en `room`/`rate_plan`/`availability`/`reservation` no está scoped a `hotel_id` (FK simple, no compuesta) | **Arreglado** `ea0269e` — migración `0018`: `room_type(hotel_id, id)` único + FK compuesta `(hotel_id, room_type_id) references room_type(hotel_id, id)` en las 4 tablas (mismo `ON DELETE` que la FK simple original), más índices de apoyo. La invariante queda impuesta por el ESQUEMA, no solo por RLS/aplicación — ni siquiera el cliente admin puede insertar una combinación cruzada. Verificado en `tests/adversarial/auditoria-1-bd-criticos.spec.ts` (sesión RLS real Y cliente admin, ambos rechazados). |
| **[CRÍTICO] D-C2** `hotel_staff.org_id` no se valida contra `hotel.org_id` real | **Arreglado** `ea0269e` — migración `0019`: trigger `hotel_staff_derive_org_id_trg` (BEFORE INSERT/UPDATE) SOBRESCRIBE `org_id` siempre con el valor real derivado de `hotel_id` — cualquier valor que la sesión intente fijar se descarta, no solo se rechaza. Verificado: un owner real que intenta dar de alta un colega con `org_id` de un org ajeno obtiene la fila igual, pero con `org_id` correcto; el nuevo usuario nunca ve el org ajeno. |
| **[ALTO]** La cadena de hash de `audit_log` se bifurca bajo escritura concurrente del mismo tenant | **Ya cerrado por H4** (migración `0015`, commit `8552439` en el historial previo a este frente) con `audit_log_chain_head` + `SELECT ... FOR UPDATE`. Confirmado de nuevo por este frente ejecutando `tests/integration/audit-log-concurrencia.spec.ts` (20 escrituras concurrentes × 8 rondas contra `embedded-postgres` real, sin bifurcación) como parte de la suite completa corrida en cada commit de este frente — no fue necesario reabrir ni escribir una prueba adicional, la existente ya cubre el escenario de concurrencia real exigido. |
| **[MEDIO]** El worker de outbox no tiene un índice que sirva su propia consulta (Seq Scan garantizado a escala) | **Arreglado** `163276c` — migración `0021`: índice `(status, created_at)` (la consulta real del worker filtra por `status` y ordena por `created_at`, sin `tenant_id`). Verificado con `EXPLAIN` real sobre 8,000 filas: `tests/integration/outbox-worker-indice.spec.ts` confirma la ausencia de `Seq Scan on outbox`. |
| **[MEDIO]** `idempotency_key` no tiene TTL ni columna de expiración | **Arreglado** `163276c` — migración `0022`: columna `expires_at` (7 días desde la creación) + `apps/api/src/lib/idempotency.ts` reclama atómicamente una llave expirada vía `ON CONFLICT ... DO UPDATE ... WHERE expires_at < now()` (se comporta como el `DO NOTHING` original si la fila sigue vigente). Verificado en `tests/integration/idempotency-ttl.spec.ts` (expira → se puede reclamar de nuevo con un cuerpo distinto sin 422; vigente → sigue rechazando cuerpo distinto con 422 como antes). No se implementó todavía un job de purga por lote (la columna/índice ya lo dejan listo) — documentado como siguiente paso, no simulado. |
| **[MEDIO]** Ninguna tabla del dominio hotelero registra la zona horaria del hotel | **Arreglado (cimiento)** `163276c` — migración `0023`: `hotel.timezone` (IANA, default `America/Mexico_City`, CHECK de forma básica). No se conectó a ninguna lógica de negocio nueva porque, como el propio informe documenta, todavía no existe código (night audit/reportes diarios) que dependa de esto — se deja el cimiento correcto para cuando se construya, sin inventar lógica. Verificado en `tests/unit/schema/hotel-timezone.spec.ts`. |

## `docs/auditoria-1/backend.md` (solo lo que H4 no había cerrado)

Confirmado con `git log`/lectura del código actual que H4 ya había cerrado, antes de
este frente: cancelación no libera inventario (`release_availability`, commits previos),
noche sin tarifa cobrada en $0 (`quoteNetAmount`/`QuoteError sin_tarifa`, `domain-hotel`),
falta de camino para crear folio (`reservas.ts` crea folio al confirmar), y la
bifurcación de hash de audit_log (0015). Quedaban abiertos exactamente los dos que el
encargo de este frente señaló explícitamente:

| Hallazgo | Estado |
|---|---|
| **[ALTO]** El worker de outbox descarta la causa real del error (`catch {}` sin nombrar la variable) y no aplica timeout por handler | **Arreglado** `1b75dec` — migración `0020` agrega `outbox.last_error`; `drainOutboxOnce()` (`apps/api/src/outbox/worker.ts`) ahora captura el mensaje real del error y lo persiste en cada reintento/dead-letter, y corre cada `handler(row)` bajo `withTimeout()` (`handlerTimeoutMs`, default 10s) para que un handler colgado no bloquee el resto del batch, con la promesa abandonada blindada contra "unhandled rejection". Verificado en `tests/unit/api/outbox-worker.spec.ts` (3 pruebas nuevas: causa real en retry, causa real en dead-letter, handler colgado no bloquea el batch). |
| **[MEDIO]** Cada request abre una conexión Postgres nueva, sin pool ni timeout | **Arreglado** `30b0f75` — `packages/db/src/engines.ts`: `withAppSession()` usa un `pg.Pool` de proceso (tamaño/timeouts configurables) en vez de `new pg.Client()` por llamada; los claims de sesión siguen con alcance de TRANSACCIÓN (`set local`), descartados por Postgres al hacer commit/rollback antes de que la conexión física vuelva al pool. Verificado con `poolMax: 1` (fuerza la reutilización de la MISMA conexión física entre dos sesiones consecutivas de hoteles distintos): `tests/integration/pool-sin-fuga-de-claims.spec.ts` confirma que no hay fuga de `auth.uid()`/membresías entre requests reciclados. La suite de concurrencia real (advisory locks) sigue verde sin cambios. |

## `docs/auditoria-1/pruebas.md` (solo lo asignado a este frente)

| Hallazgo | Estado |
|---|---|
| **[ALTO]** `npm test` no ejecuta `tests/adversarial` ni E2E; una regresión de aislamiento/rol podía mergearse sin gate | **Arreglado** `03220e7` — `package.json`: `"test": "npm run test:unit && npm run test:integration && npm run test:adversarial"`. E2E se deja fuera a propósito (requiere navegador/servidor levantado aparte, ya tiene su propio comando en `apps/web`). |
| **[MEDIO]** La prueba "Paridad visual" (`tests/e2e/paridad-visual.spec.ts`) solo guarda una captura, no compara contra ninguna referencia | **`pendiente`** — corresponde al frente frontend (instrucción explícita de este encargo: dejarlo pendiente para ese frente). No tocado. |

## Verificación final de este frente

- `npm run lint` — limpio (`docs/logs/aud1-bd-lint-20260906-075050.log`; 1 warning
  preexistente en `tests/e2e/paridad-restaurantes-login.spec.ts`, no relacionado con
  este frente).
- `npm run typecheck` — limpio (`docs/logs/aud1-bd-typecheck-20260906-075050.log`).
- `npm test` (unit 311, integration 44, adversarial 66 — 421 pruebas, todas verdes) —
  `docs/logs/aud1-bd-test-20260906-075050.log`.
- `npm run build` — verde, `apps/api` + `apps/web` (`docs/logs/aud1-bd-build-20260906-075050.log`).
- Migraciones nuevas: `0016_record_audit_log_valida_actor.sql`,
  `0017_outbox_idempotency_scope_hotel_y_rol.sql`,
  `0018_room_type_id_fk_compuesta_por_hotel.sql`, `0019_hotel_staff_org_id_derivado.sql`,
  `0020_outbox_last_error.sql`, `0021_outbox_worker_index.sql`,
  `0022_idempotency_key_ttl.sql`, `0023_hotel_timezone.sql` — todas expand-only, ninguna
  migración `0001`–`0015` (ya aplicada) fue editada.

## Pendientes (fuera del alcance de este frente, documentados, no tocados)

- **CORS sin restricción de origen** (seguridad.md MEDIO) y **rate limit en memoria sin
  compartir entre instancias** (seguridad.md BAJO): viven en `apps/api` fuera de la
  lista de hallazgos asignada a este frente (base de datos/seguridad multi-tenant);
  corresponden al frente backend/API.
- **Paridad visual sin comparación de píxeles** (pruebas.md MEDIO): dejado `pendiente`
  explícitamente para el frente frontend.
- **Purga por lote de `idempotency_key` expirada**: la columna `expires_at` y su índice
  ya existen (migración `0022`); falta el job/cron que ejecute
  `delete from idempotency_key where expires_at < now()` — no se construyó un
  scheduler nuevo en este frente (mismo criterio que el worker de outbox, que tampoco
  corre automáticamente todavía, documentado en `apps/api/README.md`).
- **`hotel.timezone`**: cimiento agregado (columna + CHECK), pero ningún código de
  negocio lo consume todavía (no existe night audit/reportes diarios en este snapshot,
  documentado explícitamente en `datos.md` como fuera del alcance de esta fase).
