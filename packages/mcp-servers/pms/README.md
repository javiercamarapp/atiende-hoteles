# @atiende-hoteles/mcp-pms

Puerto de integración con el PMS del hotel (Cloudbeds primero, H15-001). Ver
`docs/ARQUITECTURA.md` ADR-007 y `docs/referencia/03-investigacion-H12-H21.md` §5.

**auditoria-2/arquitectura [BAJO]**: NO confundir este paquete con `apps/api/src/pms/`
(carpeta con el mismo nombre pero un propósito distinto): ese directorio contiene
`taxConfig.ts`/`dbRoomRatePort.ts`, que leen `hotel_tax_config`/`rate_plan` DIRECTO de
Postgres propio (nunca hablan con un PMS externo) -- es la ruta real de datos HOY. Este
paquete (`@atiende-hoteles/mcp-pms`) es el conector PMS real de ADR-007. `apps/api` ya
tiene un caller real (`apps/api/src/jobs/pmsCloudbedsSyncScheduler.ts`, ver mas abajo)
que sincroniza tarifas de Cloudbeds hacia `public.rate_plan` para las habitaciones que
declaren `room_type.cloudbeds_room_type_id` -- pero sigue **[PENDIENTE DE CREDENCIALES]**
para ejecutarse de verdad (sin las 4 variables OAuth, el scheduler solo registra
`status().reason` en cada tick y no hace ninguna llamada de red).

## Contrato (`src/port.ts`)

`PmsPort` cubre REQ-INT-001 (P0): reservas, tarifas, housekeeping, folio/cargos y perfil
de huésped, con webhooks de check-in/checkout normalizados al patrón
Ingress→RawEvent→Adapter.normalize (H15-016).

Mapeo de estados (provider-agnóstico: el resto del sistema solo conoce el enum de
dominio, igual que `reservation_status` de `packages/db` migración `0006`):

| Dominio | Cloudbeds nativo |
|---|---|
| `cotizada` | `not_confirmed` / `pending` |
| `confirmada` | `confirmed` |
| `en_estancia` | `checked_in` |
| `check_out` | `checked_out` |
| `cancelada` | `canceled` |
| `no_show` | `no_show` |
| `cerrada` | *(sin equivalente nativo -- solo interno, tras cierre de folio)* |

Housekeeping: `sucia|limpia|inspeccionada|fuera_de_servicio` ↔ `dirty|clean|inspected|out_of_order`.

## Adaptador real (`src/adapters/cloudbeds-adapter.ts`)

Los 7 métodos de `PmsPort` ejecutan HTTP real contra `https://api.cloudbeds.com/api/v1.3`
(verificado contra el OpenAPI público de cada endpoint, no contra v1.2/host anterior --
ver docstring del archivo para el detalle exacto). **[PENDIENTE DE CREDENCIALES]**.
Requiere en entorno:

- `CLOUDBEDS_CLIENT_ID` / `CLOUDBEDS_CLIENT_SECRET`: credenciales de la app OAuth2 del
  portal de partners de Cloudbeds.
- `CLOUDBEDS_REFRESH_TOKEN`: obtenido UNA vez completando a mano el flujo
  `authorization_code` contra una property real que autorice la app (paso humano de
  onboarding, no algo que este paquete automatice). El adaptador renueva el
  `access_token` solo (`grant_type=refresh_token`), sigue la rotación de
  `refresh_token` que Cloudbeds pueda devolver en cada renovación, y cachea el token
  vigente en memoria (~30s de margen antes de `expires_in`).
- `CLOUDBEDS_PROPERTY_ID`: el `propertyID` de Cloudbeds del hotel piloto.
- `CLOUDBEDS_WEBHOOK_SECRET`: secreto PROPIO de este repo (ver limitación de abajo).

Sin las 4 variables OAuth, `status()` retorna `{ available: false, reason: "[PENDIENTE DE
CREDENCIALES] faltan: ..." }` y cada método lanza `PortUnavailableError` -- nunca se
fabrica una respuesta. Con ellas: reintentos con backoff exponencial + jitter ante
`429`/`Retry-After`, `404` -> `PortNotFoundError`, idempotencia real de `createCharge`
por `idempotencyKey`, concurrencia optimista real en `applyReservationUpdate` (relee
`getReservation` y compara `dateModified` contra `expectedVersion` ANTES de escribir --
`putReservation` real no tiene una precondición tipo `If-Match`), y verificación
HMAC + guarda de replay de webhooks.

**[LIMITACIÓN DOCUMENTADA] Cloudbeds no firma sus webhooks con HMAC** (confirmado
contra `developers.cloudbeds.com/docs/webhooks-1`): a diferencia de Meta/Stripe, su
documentación pública no define ningún header de firma. `verifyAndNormalizeWebhook`
mantiene la verificación HMAC contra `CLOUDBEDS_WEBHOOK_SECRET` porque el contrato
`PmsPort` la exige y porque un secreto compartido en la URL de suscripción sigue siendo
una defensa real -- pero es una convención de ESTE repo, no algo que Cloudbeds calcule;
ver el docstring de `verifyAndNormalizeWebhook` para el detalle completo. El payload que
sí normaliza es la forma REAL documentada (`event` combinado tipo
`"reservation/status_changed"`, `timestamp` unix, sin `event_id` propio -- se deriva una
clave de deduplicación determinista de `(evento, propiedad, entidad, timestamp)`).

## Adaptador simulado (`src/adapters/fake-cloudbeds-adapter.ts`)

