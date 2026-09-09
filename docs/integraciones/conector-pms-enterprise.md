# Conector outbound PMS-enterprise (H18)

## Contexto de negocio

Hoteles **grandes/de cadena** ya operan su propio sistema de gestión de tareas
(HotSOS/Optii-style): housekeeping y mantenimiento reciben, asignan y cierran sus
tareas ahí, no en este backend. `atiende-hoteles` no debe intentar reemplazar ese
sistema para esos hoteles — debe ser la **capa de entrada**: la señal se origina aquí
(un huésped reporta algo por WhatsApp/voz, un ticket se levanta, un agente de IA decide
que hace falta limpieza) y este backend la **empuja** al sistema real del hotel vía su
API, para que el staff siga trabajando en la herramienta que ya conoce y en la que ya
está entrenado.

Este documento describe el conector genérico que resuelve eso: `OutboundTaskSyncPort`.

## Patrón "esqueleto honesto" (ver ADR-007, `docs/ARQUITECTURA.md`)

Mismo criterio que `packages/mcp-servers/payments/src/adapters/stripe-adapter.ts`:

1. **Puerto real** (interfaz TypeScript + esquema Zod del contrato) —
   `packages/mcp-servers/outbound/src/port.ts`.
2. **Adaptador HTTP real y genérico** — `WebhookOutboundAdapter`
   (`src/adapters/webhook-outbound-adapter.ts`): hace un POST HTTP real (fetch nativo)
   cuando se le da una `OutboundTaskDestination`.
3. **Fake para pruebas** — `FakeOutboundTaskSyncAdapter`.
4. **`verificadoContraReal = false`, explícito**: el adaptador real SÍ hace la llamada
   HTTP real y SÍ se probó de extremo a extremo contra
   `tests/support/fakeOutboundTargetServer.ts` (servidor `node:http` local que verifica
   la firma HMAC), pero jamás se ha ejecutado contra el sistema real de un hotel piloto
   (HotSOS, Optii o cualquier otro) en esta sesión.

### Por qué es distinto de `PaymentProviderPort`/`CfdiPort`

Esos puertos resuelven **un proveedor global por proceso**, elegido por qué credencial
de `process.env` existe (`resolvePaymentPort()`: Stripe > Conekta > Fake). Aquí la
credencial es **por hotel** — cada hotel de la cadena apunta a un endpoint/secreto
distinto de SU sistema — así que `pushTask(destination, task)` recibe el destino como
argumento explícito en cada llamada, y `resolveOutboundTaskSyncPort()`
(`apps/api/src/lib/resolveOutboundTaskSyncPort.ts`) solo decide si el **mecanismo de
envío en sí** está activo o apagado por un interruptor operativo global
(`OUTBOUND_PMS_SYNC_DISABLED=true` → `FakeOutboundTaskSyncAdapter` para todos los
hoteles, útil si el conector empieza a comportarse mal en producción).

## Piezas

| Pieza | Archivo |
|---|---|
| Puerto (`OutboundTaskSyncPort`, `OutboundTask`, `OutboundTaskDestination`) | `packages/mcp-servers/outbound/src/port.ts` |
| Adaptador real (`WebhookOutboundAdapter`) | `packages/mcp-servers/outbound/src/adapters/webhook-outbound-adapter.ts` |
| Adaptador simulado (`FakeOutboundTaskSyncAdapter`) | `packages/mcp-servers/outbound/src/adapters/fake-outbound-adapter.ts` |
| Config por hotel + gateway (`OutboundTaskSyncGateway`) | `packages/mcp-servers/outbound/src/gateway.ts` |
| Tabla de configuración por hotel | `packages/db/migrations/0127_hotel_pms_outbound_config.sql` |
| Resolución del adaptador real (patrón `resolveXPort()`) | `apps/api/src/lib/resolveOutboundTaskSyncPort.ts` |
| Enganche estructural en agent-core (H6a, sin importar el paquete) | `packages/agent-core/src/tools/outboundTaskSync.ts` |
| Ruta de configuración (`GET`/`PUT`/`DELETE`, solo owner/gm) | `apps/api/src/routes/pmsOutboundConfig.ts` |
| Pruebas de contrato del adaptador real | `tests/integration/contracts/outbound/webhook-outbound-adapter.spec.ts` |
| Pruebas del gateway (config real, PGlite) | `tests/unit/mcp-servers/outbound/gateway.spec.ts` |
| Pruebas de extremo a extremo del enganche (vía API real) | `tests/integration/api/pms-outbound-conector.spec.ts` |

