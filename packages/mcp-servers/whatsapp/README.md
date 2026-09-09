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

**[NO VERIFICADO CONTRA META REAL]**. Requiere `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` (ver `apps/api/.env.example` para los
pasos exactos de cómo obtener cada una). Sin las 3, `status()` reporta `unavailable` y
ningún método llama a `graph.facebook.com` -- `apps/api/src/lib/messaging.ts` selecciona
este adaptador solo cuando están presentes (`resolveWhatsappAdapter()`, mismo patrón que
`resolveEmailPort` de `packages/email`).

Con las 3 credenciales presentes, este adaptador SÍ hace llamadas HTTP reales:

- `sendTemplateMessage`/`sendTextMessage`/`sendInteractiveButtonsMessage` -- `POST
  https://graph.facebook.com/{GRAPH_API_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages`
  con `Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}`, reintentos con backoff ante `429`
  (`Retry-After`), e idempotencia por `clientMessageId` (nunca reenvía dos veces el mismo
  mensaje ante un reintento del llamador -- Graph API no ofrece esto nativo).
- `verifyAndNormalizeWebhook` -- verifica `X-Hub-Signature-256` (HMAC-SHA256 del cuerpo
  crudo con `WHATSAPP_APP_SECRET`, comparación en tiempo constante,
  `packages/mcp-servers/shared/src/hmac.ts`) y normaliza la forma REAL documentada del
  payload de Meta (mensaje de texto, clic de Interactive Reply Button, Flow completado,
  actualización de estado `sent|delivered|read|failed`) al `WhatsappWebhookEvent` del
  puerto. Fail-closed: sin `WHATSAPP_APP_SECRET`, o con firma ausente/inválida/de un
  secreto distinto, SIEMPRE se rechaza -- nunca se acepta en silencio ni se cae a un
  secreto por defecto.

**Por qué "NO verificado" y no "listo"**: este código implementa el contrato
documentado de WhatsApp Cloud API y pasa una prueba de CONTRATO real contra un
simulador HTTP local (`tests/support/whatsappCloudApiSimulator.ts`, servidor `node:http`
que imita `POST /{phone-number-id}/messages` -- nunca un mock de `fetch`), ver
`tests/unit/mcp-servers/whatsapp/meta-adapter-real.spec.ts`. Pero sin credenciales de una
app de Meta for Developers disponibles en esta máquina de desarrollo, NUNCA se ha
ejecutado contra `graph.facebook.com` de verdad -- no se afirma que "probablemente
funciona": se afirma exactamente lo que se verificó (el contrato documentado, contra el
simulador) y se deja explícito lo que falta.

### Primera prueba real (pasos exactos)

1. Crea una cuenta de Meta Business (business.facebook.com) si no tienes una, y una app
   en developers.facebook.com/apps (tipo "Business") con el producto "WhatsApp" agregado.
2. **Modo de prueba (sin verificar un número propio)**: Meta da un número y un
   destinatario de prueba gratis en WhatsApp → Configuración de la API -- suficiente para
   la primera prueba real de extremo a extremo (enviar/recibir un mensaje real) sin
   verificar nada más.
3. Copia de esa misma pantalla: el "Token de acceso temporal" (`WHATSAPP_ACCESS_TOKEN`,
   expira en 24h -- para algo más duradero, crea un Usuario del Sistema en Business
   Settings con el permiso `whatsapp_business_messaging` y genera su token, sin
   expiración) y el "ID del número de teléfono" (`WHATSAPP_PHONE_NUMBER_ID`).
4. Configuración de la app → Básico: copia el "Secreto de la app"
   (`WHATSAPP_APP_SECRET`).
5. WhatsApp → Configuración → Webhooks: registra `https://<tu-dominio-público>/hoteles/
   {hotelId}/mensajeria/webhook` (necesita HTTPS público -- un túnel tipo ngrok sirve para
   esta primera prueba) con un token de verificación elegido por ti
   (`WHATSAPP_WEBHOOK_VERIFY_TOKEN`), y suscríbete al campo `messages`. Meta manda un GET
   inmediato con `hub.challenge` -- `apps/api/src/routes/mensajeria.ts` debe responderlo
   (ver más abajo) para que el webhook quede activo.