`FakeCloudbedsAdapter` (`simulated: true` en `status()`). Fixtures realistas basadas en
la forma pública documentada de Cloudbeds (2 reservaciones con distintos estados,
tarifas por fecha). Implementa el contrato completo, incluida idempotencia real de
`createCharge` (segunda llamada con la misma clave no incrementa `chargeCallCount`) y
verificación HMAC/replay de webhooks con `FAKE_CLOUDBEDS_WEBHOOK_SECRET`, sobre el mismo
payload real que usa el adaptador de verdad (`normalizeCloudbedsWebhookPayload`).

## Simulador HTTP local (`src/testing/cloudbeds-simulator.ts`)

Servidor HTTP real (Node `http`, puerto efímero en `127.0.0.1`) que imita el contrato
público de Cloudbeds v1.3 -- OAuth2 con rotación de `refresh_token`, el sobre
`{success, data, message}`, 429/404, y las 7 rutas que el adaptador real consume. Sirve
para correr `CloudbedsAdapter` (el de verdad, no el Fake) de punta a punta sin red real
ni credenciales -- ver `tests/unit/mcp-servers/pms/cloudbeds-adapter-simulator.spec.ts`
(auth completo, renovación/rotación de token, reintento ante 429, `404` ->
`PortNotFoundError`, idempotencia, concurrencia optimista) y
`tests/integration/pms/pms-cloudbeds-sync-scheduler.spec.ts` (el mismo camino pero
disparado por el scheduler real de `apps/api`). Dos decisiones del simulador NO están
confirmadas por la documentación pública (que no las especifica) y quedan marcadas como
suposición en su propio docstring: el HTTP status de un recurso inexistente (se asume
404) y el formato exacto de un 429.

## Caller real en `apps/api` (`apps/api/src/jobs/pmsCloudbedsSyncScheduler.ts`)

La auditoría confirmó **0 callers de producción** de este paquete (`apps/api/package.json`
no lo listaba como dependencia). Punto de integración elegido: sincronizar tarifas
(`PmsPort.listRatePlans`) hacia `public.rate_plan` -- la misma tabla que
`apps/api/src/pms/dbRoomRatePort.ts` ya lee para cotizar. Requiere que un `room_type`
declare su equivalente en Cloudbeds vía `room_type.cloudbeds_room_type_id` (columna
nullable, migración `packages/db/migrations/0125_room_type_cloudbeds_external_id.sql`,
mismo patrón que `guest_review.external_id` de la 0097: "lista para cuando exista la
integración real", nunca asumida ya conectada). Planificador en proceso (mismo patrón
que `jobs/nightAuditScheduler.ts`: `setInterval` cada 30 min + tick inmediato al
arrancar, parada limpia), cableado en `server.ts` junto a los demás schedulers. Antes de
construir el adaptador real, valida contra `PMS_CONNECTOR_REGISTRY` (una búsqueda
`.find`, no una bifurcación `if provider === "cloudbeds"`) que Cloudbeds siga siendo el
conector PMS "implementado" -- si el registro cambiara, el proceso falla ruidosamente al
arrancar en vez de asumir en silencio que sigue vigente.

**[PENDIENTE DE CREDENCIALES]**: sin las 4 variables OAuth, cada tick registra
`status().reason` por cada `room_type` mapeado y NO hace ninguna llamada de red ni
escribe ninguna fila -- verificado en
`tests/integration/pms/pms-cloudbeds-sync-scheduler.spec.ts` ("sin OAuth de Cloudbeds:
0 llamadas de red, 0 filas escritas").

## Pruebas

- `tests/unit/mcp-servers/pms/contract.spec.ts` -- la suite de contrato corre contra
  `FakeCloudbedsAdapter` siempre, y contra `CloudbedsAdapter` (real, contra Cloudbeds de
  verdad) solo si las 4 variables OAuth están presentes (se salta explícitamente, nunca
  falla en falso, sin credenciales).
- `tests/unit/mcp-servers/pms/cloudbeds-adapter-simulator.spec.ts` -- `CloudbedsAdapter`
  real contra `cloudbeds-simulator.ts`: corre SIEMPRE, sin credenciales.
- `tests/integration/pms/pms-cloudbeds-sync-scheduler.spec.ts` -- el scheduler de
  `apps/api` contra Postgres real (embedded-postgres), tanto sin credenciales
  (declaración honesta) como con `FakeCloudbedsAdapter` y con `CloudbedsAdapter` +
  simulador de punta a punta.

## Estado

**[PENDIENTE DE CREDENCIALES PARA LA PRIMERA PRUEBA REAL]** -- cubre REQ-INT-001 de
forma completa contra el contrato documentado: los 7 métodos del adaptador real hacen
HTTP real (auth OAuth2, mapeo de campos, reintentos, idempotencia, concurrencia
optimista), el simulador HTTP local prueba ese código sin red real, y `apps/api` ya
tiene un caller de producción (`pmsCloudbedsSyncScheduler`) correctamente registrado.
Lo único que falta -- y que ningún código de este repo puede resolver por sí solo -- son
credenciales de un hotel piloto real en Cloudbeds (o del sandbox de partners de
Cloudbeds): `CLOUDBEDS_CLIENT_ID`, `CLOUDBEDS_CLIENT_SECRET`, `CLOUDBEDS_REFRESH_TOKEN`
(del flujo `authorization_code`, un paso humano) y `CLOUDBEDS_PROPERTY_ID`. Hasta
entonces, "funciona contra Cloudbeds real" sigue siendo una suposición no verificada,
no un hecho comprobado -- solo está verificado contra el contrato público documentado y
contra el simulador local.
