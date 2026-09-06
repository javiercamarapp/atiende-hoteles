# @atiende-hoteles/api

Backend HTTP de Atiende Hoteles (H2, ADR-004): [Hono](https://hono.dev) + TypeScript +
Node ≥22 (probado con Node 25.6.1), JWT propio (`jose`, HS256), RLS real de
`@atiende-hoteles/db` por transacción, idempotencia, advisory locks, outbox con
reintentos y rate limiting.

No hay paso de *build*/*bundle*: el servidor corre el TypeScript fuente directamente
con el *type stripping* nativo de Node (`node --experimental-strip-types`), igual que
`packages/db/src/cli.ts`. `npm run build` (raíz o en este paquete) solo tipa-chequea —
no genera `dist/`.

## Cómo correr

Desde la raíz del monorepo:

```bash
npm install

# Arranca un Postgres embebido persistente en apps/api/../../packages/db/.pgdata
# (compartido con `npm run db:migrate` de la raíz si no se cambia DB_DATA_DIR/DB_PORT),
# aplica migraciones y siembra datos de desarrollo SI la base está vacía.
npm run dev --workspace=@atiende-hoteles/api
# equivalente: cd apps/api && npm run dev
```

El servidor escucha en `PORT` (default `3001`). `GET /health` y `GET /ready` confirman
que está vivo y que la base respondió con migraciones aplicadas.

Para apuntar el frontend (`apps/web`) a este backend: `VITE_API_URL=http://localhost:3001`
al arrancar `npm run dev`/`vite dev` de `apps/web` (o en un `.env.local` de esa carpeta).

## Variables de entorno

| Variable | Default | Obligatoria en producción | Uso |
|---|---|---|---|
| `PORT` | `3001` | No | Puerto HTTP del servidor. |
| `JWT_SECRET` | secreto de desarrollo fijo (inseguro, solo si `NODE_ENV≠production`) | **Sí** | Firma/verificación HS256 de los JWT. Sin ella en producción, el arranque falla explícitamente (REQ-SEG-013: nunca un default silencioso). |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` (15 min) | No | Expiración del access token. |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` (30 días) | No | Expiración del refresh token. |
| `DB_DATA_DIR` | `packages/db/.pgdata` | No | Directorio de datos del Postgres embebido (persistente entre corridas, ADR-003). |
| `DB_PORT` | `54329` | No | Puerto TCP local del Postgres embebido. |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | `300` | No | Límite de solicitudes por IP y por minuto (ventana fija, en memoria). |
| `RATE_LIMIT_PER_USER_PER_MINUTE` | `600` | No | Límite de solicitudes por usuario autenticado y por minuto. |
| `LOG_LEVEL` | `info` | No | Nivel de `pino`. |
| `LOG_PRETTY` | (sin definir) | No | `1` para formato legible en desarrollo (`pino-pretty`); en producción siempre JSON. |

## Credenciales de desarrollo (seed)

`packages/db/src/seed.ts` siembra **1 org** con **2 hoteles**, cada uno con **8 usuarios
de staff** (uno por cada rol de `REQ-TEN-003`: `owner, gm, frontdesk, reservations,
housekeeping, maintenance, fnb, accountant`), todos con la **misma contraseña de
desarrollo**: `atiende-dev-2026` (`DEV_SEED_PASSWORD`, exportada desde
`@atiende-hoteles/db` para que los tests la reutilicen sin hardcodearla dos veces).

Emails: `<rol>@hotel-demo-centro.demo` y `<rol>@hotel-demo-playa.demo` (ej.
`gm@hotel-demo-centro.demo`, `housekeeping@hotel-demo-playa.demo`).

Estas credenciales **nunca** deben usarse fuera de `embedded-postgres`/PGlite en esta
máquina — no hay ningún Postgres real ni proyecto Supabase conectado.

```bash
curl -s -X POST http://localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"gm@hotel-demo-centro.demo","password":"atiende-dev-2026"}'
```

## Auth (ADR-004)

- **Hash de contraseña**: `scrypt` de `node:crypto` (`packages/db/src/password.ts`), no
  `argon2id` — se evitó una dependencia nativa adicional que requiera compilación en una
  máquina sin Docker/toolchain de sistema verificado (`docs/BLOQUEOS.md` B-002). Formato
  versionado `scrypt$N$r$p$salt$hash` para poder subir el costo sin invalidar hashes
  viejos.
- **JWT** (`jose`, HS256): claims `{sub, org_id, hotel_ids, email, type}`, expiración
  corta (15 min) + refresh token separado (30 días, `POST /auth/refresh`). El `role` NO
  se embebe en el JWT: el rol/alcance real siempre se resuelve en vivo contra
  `hotel_staff` (RLS) en cada request, nunca contra un claim potencialmente obsoleto.
- **Sesión por request**: cada request a una ruta protegida abre una transacción nueva
  contra Postgres como rol `authenticated` (`set local role authenticated` +
  `set_config('request.jwt.claim.sub', <user_id>, true)`, ver
  `packages/db/src/engines.ts::withAppSession`), para que la RLS de `packages/db`
  aplique de verdad — no es una capa de autorización decorativa.
- **Selector de hotel activo**: el `hotelId` va en la ruta (`/hoteles/:hotelId/...`,
  mismo contrato que ya consumía `apps/web/src/lib/api.ts`); si además se envía el
  header `X-Hotel-Id`, debe coincidir con el de la ruta o la request se rechaza (403).
- **Sin "Continuar con Google"**: desvío intencional documentado en ADR-004 (JWT propio,
  no Supabase Auth) — mismo criterio ya anotado por H3 en `docs/PROGRESO.md`.

## Autorización en dos capas (REQ-TEN-003)

1. **Middleware de la API** (`src/middleware.ts`): `requireHotelMembership` (403 si el
   usuario no pertenece al hotel de la ruta) + `assertRole` (403 si su rol no está en la
   lista permitida para esa mutación — ej. solo `owner/gm/frontdesk/reservations` puede
   crear/transicionar reservas, solo roles con `can_access_money()` puede leer/escribir
   folios).
2. **RLS de `packages/db`** (irrenunciable, ver `migrations/0003..0010`): la misma
   restricción se re-verifica en Postgres vía `has_hotel_role()`/`can_access_money()`. Si
   la capa 1 tuviera un bug, la capa 2 sigue bloqueando el acceso (0 filas/violación de
   política), nunca al revés.

Probado exhaustivamente en `tests/adversarial/roles.spec.ts` (los 8 roles × ambas
capas) y `tests/adversarial/aislamiento-tenant-hotel.spec.ts` (tenant/hotel cruzado).

## Idempotencia (ADR-004)

`POST /hoteles/:id/reservas`, `POST /hoteles/:id/folios/:id/cargos` y
`POST .../pagos` **exigen** el header `Idempotency-Key`. Implementación en
`src/lib/idempotency.ts`:

- Se inserta primero un "reclamo" (`INSERT ... ON CONFLICT (tenant_id, scope, key) DO
  NOTHING`) con el hash SHA-256 del cuerpo, **antes** de correr la mutación, dentro de la
  MISMA transacción de sesión de la request.
- Misma clave + mismo cuerpo (incluso concurrente): la segunda solicitud espera a que la
  primera transacción termine (comportamiento nativo de Postgres ante un conflicto de
  índice único en vuelo) y devuelve la respuesta ya guardada — nunca un efecto duplicado.
- Misma clave + cuerpo distinto: `422 idempotency_key_conflict`.
- Sin header: `400 idempotency_key_required`.

## Concurrencia real (overbooking)

La creación de reserva llama a `public.book_availability()` (ya existente en
`packages/db`, `pg_advisory_xact_lock` por `(hotel_id, room_type_id, date)`) una vez por
noche del rango solicitado. Probado con dos `POST` HTTP verdaderamente concurrentes
sobre la última habitación disponible en `tests/adversarial/reserva-concurrencia-y-limites.spec.ts`
contra `embedded-postgres` (nunca solo PGlite, que serializa toda concurrencia).

## Outbox (ADR-004)

`src/outbox/worker.ts::drainOutboxOnce()` drena `public.outbox` (`status='pendiente'`,
`available_at<=now()`), por lotes, con `handlers: Record<event_type, handler>`. Backoff
exponencial con techo (`computeBackoffMs`); tras `maxAttempts` fallos consecutivos el
evento pasa a `status='fallido'` (dead-letter, nunca se reintenta solo ni se borra).
Este backend NO arranca el worker automáticamente todavía (no hay ningún conector
externo real que consuma los eventos, ADR-007) — `drainOutboxOnce` está listo para
engancharse a un cron/loop cuando exista uno. Probado en `tests/unit/api/outbox-worker.spec.ts`.

## Rate limiting

`src/lib/rateLimit.ts`: ventana fija en memoria (`RateLimitStore` intercambiable por un
adaptador de Redis después, sin tocar el middleware), un límite por IP
(`x-forwarded-for`/`x-real-ip`) y otro por usuario autenticado. Configurable por env
(ver tabla arriba). Probado en `tests/unit/api/rate-limiter.spec.ts` (pura) y
`tests/adversarial/reserva-concurrencia-y-limites.spec.ts` (HTTP real, 429 tras exceder).

## Observabilidad

- Logger estructurado JSON (`pino`) con `request_id`/`org_id`/`hotel_id`/`user_id` en
  cada línea de request (`src/app.ts`), PII (`password`, `authorization`, `token`)
  redactada.
- `GET /health` (proceso vivo) y `GET /ready` (Postgres responde + al menos una
  migración aplicada, 503 si no).
- `audit_log` (append-only, hash encadenado, `packages/db`) se escribe en toda mutación
  de negocio vía `record_audit_log()` dentro de la misma transacción.

## Auditoría-1: hallazgos cerrados en H4

- **[CRÍTICO] Cancelar/no-show no liberaba inventario**: `POST .../cancelar` y
  `jobs/noShow.ts` llaman `public.release_availability()` (migración 0013) por cada
  noche de la estancia. Prueba: `tests/integration/reservas/cancelacion-libera-
  inventario.spec.ts` (fuerza `total_rooms=1`, confirma 409 antes de cancelar y 201 de
  otra reserva después).
- **[CRÍTICO] Una noche sin tarifa se cobraba en $0**: `POST /reservas` y `PATCH
  .../fechas` cotizan con `@atiende-hoteles/domain-hotel` `computeQuote()`, que lanza
  `sin_tarifa` (409) si falta la fila de `rate_plan` de cualquier noche del rango —
  nunca suma 0 en silencio. Prueba: `tests/integration/reservas/monto-exacto-multi-
  noche.spec.ts`.
- **[ALTO] No había camino en la API para crear un folio**: `PATCH .../transicion`
  crea el `folio` (idempotente, `on conflict do nothing`) la primera vez que la reserva
  llega a `confirmada`; `GET /reservas` y `GET /reservas/:id` exponen `folioId`. Prueba:
  `tests/integration/reservas/folio-al-confirmar.spec.ts` (sin usar el cliente admin).
- **[ALTO] La cadena de `audit_log` se bifurcaba bajo escritura concurrente del mismo
  tenant**: `packages/db/migrations/0015` reemplaza el intento fallido de
  `pg_advisory_xact_lock` (documentado y descartado en el propio archivo) por una tabla
  `audit_log_chain_head` bloqueada con `SELECT ... FOR UPDATE` por tenant. Prueba:
  `tests/integration/audit-log-concurrencia.spec.ts` (8 rondas de 20 escrituras
  concurrentes, 160 filas, sin bifurcación).
- Ver `docs/auditoria-1/backend.md` y `docs/auditoria-1/pruebas.md` para el detalle
  completo de cada hallazgo.

## Errores

Formato uniforme en toda respuesta de error: `{code, message, request_id}` — nunca un
stack trace. Ver `src/lib/errors.ts` (`ApiError` + mapeo de errores de dominio de
`packages/db`, ej. `sin_disponibilidad` → 409, RLS → 403).

## Rutas

| Método | Ruta | Notas |
|---|---|---|
| GET | `/health`, `/ready` | Sin auth. |
| POST | `/auth/login`, `/auth/refresh` | Sin auth. |
| GET | `/auth/me` | Requiere auth. |
| GET | `/hoteles` | Hoteles del usuario autenticado. |
| GET | `/hoteles/:hotelId/resumen` | Ocupación/ADR/RevPAR/reservas de hoy, "sin datos" honesto si no hay filas. |
| GET, POST | `/hoteles/:hotelId/reservas` | POST exige `Idempotency-Key`. |
| GET | `/hoteles/:hotelId/reservas/:id` | |
| PATCH | `/hoteles/:hotelId/reservas/:id/transicion` | Máquina de estados de `packages/db` (trigger valida). |
| GET | `/hoteles/:hotelId/disponibilidad?desde&hasta` | Rango por tipo de habitación (mínimo del rango). |
| GET, POST | `/hoteles/:hotelId/huespedes` | |
| GET | `/hoteles/:hotelId/huespedes/:id` | |
| GET | `/hoteles/:hotelId/folios/:id` | Solo roles con acceso a dinero. |
| POST | `/hoteles/:hotelId/folios/:id/cargos` | Idempotente. |
| POST | `/hoteles/:hotelId/folios/:id/pagos` | Idempotente. |
| POST | `/hoteles/:hotelId/quotes` | H4: motor de cotización determinista (`@atiende-hoteles/domain-hotel`), min-stay/CTA/CTD. |
| PATCH | `/hoteles/:hotelId/reservas/:id/fechas` | H4: modifica fechas/tipo bajo el mismo advisory lock (libera lo viejo, reserva lo nuevo), exige `Idempotency-Key`. |
| POST | `/hoteles/:hotelId/reservas/:id/cancelar` | H4: cancelación por staff, aplica `hotel_cancellation_policy`, libera inventario. |
| POST | `/hoteles/:hotelId/reservas/procesar-no-show` | H4: dispara `jobs/noShow.ts` (idempotente por construcción: filtra `status='confirmada'`). |
| POST | `/reservas/cancelacion-publica` | H4: cancelación SIN sesión de staff, verificada por código de reserva + apellido (REQ-RES-005). |
| GET, PUT | `/hoteles/:hotelId/tarifas` | H4: CRUD de `rate_plan` (precio/min-stay/CTA/CTD) por rango de fechas, roles `MANAGE_INVENTORY_ROLES`. |
| GET, PUT | `/hoteles/:hotelId/impuestos` | H4: IVA/ISH por hotel, roles `owner`/`gm`. |
| GET, PUT | `/hoteles/:hotelId/politica-cancelacion` | H4: política en 4 puntos (free_until/penalty/no_show/deposit). |
| GET | `/hoteles/:hotelId/disponibilidad/grid?desde&hasta` | H4: desglose POR DÍA (a diferencia de `/disponibilidad`, que agrega el rango) para la grilla del frontend. |

## Qué falta (declarado explícitamente, no simulado)

- Conector PMS/webhooks entrantes (HMAC, dedupe por `source.event_id`, `REQ-INT-014`) —
  no hay ningún proveedor externo con credenciales en esta fase (ADR-007); H4 sí agrega
  `POST /reservas/cancelacion-publica`, la primera ruta pública sin sesión de staff
  (verificada por código+apellido, `cancel_reservation_public()` SECURITY DEFINER).
- Cobro real de tarjeta ante un no-show (`REQ-RES-008`): el job (`jobs/noShow.ts`)
  determina el no-show, libera inventario y calcula el monto, pero no ejecuta ningún
  cargo real — requiere pasarela de pago, pendiente de credenciales.
- El job de no-show no corre automáticamente todavía (sin cron propio); se dispara vía
  `POST /hoteles/:hotelId/reservas/procesar-no-show` (rol admin) o manualmente.
- El worker de outbox no corre automáticamente (sin proceso propio/cron todavía).
- Sin *connection pooling*: cada request abre una conexión Postgres nueva
  (`withAppSession`, mismo mecanismo que `packages/db`) — aceptable para esta fase de
  desarrollo/pruebas, no para producción con tráfico real.