6. Con las 4 variables configuradas en `apps/api/.env`, reinicia `apps/api` y:
   - Envía una plantilla (`POST /hoteles/:hotelId/mensajeria/mensajes`, o desde el número
     de prueba de Meta manda un mensaje al número de prueba) y confirma en los logs de
     Meta for Developers que Graph API lo recibió.
   - Contesta desde el número de prueba de Meta y confirma que este backend lo recibe
     (fila nueva en `public.message`, disclosure de IA REQ-HUE-006 si es el primer turno).
7. Ese es el criterio de "verificado contra Meta real": hasta que alguien complete estos
   6 pasos y confirme el resultado, este README sigue diciendo `[NO VERIFICADO]` --
   actualízalo aquí mismo cuando se haga, con fecha y qué exactamente se probó.

## Adaptador simulado (`src/adapters/fake-whatsapp-adapter.ts`)

`FakeWhatsappAdapter` (`simulated: true`). Aplica el límite del tier configurado,
idempotencia por `clientMessageId`, y verifica HMAC/replay de webhooks con
`FAKE_WHATSAPP_APP_SECRET` (o, en `apps/api`, con el `webhook_secret` por hotel de
`hotel_messaging_config`, generado con `randomUUID()` -- válido SOLO para desarrollo y
pruebas: Meta real firma con un único `WHATSAPP_APP_SECRET` a nivel de app, nunca por
hotel).

## Pruebas

- `tests/unit/mcp-servers/whatsapp/contract.spec.ts` -- contrato contra el Fake siempre
  (tier, idempotencia, HMAC/replay); contra `MetaWhatsappAdapter` sin credenciales
  (declaración honesta de `unavailable`).
- `tests/unit/mcp-servers/whatsapp/meta-adapter-real.spec.ts` -- contrato REAL de
  `MetaWhatsappAdapter` contra `tests/support/whatsappCloudApiSimulator.ts` (envío de
  plantilla/texto/botones interactivos, idempotencia, backoff ante 429, normalización de
  webhook con la forma real de Meta, y el caso adversarial obligatorio: firma
  ausente/inválida/de otro secreto/cuerpo alterado SIEMPRE se rechaza).
- `tests/unit/api/messaging-adapter-selection.spec.ts` -- selección condicional por
  entorno (`resolveWhatsappAdapter`/`resolveWhatsappWebhookVerifier` de
  `apps/api/src/lib/messaging.ts`).
- `tests/integration/api/mensajeria-webhook-verificacion.spec.ts` -- GET de verificación
  de suscripción (`hub.challenge`), fail-closed sin `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.

## Estado

**[NO VERIFICADO CONTRA META REAL]** -- REQ-INT-003 cubierto: contrato, límite de tier y
adaptador simulado verificados; adaptador real implementa el contrato documentado de
Graph API (envío + verificación/normalización de webhook, incluido el GET de
suscripción) y pasa la prueba de contrato contra el simulador local, pero nunca se ha
ejecutado contra `graph.facebook.com` -- ver "Primera prueba real" arriba para los pasos
exactos que faltan.

**[LIMITACIÓN CONOCIDA]**: Meta Cloud API registra un único webhook por app, no uno por
número de WhatsApp -- este repo expone una URL por hotel
(`/hoteles/:hotelId/mensajeria/webhook`). Funciona sin cambios si cada hotel usa su
propia app de Meta; para un Tech Provider con Embedded Signup que comparta una sola app
entre varios hoteles, hace falta agregar un enrutamiento por `phone_number_id` del
payload hacia un único endpoint compartido -- no resuelto en este fix (fuera de su
alcance), dejado registrado aquí para la siguiente iteración.