## Firma HMAC saliente

Reutiliza `signHmac()`/`verifyHmacSignature()` (`packages/mcp-servers/shared/src/hmac.ts`,
GOB-042) — el **mismo primitivo** que todos los adaptadores de este repo usan para
**verificar** webhooks entrantes (Stripe/Conekta/Cloudbeds/Meta/PAC), aplicado en la
dirección contraria: aquí somos nosotros quien firma. Headers en cada POST:

- `X-Atiende-Signature: sha256=<hex>` sobre el cuerpo JSON crudo, con el
  `webhook_secret` de ESE hotel.
- `X-Atiende-Event-Id: <idempotencyKey>` — la deduplicación de reintentos es
  responsabilidad del **receptor** (mismo criterio que un webhook saliente de
  Stripe/Meta), este adaptador no guarda su propio historial de entregas.
- `X-Atiende-Task-Type: housekeeping_task|maintenance_ticket|guest_ticket`.

Reintentos con backoff exponencial ante `429` (máx. 4 intentos, mismo mecanismo que
`StripeAdapter`/`ConektaAdapter`); un no-2xx que **no** es 429 (`401`, `500`, etc.)
nunca se reintenta — puede ser un payload que el hotel rechazó a propósito, reintentar
ciegamente lo empeoraría.

## Configuración por hotel

`hotel_pms_outbound_config` (`packages/db/migrations/0127`) — mismo patrón que
`hotel_messaging_config` (WhatsApp, 0044) y `hotel_voice_agent_config` (voz, 0126):

| Columna | Qué es |
|---|---|
| `webhook_url` | Endpoint del sistema del hotel que recibe el POST. |
| `webhook_secret` | Secreto compartido para la firma HMAC (64 caracteres hex, generado por el backend). |
| `task_types` | Qué tipos de tarea empujar (`housekeeping_task`/`maintenance_ticket`/`guest_ticket`) — un hotel puede conectar solo mantenimiento y seguir manejando housekeeping/tickets de huésped en este backend. |
| `enabled` | Default `false` (BP-016, "ningún canal nuevo entra activo por default"). |

A diferencia de `hotel_messaging_config`, **solo `owner`/`gm`** pueden ver o modificar
esta fila (`webhook_url`/`webhook_secret` son una credencial de integración técnica
hacia el sistema del hotel, no algo que frontdesk necesite para soporte de primer
nivel a huéspedes).

Gestionable vía `PUT /hoteles/:hotelId/integraciones/pms-outbound` (`{webhookUrl,
taskTypes, enabled, rotateSecret}`), `GET` para leerla (incluido el secreto vigente,
para copiarlo al sistema del hotel), `DELETE` para desconectar por completo.

## Enganche a la creación de tareas

`syncTaskToOutboundConnectorBestEffort()` (`packages/agent-core/src/tools/
outboundTaskSync.ts`) se llama **después** de que `crear_tarea_housekeeping`/
`crear_ticket_mantenimiento`/`crear_ticket_huesped` (agent-core) ya insertaron la fila
local — en los TRES call sites de creación, sin importar el canal de entrada:

