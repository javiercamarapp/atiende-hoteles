# Mecanismo de configuración/autenticación del agente de voz (hoteles)

Este documento explica CÓMO se adaptó el patrón real de
`~/Desktop/supabase/restaurantes/supabase/functions/{agent-config,agent-config-auth}.ts`
al stack de hoteles (Hono/Node, `apps/api`, sin Supabase Edge Functions), y por qué
algunas piezas se adaptaron distinto en vez de copiarse literal.

## 1. Lo que restaurantes hace y por qué

`agent-config/index.ts` (restaurantes) es un **proxy autenticado hacia la API real de
ElevenLabs**: el panel admin del restaurante llama a esta función con su JWT de staff,
la función valida permisos (`agent-config-auth.ts`: rol de staff sobre el restaurante
dueño del `agent_id`) y, si procede, llama ella misma a `api.elevenlabs.io` con una API
key real guardada en Supabase Vault. Esto le permite al dueño editar el prompt, la voz,
las tools y la base de conocimiento del agente **sin salir del panel ni tocar el
dashboard de ElevenLabs directamente**.

## 2. Qué se adaptó igual (mismo patrón, stack distinto)

- **Autorización por tenant antes de tocar cualquier secreto**: igual que
  `authorizeAgentConfig()` valida rol de staff + que el `agent_id` pertenezca al
  restaurante del llamador ANTES de leer la API key de Vault, `apps/api/src/routes/
  vozElevenlabs.ts` usa `requireHotelMembership` + `assertRole(ADMIN_ROLES)` ANTES de
  leer o rotar `hotel_voice_agent_config.tool_webhook_secret`.
- **Secreto real fuera del código**, nunca hardcodeado ni devuelto a un rol que no lo
  necesita — aquí vive en la tabla `hotel_voice_agent_config` (RLS: solo owner/gm
  pueden leer/escribir, ver migración `0126_hotel_voice_agent_config.sql`), no en
  Supabase Vault (este repo no usa Supabase; el equivalente real es Postgres + RLS, que
  es exactamente el mecanismo de secretos que YA usa este repo para
  `hotel_messaging_config.webhook_secret`, `routes/mensajeria.ts`).
- **Nunca se expone el secreto/API key a quien no lo necesita**: `GET /voz/config`
  restringido a `ADMIN_ROLES` (owner/gm), igual de estricto que `GET /mensajeria/config`
  en este mismo repo (mensajeria.ts sí es más laxo en su política de RLS pero también
  restringe el endpoint HTTP a `ADMIN_ROLES`, mismo criterio aplicado aquí).

## 3. Qué se adaptó DISTINTO (decisión explícita, no descuido)

### 3.1 Secreto por hotel, no un secreto global

atiende-restaurantes usa **un solo** `VOICE_TOOL_SECRET` (variable de entorno) para
TODAS las sucursales — razonable ahí porque todas las sucursales de un mismo
restaurante comparten cuenta y el aislamiento entre restaurantes distintos no es el eje
central de seguridad de ese producto todavía.

En hoteles, el aislamiento por tenant (REQ-TEN-\*) es el invariante de seguridad
**central** de todo el repo — casi cada tabla tiene RLS por `hotel_id`/`org_id`, y hay
una batería completa de tests (`tests/adversarial/agentes-aislamiento.spec.ts`, etc.)
dedicada exactamente a esto. Copiar un secreto GLOBAL para todos los hoteles habría sido
la primera grieta real en ese invariante: cualquier fuga del secreto (un log, un
dashboard mal configurado en UN hotel) comprometería a TODOS los hoteles a la vez. Por
eso `hotel_voice_agent_config.tool_webhook_secret` es un valor distinto por hotel,
generado con `randomUUID()` la primera vez que un owner/gm abre `GET /voz/config`, y
rotable sin downtime con `POST /voz/config/rotar-secreto`.

### 3.2 No existe un proxy que llame en vivo a la API de ElevenLabs

