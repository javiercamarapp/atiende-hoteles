# @atiende-hoteles/mcp-outbound

`OutboundTaskSyncPort` -- conector outbound GENÉRICO, configurable por hotel, que
empuja `housekeeping_task`/`maintenance_ticket`/`guest_ticket` hacia el sistema propio
de gestión de tareas de un hotel de cadena (HotSOS/Optii-style). Ver
`docs/integraciones/conector-pms-enterprise.md` y `docs/ARQUITECTURA.md` ADR-007.

## Por qué existe

Hoteles grandes/de cadena ya operan su propio sistema de asignación/seguimiento de
tareas de housekeeping/mantenimiento. Este backend no debe intentar reemplazarlo -- debe
ser la CAPA DE ENTRADA que genera la señal (huésped reporta algo, se crea una tarea
local) y la empuja al sistema real del hotel vía su API, para que el staff del hotel
siga trabajando en la herramienta que ya conoce.

## Contrato (`src/port.ts`)

`pushTask(destination, task)` -- a diferencia de `PaymentProviderPort`/`CfdiPort` (un
proveedor global por proceso, resuelto por variables de entorno), aquí la credencial es
POR HOTEL: cada hotel de la cadena apunta a un endpoint/secreto distinto del sistema que
usa, así que `destination` (`{url, secret}`) se pasa explícito en cada llamada en vez de
leerse una sola vez de `process.env`.

`OutboundTask` es el payload genérico que se envía (JSON): `idempotencyKey`, `taskType`
(`housekeeping_task|maintenance_ticket|guest_ticket`), `taskId`, `hotelId`, `title`,
`description?`, `priority`, `roomCode?`, `department?`, `status`, `occurredAt`.

## Adaptador real (`src/adapters/webhook-outbound-adapter.ts`)

`WebhookOutboundAdapter` hace un POST HTTP real (fetch nativo) al `destination.url`
configurado, con el cuerpo JSON firmado por HMAC saliente (`signHmac`, mismo primitivo
de `packages/mcp-servers/shared/src/hmac.ts` que el resto del repo usa para VERIFICAR
webhooks entrantes, aquí aplicado en la dirección contraria):

- `X-Atiende-Signature: sha256=<hex>` sobre el cuerpo crudo, con `destination.secret`.
- `X-Atiende-Event-Id: <idempotencyKey>` -- la deduplicación de reintentos es
  responsabilidad del RECEPTOR (mismo criterio que un webhook saliente de Stripe/Meta),
  este adaptador no guarda su propio historial de entregas.
- `X-Atiende-Task-Type: <housekeeping_task|maintenance_ticket|guest_ticket>`.

Reintentos con backoff ante `429` (mismo mecanismo que `StripeAdapter`/`ConektaAdapter`,
`packages/mcp-servers/shared/src/backoff.ts`); un no-2xx que NO es 429 se relanza tal
cual (`OutboundDeliveryError`) -- nunca se reintenta ciegamente un payload que el hotel
pudo haber rechazado a propósito.

### `verificadoContraReal = false` -- qué significa exactamente

"Genérico" significa, por definición, que no hay un proveedor único con contrato público
documentado que verificar contra la red real -- cada hotel de cadena tiene el suyo. El
código SÍ hace el POST real cuando se le da una `OutboundTaskDestination`, y SÍ se probó
de extremo a extremo contra `tests/support/fakeOutboundTargetServer.ts` (servidor
`node:http` real en `127.0.0.1` que verifica la firma HMAC exactamente como se
documenta arriba), pero jamás se ha ejecutado contra el sistema real de un hotel piloto
en esta sesión. No asumas que "probablemente funciona" contra HotSOS/Optii/cualquier
otro real a partir de este comentario.

## Adaptador simulado (`src/adapters/fake-outbound-adapter.ts`)

`FakeOutboundTaskSyncAdapter` registra cada llamada en memoria (`pushed`) y expone
`signFixture()` para que una prueba que juega el rol del "sistema del hotel" pueda
verificar la firma que el adaptador real habría calculado, sin red.

## Configuración por hotel

`hotel_pms_outbound_config` (`packages/db/migrations/0127_hotel_pms_outbound_config.sql`)
guarda, por hotel, `webhook_url`/`webhook_secret`/`task_types`/`enabled` -- mismo patrón
que `hotel_messaging_config` (WhatsApp)/`hotel_voice_agent_config` (voz). Gestionable vía
`apps/api/src/routes/pmsOutboundConfig.ts` (`GET`/`PUT`, solo `owner`/`gm`).

## Enganche a la creación de tareas

`packages/agent-core/src/tools/outboundTaskSync.ts::syncTaskToOutboundConnector()` es el
punto de enganche real: se llama DESPUÉS de que `crear_tarea_housekeeping`/
`crear_ticket_mantenimiento`/`crear_ticket_huesped` (agent-core) ya insertaron la fila
local. Es **best-effort a propósito**: sin `hotel_pms_outbound_config` (el caso común,
un hotel independiente o uno de cadena que aún no conectó su sistema) no hace nada, en
silencio; con configuración, un fallo del envío (red, HTTP no-2xx, timeout) se captura,
se refleja en `data.outboundSync` del resultado de la tool para observabilidad, y
**nunca** revierte ni bloquea la creación local de la tarea -- la fuente de verdad local
no depende de que el sistema del hotel esté disponible.

`agent-core` no importa este paquete (H6a, núcleo sin dependencias externas): declara
`OutboundTaskSyncLike`, la forma estructural mínima que necesita (mismo patrón que
`WhatsappSenderLike` en `messagingTools.ts`) -- `WebhookOutboundAdapter`/
`FakeOutboundTaskSyncAdapter` la cumplen sin adaptador.
