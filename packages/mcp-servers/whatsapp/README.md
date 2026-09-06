# @atiende-hoteles/mcp-whatsapp

Puerto de integración con WhatsApp Cloud API (Meta, H15-012), canal principal de
mensajería (REQ-INT-003, P0). Hito **H9**. Ver `docs/ARQUITECTURA.md` ADR-007 y
`docs/referencia/02-investigacion-H01-H11.md` H09.

## Contrato (`src/port.ts`)

`MessagingPort`: `sendTemplateMessage` (fuera de la ventana de servicio de 24h, plantilla
aprobada obligatoria), `sendTextMessage` (dentro de la ventana), `verifyAndNormalizeWebhook`
(mensajes entrantes + actualizaciones de estado). Estado de mensaje: `enviado|entregado|leido|fallido`
(mapeo 1:1 de los `statuses` nativos de Meta `sent|delivered|read|failed` -- es el único
canal, no hay ambigüedad de proveedor).

Límite de mensajería por tier (`MESSAGING_TIER_LIMITS`, ventana móvil de 24h):
`tier_1k` (1 000) / `tier_10k` / `tier_100k` / `unlimited`. Un envío N+1 sobre el límite
lanza `MessagingTierLimitError`.

## Adaptador real (`src/adapters/meta-whatsapp-adapter.ts`)

**[PENDIENTE DE CREDENCIALES]**. Requiere `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` (HMAC de webhooks vía Graph API
`X-Hub-Signature-256`). Sin ellas, `status()` reporta `unavailable` y ningún método
llama a `graph.facebook.com`. Esqueleto ya incluye ruta Graph (`GRAPH_API_VERSION`),
reintentos con backoff ante `429`, y verificación de firma de webhook (ejecutable sin
el resto de credenciales, ya que solo depende de `WHATSAPP_APP_SECRET`).

## Adaptador simulado (`src/adapters/fake-whatsapp-adapter.ts`)

`FakeWhatsappAdapter` (`simulated: true`). Aplica el límite del tier configurado,
idempotencia por `clientMessageId`, y verifica HMAC/replay de webhooks con
`FAKE_WHATSAPP_APP_SECRET`.

## Pruebas

`tests/unit/mcp-servers/whatsapp/` -- contrato contra el fake siempre; contra
`MetaWhatsappAdapter` real solo si las 3 credenciales están presentes.

## Estado

**[PENDIENTE DE CREDENCIALES]** -- REQ-INT-003 cubierto parcialmente: contrato, límite
de tier y adaptador simulado verificados; adaptador real pendiente de una cuenta Meta
Business + Tech Provider con Embedded Signup.
