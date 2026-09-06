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
| `MONEY_ALERT_WEBHOOK_URL` | (sin definir) | No | Webhook genérico que recibe cada alerta del camino del dinero por HTTP POST. Sin definir (ni el par de abajo), la alerta queda solo como log. |
| `MONEY_ALERT_EMAIL_TO` / `MONEY_ALERT_EMAIL_WEBHOOK_URL` | (sin definir) | No | Ambas juntas: envía `{to, subject, alert}` al webhook de correo configurado. |

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
  migración aplicada, 503 si no; incluye `moneyAlertsConfigured`, ver abajo).
- `audit_log` (append-only, hash encadenado, `packages/db`) se escribe en toda mutación
  de negocio vía `record_audit_log()` dentro de la misma transacción.
- **Alerta del camino del dinero** (`nivel: "alerta"`, ADR-008, `src/lib/moneyAlert.ts`):
  cualquier 5xx en una ruta de cargos/pagos/CFDI/folios/reservas emite un log
  estructurado. auditoria-2/operabilidad [ALTO]: hasta este fix esa línea de log era
  **el mecanismo completo** -- nadie recibía una notificación activa, la detección
  dependía de que alguien estuviera mirando los logs. Ahora, si defines
  `MONEY_ALERT_WEBHOOK_URL` (webhook genérico: Slack, PagerDuty, un endpoint propio, o
  un relevo webhook→correo) y/o el par `MONEY_ALERT_EMAIL_TO` +
  `MONEY_ALERT_EMAIL_WEBHOOK_URL`, cada alerta se entrega ahí por HTTP POST además de
  quedar en el log. **Si no defines ninguno, sigue siendo solo una línea de log** -- el
  proceso lo declara explícitamente al arrancar (log de arranque `nivel: "alerta"`,
  `tipo: "alerta_camino_dinero_sin_destinatario"`) y `GET /ready` lo refleja en
  `moneyAlertsConfigured: false`, para que la brecha sea visible sin leer el código.
  REQ-BO-034 (umbral+destinatario configurable) sigue `pendiente` en
  `docs/REQUISITOS.md` -- esto cubre "destinatario", no un umbral configurable por tipo.

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
| GET | `/hoteles/:hotelId/reservas/:id/folios` | H5: TODOS los folios de una reserva (principal + splits). |
| POST | `/hoteles/:hotelId/folios/:id/descuentos` | H5: descuento; sobre `hotel_tax_config.discount_threshold` exige rol owner/gm o `autorizadoPorUserId` verificado. |
| POST | `/hoteles/:hotelId/folios/:id/cargos/:chargeId/reverso` | H5: reverso (REQ-REC-004) — NUNCA borra, inserta cargo negativo + `mark_charge_reversed()`. |
| POST | `/hoteles/:hotelId/folios/:id/cargos/:chargeId/transferir` | H5: mueve un cargo a otro folio del MISMO hotel. |
| POST | `/hoteles/:hotelId/folios/:id/split` | H5: crea un folio secundario de la misma reserva y le transfiere los cargos indicados. |
| POST | `/hoteles/:hotelId/folios/:id/cerrar` | H5: cierre — `saldo_cero` o `cuenta_por_cobrar` (requiere rol administrativo). |
| POST | `/hoteles/:hotelId/night-audit` | H5: night audit idempotente por `business_date` (REQ-REV-013) — postea hospedaje, marca no-shows, resumen de caja. |
| GET | `/hoteles/:hotelId/night-audit`, `/night-audit/:businessDate` | H5: historial/detalle de corridas. |
| POST | `/hoteles/:hotelId/folios/:id/cfdi` | H5: timbra CFDI de hospedaje (REQ-BO-001/002), idempotente por folio. |
| POST | `/hoteles/:hotelId/folios/:id/cfdi/pago` | H5: complemento de pago (tipo 'pago'), referencia un CFDI de hospedaje. |
| POST | `/hoteles/:hotelId/cfdi/:id/cancelar` | H5: cancelación de CFDI vía `CfdiPort`. |
| GET | `/hoteles/:hotelId/cfdi`, `/folios/:id/cfdi` | H5: listado con estado real (timbrado/cancelado/rechazado). |

## H5 — Folio/cargos/pagos + night audit + CFDI de hospedaje (PENDIENTE DE CREDENCIALES lo marcado)

