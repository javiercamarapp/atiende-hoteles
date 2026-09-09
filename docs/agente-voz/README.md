# Agente de voz — ElevenLabs Conversational AI (hoteles)

Telefonía/voz real para `recepcion_virtual`, siguiendo el mismo patrón del repo hermano
`~/Desktop/supabase/restaurantes` (agente de voz real y funcionando: ElevenLabs maneja
telefonía + modelo de voz de punta a punta vía su propia plataforma de agentes — no
Twilio+STT/TTS por separado). Rama: `fix/voz-elevenlabs`.

## Índice

1. `system-prompt.md` — el prompt real para pegar en el dashboard de ElevenLabs, el
   contrato de las 4 tools (URL/headers/body), y los límites duros del agente.
2. `configuracion-agente.md` — cómo se adaptó el mecanismo de autenticación/config de
   `agent-config`/`agent-config-auth.ts` de restaurantes a este stack (Hono/Node +
   Postgres/RLS en vez de Supabase Edge Functions/Vault), y qué se adaptó DISTINTO
   (secreto por hotel, no proxy en vivo a la API de ElevenLabs) y por qué.
3. `webhook-contrato.md` — honestidad explícita: qué del contrato con ElevenLabs está
   100% verificado (nuestro lado, el servidor) y qué no se pudo confirmar sin una
   cuenta real (forma exacta del payload, variables de sistema de telefonía entrante).
4. `runbook-pasos-manuales.md` — la lista paso a paso de lo que falta hacer a mano:
   crear el agente, pegar el prompt, configurar cada tool, comprar/portar el número.

## 0. Principio de esta tarea (ADR-006/007, "esqueleto honesto")

Todo lo implementado en `apps/api/src/routes/vozElevenlabs.ts` es la llamada HTTP REAL
que ElevenLabs necesita para invocar tools durante una llamada — no un stub. Se pudo
probar de extremo a extremo (`tests/integration/api/voz-elevenlabs.spec.ts`, 13 casos,
contra una base de datos real) porque en esta dirección **nosotros somos el servidor**.
Lo que NO se pudo probar es el lado de ElevenLabs (no hay cuenta real en este entorno) —
eso queda explícito en `webhook-contrato.md` y como checklist en
`runbook-pasos-manuales.md`, nunca como "probablemente funciona" sin decirlo.

## 1. Qué se auditó antes de escribir código

Se leyó completo el patrón real ya funcionando del repo hermano:
- `restaurantes/docs/agente-voz/system-prompt.md` (system prompt real con reglas de
  negocio y tool-calling).
- `restaurantes/supabase/functions/agent-config/index.ts` y
  `_shared/agent-config-auth.ts` (cómo se autentica/configura el agente de ElevenLabs).
- `restaurantes/supabase/functions/{create-order,cotizar-pedido,customer-lookup}/index.ts`
  (cómo se exponen tools reales vía webhook, con secreto compartido
  `x-atiende-tool-secret`/`VOICE_TOOL_SECRET`).
- `restaurantes/scripts/voice-widget-console.mjs` y las migraciones de
  `voice_preview_sessions` (mecanismo de preview de conversaciones desde el panel admin
  — no se replicó en hoteles en esta tarea, ver §5).

Y de este repo (hoteles): el catálogo de tools de `recepcion_virtual`
(`packages/agent-core/src/agents.ts`), el motor de gate/aprobación
(`packages/agent-core/src/runner.ts`), los guardrails de voz ya existentes
(`packages/domain-hotel/src/voiceGuardrails.ts`, REQ-HUE-009 P0) y el punto donde el
código YA reconocía que faltaba esto: el comentario de
`apps/api/src/routes/agentes.ts` que dice "el canal de voz real (telefonía/PBX) no
existe todavía en este repo (pendiente-hardware)".

## 2. Qué se construyó

- Migración `packages/db/migrations/0125_hotel_voice_agent_config.sql`: tabla por
  hotel con secreto de webhook, `elevenlabs_agent_id` (bookkeeping) y flag `enabled`
  (BP-016, apagado por default).