- `apps/api/src/routes/housekeeping.ts` (UI de staff)
- `apps/api/src/routes/mantenimiento.ts` (UI de staff)
- `apps/api/src/routes/tickets.ts` (formulario/QR/staff)
- `apps/api/src/routes/reputacion.ts` (clasificador de reseñas → ticket de mantenimiento automático)
- `apps/api/src/routes/vozElevenlabs.ts` (agente de voz real)
- `apps/api/src/routes/agentes.ts` (`AgentRunner`, incluida la escalación de "menor no acompañado")

### Best-effort, a propósito

Este backend es la capa de entrada; la fuente de verdad **local**
(`housekeeping_task`/`maintenance_ticket`/`guest_ticket`, ya insertada ANTES de llamar
al conector) **nunca** depende de que el sistema del hotel esté disponible. Un fallo de
red/HTTP/timeout hacia el sistema del hotel:

- **nunca** revierte ni bloquea la creación local de la tarea;
- se captura en `OutboundTaskSyncGateway.syncTask()` (y de nuevo, como última línea de
  defensa, en `syncTaskToOutboundConnectorBestEffort()`);
- se refleja en `data.outboundSync` del resultado de la tool (`{delivered, reason}`)
  para observabilidad — la tool sigue reportando éxito (`ok: true`) igual, porque la
  tarea LOCAL sí se creó correctamente.

Sin `hotel_pms_outbound_config` (el caso común hoy — un hotel independiente, o uno de
cadena que aún no conectó su sistema) `data.outboundSync` simplemente no aparece en la
respuesta: no es un error, es la ausencia esperada de una integración opcional.

### Por qué el enganche vive donde vive (capas)

`agent-core` sigue **sin depender** de `@atiende-hoteles/mcp-outbound` (H6a, núcleo sin
dependencias externas al paquete) — declara `OutboundTaskSyncLike`, la forma
estructural mínima que necesita (`syncTask(task): Promise<result|null>`), mismo patrón
que `WhatsappSenderLike` (`messagingTools.ts`). `OutboundTaskSyncGateway`
(`mcp-outbound`) la cumple sin adaptador.

`OutboundTaskSyncGateway` (no `agent-core`) es quien conoce el nombre de la tabla
`hotel_pms_outbound_config` y quien la consulta — y lo hace con una conexión **sin
RLS** (`engine.admin`, inyectada por `apps/api`), a propósito: decidir si este proceso
debe reenviar una tarea al sistema del hotel es una decisión **interna del sistema**,
nunca debe depender de qué rol tenga el staff que disparó la creación de la tarea
(housekeeping, frontdesk, o el agente conversacional sin sesión de staff real) — mismo
criterio que `PostgresApprovalQueue` y los planificadores de este repo
(`ticketEscalation.ts`, `nightAuditScheduler.ts`) usan `engine.admin` para sus propias
decisiones internas.

## Cómo probarlo con un sistema real (siguiente paso, pendiente de hotel piloto)

1. El hotel expone un endpoint HTTP que acepta `POST` con el contrato de
   `OutboundTask` (ver `port.ts`) y verifica `X-Atiende-Signature` con
   HMAC-SHA256 sobre el cuerpo crudo.
2. `PUT /hoteles/:hotelId/integraciones/pms-outbound` con esa URL, los `taskTypes` que
   el hotel quiera recibir, y `enabled: true`.
3. Copiar el `webhookSecret` devuelto al sistema del hotel (o generar uno nuevo con
   `rotateSecret: true` si el hotel lo pide en otro formato).
4. Crear una tarea de prueba (p. ej. `POST /hoteles/:hotelId/housekeeping/tareas`) y
   confirmar en la respuesta que `data.outboundSync.delivered === true`.

Hasta que exista un hotel piloto real, la evidencia disponible es exactamente la de
las pruebas de contrato/integración listadas arriba — nunca asumas que "probablemente
funciona" contra un sistema real (HotSOS/Optii/cualquier otro) a partir de esa
evidencia.