- **Motor de folio determinista** (`packages/domain-hotel/src/folioEngine.ts`,
  `fiscalHospedaje.ts`): cálculo de cargos por concepto (hospedaje/A&B/extras/ajuste/
  propina/otro), IVA+ISH aplicados solo a conceptos taxables (propina/descuento/reverso
  nunca), redondeo centralizado, autorización de descuentos por umbral/rol
  (`evaluateDiscountAuthorization`), cierre de folio (`evaluateFolioClose`: saldo cero
  o cuenta por cobrar autorizada). 7 funciones fiscales puras (ISH/DSA/ISN/IVA/ISR
  provisional/DIOT/retención de plataformas digitales, REQ-BO-007) parametrizadas —
  ninguna tasa/umbral vive fija en código.
- **Reverso/transferencia/split nunca borran una fila** (REQ-REC-004): el reverso
  inserta un cargo de signo contrario y usa `mark_charge_reversed()` (SECURITY
  DEFINER) para marcar el original; transferir/split combinan un reverso en origen +
  un cargo nuevo en destino. Verificado en `tests/integration/folio/event-sourcing.spec.ts`
  y por revisión estática (`scripts/checks/no-delete-events.ts`).
- **Pagos vía `PaymentProviderPort`** (`@atiende-hoteles/mcp-payments`, ya construido
  en H9/H11 — este módulo lo consume, no lo reimplementa): efectivo/transferencia se
  registran directo; tarjeta SIEMPRE exige `tokenPago` opaco (nunca número de
  tarjeta — `payment_token_ref_not_pan` en BD es la última línea de defensa, ver
  `scripts/checks/no-pan-storage.ts`). **[PENDIENTE DE CREDENCIALES]** el adaptador
  real (Stripe MX/Conekta) — por defecto `createApp` instancia `FakeStripeAdapter`
  (simulado, único por proceso para que su idempotencia interna funcione). El
  "link de pago tokenizado" hoy se modela como: el PSP real emitiría el link/checkout
  hospedado y devolvería el token; este backend nunca ve ni acepta el número de
  tarjeta. Falta construir el endpoint que GENERA ese link (requiere el producto de
  Payment Links del PSP real).
- **Night audit propio** (REQ-REV-013/H16-003, `src/jobs/nightAudit.ts` +
  `src/routes/night-audit.ts`): idempotente por `(hotel_id, business_date)` vía
  `night_audit_claim`/`night_audit_finish` (advisory lock + tabla, SECURITY DEFINER);
  postea hospedaje a folios en casa (dedupe real por índice único parcial
  `charge_folio_stay_date_hospedaje_idx`), marca no-shows (reutiliza
  `jobs/noShow.ts`, que ahora también postea la penalización al folio como concepto
  `hospedaje`), genera resumen de caja. La conciliación A&B/spa contra POS se declara
  explícitamente `sin_pos_configurado` — no hay integración POS real en esta fase.
  **No corre por cron todavía** — se dispara vía `POST /hoteles/:hotelId/night-audit`
  (rol owner/gm/accountant) o llamando `runNightAudit()` desde un job externo futuro.
- **CFDI de hospedaje vía `CfdiPort`** (`@atiende-hoteles/mcp-cfdi`, H9/H11 — usado, no
  reimplementado): `src/routes/cfdi.ts` aplica las reglas de REQ-BO-001 (extranjero →
  RFC XEXX010101000/uso S01; global → XAXX010101000; ISH/DSA en `impuestosLocales`
  fuera de la base de IVA; propina excluida del subtotal; no-show como concepto
  `hospedaje`). Idempotente por folio (un solo CFDI de tipo 'hospedaje' por folio,
  índice único parcial + verificación previa). **[PENDIENTE DE CREDENCIALES]** el PAC
  real (Finkok/SW Sapien u otro) y el CSD/e.firma del hotel — por defecto `createApp`
  usa `DualPacCfdiPort` sobre dos adaptadores simulados. El nodo `CfdiRelacionados`
  tipo 07 (anticipos) se registra en `cfdi_emision.related_cfdi_id` porque el
  `TimbrarInput` del puerto actual no expone ese campo — pendiente de que el puerto lo
  incorpore para viajar realmente al PAC.
- **Calendario fiscal + aprobación SAT** (REQ-BO-008/REQ-BO-006, migraciones
  `0033_calendario_fiscal.sql`): tablas `fiscal_obligation`/`sat_filing_approval` con
  RLS y un trigger que BLOQUEA marcar una obligación con `requiere_efirma` como
  `presentada` sin una fila de aprobación de owner/gm ya registrada. **Sin ruta de API
  CRUD todavía** — verificado directamente contra la base bajo RLS
  (`tests/integration/fiscal/calendario-fiscal.spec.ts`,
  `tests/adversarial/presentacion-sat-aprobacion.spec.ts`); construir el endpoint es
  trabajo natural de un hito de back-office posterior.