**Decisión explícita de alcance de esta tarea, documentada aquí en vez de construirse a
medias:** este repo NO incluye un equivalente de `agent-config/index.ts` de
restaurantes (el que hace `PATCH https://api.elevenlabs.io/v1/convai/agents/:id` para
editar el prompt/voz/tools/knowledge-base en vivo desde un panel). Dos razones, ambas
de honestidad (ADR-006/007), no de flojera:

1. **No hay credenciales reales de ElevenLabs en este entorno** (ni una API key, ni una
   cuenta con agentes creados). Un proxy que LLAMA a la API de ElevenLabs es código
   donde NOSOTROS somos el cliente/llamador — no hay forma honesta de probarlo de
   extremo a extremo sin esa cuenta real (a diferencia del webhook de tools, donde
   NOSOTROS somos el servidor/receptor: eso sí se pudo probar 100% de verdad, ver
   `tests/integration/api/voz-elevenlabs.spec.ts`). Construirlo sin poder ejecutarlo ni
   una sola vez contra el servicio real sería exactamente el tipo de "probablemente
   funciona" que el principio de este repo prohíbe.
2. **No es el mecanismo crítico que ElevenLabs exige para funcionar.** El prompt y la
   configuración de tools del agente se pegan/configuran MANUALMENTE en el dashboard de
   ElevenLabs la primera vez (ver `runbook-pasos-manuales.md`) — así es como
   atiende-restaurantes probó su agente ANTES de construir el panel de edición en vivo
   (su propio `system-prompt.md` dice "pegar en el campo Prompt del agente", no "pégalo
   en nuestro panel"). Lo que SÍ es indispensable, y SÍ está completamente implementado
   y probado aquí, es el lado que ElevenLabs invoca en cada llamada real: el webhook de
   tools (`/voz/webhook/:toolName`).

Si más adelante se consigue una cuenta real de ElevenLabs y se quiere un panel de
edición en vivo, el patrón a seguir es exactamente `agent-config/index.ts` de
restaurantes, adaptado a Hono (mismo criterio de "declarar `no_configurado` sin
`ELEVENLABS_API_KEY`" que ya usa este repo para Anthropic/OpenRouter en
`apps/api/src/routes/agentes.ts` `EnvProvider`).

### 3.3 `hotel_voice_agent_config` es bookkeeping, no el mecanismo de resolución de tenant

A diferencia de restaurantes (donde `branches.elevenlabs_agent_id` es la ÚNICA forma de
saber a qué restaurante pertenece una llamada entrante, porque todas las sucursales
comparten una sola URL de función), en hoteles el `:hotelId` va directo en la URL del
webhook (`/hoteles/:hotelId/voz/webhook/:toolName`) — mismo criterio que YA usa este
repo para `mensajeria.ts`/`aprobacionesWhatsapp.ts`. `elevenlabs_agent_id` en la tabla
es solo para que un humano pueda auditar "qué agente de ElevenLabs corresponde a este
hotel", nunca se usa para resolver el tenant de una petición entrante.

## 4. Endpoints reales de este repo

| Método | Ruta | Rol | Qué hace |
|---|---|---|---|
| `GET` | `/hoteles/:hotelId/voz/config` | owner/gm | Secreto actual, `elevenlabs_agent_id`, si está habilitado, el gate vigente de `recepcion_virtual`, y las 4 URLs de webhook ya armadas |
| `PATCH` | `/hoteles/:hotelId/voz/config` | owner/gm | Fija `elevenlabsAgentId` (bookkeeping) y/o `habilitado` (activa/desactiva el canal) |
| `POST` | `/hoteles/:hotelId/voz/config/rotar-secreto` | owner/gm | Genera un secreto nuevo; el anterior deja de servir de inmediato |
| `POST` | `/hoteles/:hotelId/voz/webhook/:toolName` | público (secreto por header) | El que ElevenLabs invoca durante la llamada real — ver `webhook-contrato.md` |

`:toolName` ∈ `crear-tarea-housekeeping`, `crear-ticket-mantenimiento`,
`enviar-whatsapp-plantilla`, `registrar-evento-roi` (catálogo cerrado, cualquier otro
valor es 404).