- `apps/api/src/routes/vozElevenlabs.ts`: el webhook público que ElevenLabs invoca
  (`POST /hoteles/:hotelId/voz/webhook/:toolName`) para las 4 tools ya existentes de
  `recepcion_virtual`, más los 3 endpoints de configuración (staff autenticado).
- `tests/integration/api/voz-elevenlabs.spec.ts`: 13 casos contra una BD real.
- `scripts/voz-elevenlabs-webhook-simulator.ts`: simulador local (contra `npm run dev`
  de este repo, NUNCA contra ElevenLabs real) del flujo completo llamada→tool→respuesta.

## 3. Decisión de seguridad más importante de esta tarea

El gate `shadow`/`propone`/`autopilot` del hotel para `recepcion_virtual`
(`agent_config`, el mismo que ya gobierna el canal de texto/WhatsApp) **sigue
aplicando dentro de este webhook**, exactamente como dentro de `AgentRunner`
(`runner.ts`): mientras el hotel siga en `"shadow"` (default), ninguna tool con efecto
distinto a lectura se ejecuta de verdad — el webhook responde honesto
(`ejecutado: false, modo: "shadow"`). Sin este chequeo, el canal de voz habría sido una
puerta trasera con autopilot real desde el día 1, sin que el hotel lo hubiera activado
para ningún otro canal.

Segunda decisión relacionada: `enviar_mensaje_whatsapp_plantilla` **siempre** cae en
aprobación humana para este canal (nunca auto-aprobación de "plantilla transaccional"),
porque ese auto-aprobado depende de verificar que el destinatario es el huésped YA
IDENTIFICADO de la conversación (`ctx.guestPhone`) — este webhook no tiene esa
verificación (ver §5), así que se codifica el actor como `"voz"` en vez de `"guest"`, lo
que hace que `transactionalTemplateCheckFromDb` (agent-core) rechace el auto-aprobado de
forma determinista.

## 4. Por qué NO se agregó ninguna tool nueva de solo-lectura

El encargo permitía agregar una tool de solo-lectura razonable (ej. "consultar estado de
una reserva/ticket propio") si se documentaba por qué es segura. Se decidió NO
agregarla en esta tarea: la única forma de que fuera segura es verificar que quien
pregunta es el mismo huésped dueño de esa reserva/ticket — y eso requeriría cruzar el
número de quien llama (si ElevenLabs lo expone en una variable de sistema, no
confirmado, ver `webhook-contrato.md` §2.3) contra una reserva activa. Construir esa
tool sin poder verificar esa pieza habría sido exactamente el tipo de "probablemente
funciona" que ADR-006/007 prohíben — mejor documentarlo como pendiente que construir un
mecanismo de identidad a medias sobre un canal que además tiene un guardrail P0
específico contra revelar habitación/presencia (`REQ-HUE-023`).

## 5. Qué no se replicó de restaurantes (alcance explícito)

- **Proxy en vivo a la API de ElevenLabs** (`agent-config/index.ts` completo: editar
  prompt/voz/tools/knowledge-base desde un panel) — ver `configuracion-agente.md` §3.2.
- **`voice_preview_sessions`** (mecanismo de preview de conversaciones simuladas desde
  el panel admin sin escribir datos reales) — no aplica sin el proxy anterior; si se
  construye el proxy en el futuro, este es el siguiente candidato natural a portar.
- **Sync automático de Knowledge Base** desde tablas reales del hotel — este agente no
  necesita KB rica porque no cotiza nada (ver `system-prompt.md` §1); si se agrega
  contenido informativo (horarios/amenidades), puede subirse manualmente por ahora.

## 6. Suite de pruebas relevante corrida antes de comitear

```bash
npm run typecheck
npx eslint apps/api/src/routes/vozElevenlabs.ts tests/integration/api/voz-elevenlabs.spec.ts scripts/voz-elevenlabs-webhook-simulator.ts
node --experimental-strip-types scripts/check-migraciones.ts
npx vitest run tests/integration/api/voz-elevenlabs.spec.ts
npm test   # suite completa (unit + integration + adversarial)
```