- **Fuera de alcance de H5, declarado explícitamente**: REQ-REC-011 (bóveda de
  identidad: OCR, cifrado en reposo, purga a 30 días) no se construye aquí — es una
  funcionalidad de captura de identidad en check-in, no de folio/cargos/pagos; el
  esquema actual (`guest.identity_ref`, H1) sigue siendo solo un placeholder. Un
  segundo factor de verificación de identidad del HUÉSPED (no del staff) antes de un
  cargo (REQ-REC-012 en su lectura literal de "check-in por voz/kiosko") tampoco se
  construye — este módulo cubre la autorización POR ROL/UMBRAL dentro del panel de
  staff autenticado (ver `evaluateDiscountAuthorization` arriba), que es lo que
  `tests/adversarial/cargo-folio-verificacion.spec.ts` verifica.

| GET | `/hoteles/:hotelId/housekeeping/tablero` | H6b: estado de limpieza por habitación + tarea abierta (RLS: housekeeping solo ve las suyas). |
| POST | `/hoteles/:hotelId/housekeeping/tareas` | H6b: reusa la tool `crear_tarea_housekeeping` de `@atiende-hoteles/agent-core`. |
| PATCH, POST | `/hoteles/:hotelId/housekeeping/tareas/:id/{asignar,iniciar,terminar,inspeccionar}` | H6b: ciclo de vida de la tarea; inspeccionar reservado a owner/gm/frontdesk. |
| POST | `/hoteles/:hotelId/housekeeping/habitaciones/:id/fuera-de-servicio` | H6b: solo owner/gm. |
| GET, POST | `/hoteles/:hotelId/mantenimiento` | H6b: reusa la tool `crear_ticket_mantenimiento` (dedupe 24h, marca OOO si severidad alta). |
| PATCH | `/hoteles/:hotelId/mantenimiento/:id/{asignar,estado}` | H6b: solo owner/gm. |
| POST | `/hoteles/:hotelId/mantenimiento/:id/cerrar-con-costo` | H6b: SIEMPRE abre/reusa una solicitud en `agent_approval` (dinero, doble confirmación) — nunca cierra directo. |
| GET | `/hoteles/:hotelId/aprobaciones`, `/hoteles/:hotelId/aprobaciones/:id` | H6b: bandeja de `agent_approval`, visible a todo el staff del hotel. |
| POST | `/hoteles/:hotelId/aprobaciones/:id/decidir` | H6b: solo owner/gm (RLS + `assertRole`); al completar la(s) confirmación(es) ejecuta la tool de dominio correspondiente. |
| GET | `/hoteles/:hotelId/mensajeria` | H6b: conversaciones por huésped. |
| GET | `/hoteles/:hotelId/mensajeria/:conversationId/mensajes` | H6b: hilo de mensajes, incluye `simulado`/`estadoEntrega`. |
| GET, PATCH | `/hoteles/:hotelId/mensajeria/config` | H6b: plantillas transaccionales del hotel (auto-aprobación), solo owner/gm. |
| POST | `/hoteles/:hotelId/mensajeria/mensajes` | H6b: reusa la tool `enviar_mensaje_whatsapp_plantilla`; plantilla transaccional → envío inmediato, cualquier otra → `agent_approval`. |
| POST | `/hoteles/:hotelId/mensajeria/webhook` | H6b: **PÚBLICO** (sin Bearer de staff) — HMAC contra `hotel_messaging_config.webhook_secret` + idempotencia por `event_id` (`idempotency_key`, scope `whatsapp.webhook`). Firma inválida → 401; replay → 200 `{estado:"duplicado"}` sin reprocesar. |
| GET | `/hoteles/:hotelId/agentes` | H7: catálogo de agentes (`@atiende-hoteles/agent-core` `AGENT_DEFINITIONS`) con el gate/techo efectivo por hotel (fila de `agent_config` o default de código). |
| GET | `/hoteles/:hotelId/agentes/costos` | H7: consumido del mes (`agent_cost_mes()`) vs techo, `pctUsado`, `alerta` al 80% (configurable), `sinDatos` honesto por CONTEO de corridas (no por costo=0). |
| PATCH | `/hoteles/:hotelId/agentes/:agente/config` | H7: solo owner/gm — cambia gate y/o techo mensual USD (`agent_config`, upsert). |
| POST | `/hoteles/:hotelId/agentes/:agente/ejecutar` | H7: rol restringido por `AGENT_DEFINITIONS[agente].allowedStaffRoles`; corta por presupuesto ANTES de invocar al proveedor (`presupuesto_agotado` honesto, `agent_run` costo 0); sin `demo:true` usa `EnvProvider` real (→ `no_configurado` sin credenciales, ADR-007); con `demo:true` corre un guion determinista de `FakeProvider` (check-in con incidencia) etiquetado `simulado:true` en la respuesta. Body `.strict()`: `hotelId`/`orgId`/`gate` en el cuerpo → 400, nunca se leen del cliente. Cada paso (`AgentTraceEvent`) → `audit_log`; el resumen agregado → `agent_run`; ambos en la misma transacción por-request. |
| GET | `/hoteles/:hotelId/roi` | H7: eventos de `roi_event` (REQ-AGT-003/H17-001) + suma estimada/verificada + `supuestoVersion` — sin línea base firmada (REQ-REV-018), no habilita ningún cobro por resultado. |

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
- **Corregido en auditoría-1/bd**: `withAppSession` (`packages/db/src/engines.ts`) usa un
  `pg.Pool` de proceso (tamaño/timeouts configurables vía `poolMax`/
  `connectionTimeoutMs`/`statementTimeoutMs`), no un `pg.Client` nuevo por request. Los
  claims de sesión (`set local role`, `request.jwt.claim.sub`) siguen fijados con
  alcance de TRANSACCIÓN — Postgres los descarta al hacer commit/rollback antes de que
  la conexión física vuelva al pool, así que ninguna sesión reciclada hereda el actor de
  la anterior (verificado con `poolMax: 1` forzando la misma conexión física, ver
  `tests/integration/pool-sin-fuga-de-claims.spec.ts`).
- **PENDIENTE DE CREDENCIALES (Meta/WhatsApp Cloud API, H6b):** `routes/mensajeria.ts` y
  las tools de agent-core usan SIEMPRE `FakeWhatsappAdapter`
  (`packages/mcp-servers/whatsapp`) — ninguna llamada real a Meta. `message.simulated`
  queda `true` en cada fila y el frontend lo muestra explícitamente. Cuando existan
  credenciales reales de Meta (Tech Provider/Embedded Signup, ADR-007), sustituir el
  adaptador inyectado en `apps/api/src/lib/messaging.ts`
  (`sharedWhatsappAdapter`) por `MetaWhatsappAdapter` real — ninguna otra pieza del
  sistema (tools, rutas, RLS, aprobaciones) necesita cambiar, es exactamente el punto de
  extensión que `MessagingPort` fue diseñado para dar.
- H6b: `POST /hoteles/:hotelId/mantenimiento/:id/cerrar-con-costo` y
  `POST /hoteles/:hotelId/mensajeria/mensajes` reutilizan las tools de dominio de
  `@atiende-hoteles/agent-core` (misma lógica que usaría el agente conversacional) pero
  se invocan hoy solo desde la UI de staff — el agente conversacional real (LLM en vivo)
  sigue pendiente de credenciales (`EnvProvider`, ver README de `packages/agent-core`);
  el journey completo está demostrado end-to-end con `FakeProvider` en
  `tests/integration/agent-core/journey-checkin-incidencia.spec.ts`.
- `housekeeping_task`/`maintenance_ticket` no tienen columna de "piso": el tablero de
  `/housekeeping` ordena por código de habitación, no agrupa por piso (el esquema de
  `room`, H1, no modela ese dato) — documentado, no fabricado en el frontend.
- **H7 (runtime de agentes)**: `POST /hoteles/:hotelId/agentes/:agente/ejecutar` sin
  `demo:true` usa `EnvProvider` (`@atiende-hoteles/agent-core`) — sin `ANTHROPIC_API_KEY`/
  `OPENROUTER_API_KEY` en el entorno (ADR-007, sigue igual que H6a) se declara
  `no_configurado` de forma honesta; NINGUNA llamada real a un proveedor LLM ocurre en
  este hito, ni siquiera con credenciales presentes (la integración real queda
  pendiente, ver README de `packages/agent-core`). `demo:true` es la ÚNICA forma de ver
  una corrida completa hoy, y siempre etiquetada `simulado:true` en la respuesta.
- **H7 (ROI/línea base, REQ-REV-018)**: `GET /hoteles/:hotelId/roi` expone los eventos
  capturados (`roi_event`, REQ-AGT-003) con su `supuestoVersion`, pero la lógica de
  "línea base firmada" y activación de cobro por resultado sobre esos eventos NO está
  implementada — ningún endpoint de este hito activa un cobro, solo registra/expone el
  valor estimado.
- **H7 (agentes)**: sin scheduler real para `auditor_nocturno` (se dispara manualmente
  vía `POST .../ejecutar`, con o sin `demo:true`); sin suite de red-teaming/prompt
  injection en CI (REQ-AGT-009, requiere su propio simulador de huéspedes, fuera de
  alcance de este hito); sin flujo de aprobación de e.firma para presentación SAT
  (REQ-BO-006, dominio fiscal distinto, no tocado aquí).
