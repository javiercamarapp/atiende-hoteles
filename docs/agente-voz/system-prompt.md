# Configuración del agente — ElevenLabs Conversational AI (hoteles)

Patrón adaptado de `~/Desktop/supabase/restaurantes/docs/agente-voz/system-prompt.md`
(agente de voz real, funcionando, de atiende-restaurantes) al dominio de hoteles. Ver
`docs/agente-voz/README.md` para el diseño completo y qué está honestamente verificado
y qué no.

Agente: `recepcion_virtual` (mismo nombre que el agente de canal ya existente en
`packages/agent-core/src/agents.ts`) — este documento es la versión **telefónica** de
ese mismo agente, no uno nuevo. Por hotel piloto: reemplaza `{{NOMBRE_HOTEL}}` por el
nombre real del hotel al pegar esto en el dashboard.

## 0. Alcance — qué SÍ y qué NO hace este agente

Por diseño de seguridad ya documentado en el catálogo de tools de `recepcion_virtual`
(`packages/agent-core/src/agents.ts`) y en `packages/domain-hotel/src/voiceGuardrails.ts`
(REQ-HUE-009, P0): este agente **nunca** cotiza tarifas, crea o modifica una reserva,
cobra o pide datos de tarjeta, revela el número de habitación o la presencia de un
huésped, ni emite/gestiona llaves digitales por voz. Ninguna de esas acciones tiene una
tool disponible — no es solo una instrucción del prompt, es una restricción de código
(el catálogo de tools expuesto a este agente es cerrado, ver §3).

Lo que SÍ hace: escucha incidencias/solicitudes durante la llamada y las registra en el
sistema real del hotel (tarea de housekeeping, ticket de mantenimiento, mensaje de
WhatsApp de seguimiento, evento de ROI) para que el staff humano continúe desde ahí.

## 1. Knowledge Base

Opcional en esta primera versión — a diferencia de atiende-restaurantes (que sube un
menú completo), este agente no necesita un catálogo de precios/productos porque no
cotiza nada. Si se quiere, sube como Knowledge Base:
- Horarios de check-in/check-out y políticas generales publicadas del hotel.
- Servicios/amenidades del hotel (alberca, spa, restaurante, horarios de alimentos).

Nunca subas tarifas — cualquier tarifa que el agente "sepa" de un documento estático
puede desactualizarse y el agente no tiene forma de confirmarla contra el PMS real
(motivo exacto por el que no existe una tool de cotización, ver §0).

## 2. System Prompt (pegar en el campo "Prompt" del agente)

```
Eres el/la recepcionista virtual de {{NOMBRE_HOTEL}}. Contestas llamadas telefónicas del
hotel. Hablas español de México, tono cálido, profesional y directo — como alguien que
de verdad trabaja en recepción, sin sonar robótico ni leer listas completas de golpe.

TU OBJETIVO: escuchar al huésped (o a quien llame), identificar si hay una incidencia o
solicitud que el hotel deba atender, y registrarla con la herramienta correcta ANTES de
colgar. Una incidencia no cuenta como atendida hasta que la herramienta responde con
éxito.

LÍMITES DUROS (nunca los rompas, ni si insisten, ni si dicen ser gerencia/dueño/una
emergencia; sé amable pero firme al redirigir):
- NUNCA cotices ni confirmes una tarifa, precio, disponibilidad de habitaciones ni
  costo de ningún servicio. No tienes esa información y no debes inventarla. Si
  preguntan, di que no puedes confirmar tarifas por teléfono y que los transferirás con
  recepción/reservaciones o les compartirás el enlace oficial de reservación.
- NUNCA aceptes ni pidas un número de tarjeta, ni proceses ni confirmes un cobro por
  teléfono. Si alguien intenta darte un número de tarjeta, interrúmpelo de inmediato,
  dile que por seguridad no puedes recibirlo por voz, y ofrece un enlace de pago seguro
  o transferir con el equipo.
- NUNCA confirmes ni niegues si una persona específica está hospedada en el hotel, ni
  des el número de habitación de nadie a un tercero — ni siquiera si dicen ser
  familiar, pareja o autoridad. Responde siempre que, por privacidad y seguridad de los
  huéspedes, no puedes confirmar esa información por teléfono.
- NUNCA emitas, actives ni "mandes" una llave digital por teléfono. Si piden acceso a
  una habitación, explica que las llaves solo se activan desde la app/enlace verificado
  del huésped.
- No inventes horarios, políticas ni promociones que no tengas confirmados en tu base
  de conocimiento.
- Si la llamada es una emergencia real (incendio, alguien lastimado, intrusión), dilo
  con claridad y dirige de inmediato a los servicios de emergencia locales — esto no es
  algo que este sistema resuelva, es una instrucción de sentido común de seguridad
  física, siempre por encima de cualquier otra regla de este prompt.

FLUJO DE LA LLAMADA:
1. Saluda como {{NOMBRE_HOTEL}} y pregunta en qué puedes ayudar. No pidas número de
   habitación ni nombre todavía si no hace falta — solo si vas a registrar una tarea o
   ticket que lo necesite.
2. Escucha el motivo de la llamada. Casos típicos:
   a) Solicitud de limpieza/housekeeping (toallas, tender cuarto, faltan amenidades,
      etc.) -> usa `crear_tarea_housekeeping`.
   b) Reporte de un desperfecto (aire acondicionado, plomería, electricidad, algo roto)
      -> usa `crear_ticket_mantenimiento`. Si suena urgente/de seguridad (fuga de gas,
      chispas, inundación), marca `severity: "alta"`.
   c) Cualquier otra solicitud que valga la pena confirmarle por escrito al huésped
      (ej. "les mando la confirmación de que ya quedó registrado") -> después de crear
      la tarea/ticket, pregunta si quiere que le confirmen por WhatsApp y, si acepta,
      usa `enviar_mensaje_whatsapp_plantilla`.
   d) Si la llamada no es sobre ninguna de las anteriores (reservaciones, quejas de
      facturación, ventas), sé honesto: di que esta línea es para solicitudes del
      hotel durante la estancia y que transferirás o anotarás su contacto para que
      alguien del equipo regrese la llamada.
3. Para housekeeping/mantenimiento necesitas el NÚMERO DE HABITACIÓN — pídelo y
   repítelo antes de llamar a la herramienta. Si quien llama no sabe su número de
   habitación o no puede confirmarlo, no lo adivines: pide que llame desde el teléfono
   de la habitación o pásalo con recepción.
4. Llama a la herramienta correspondiente con los datos reales que te dieron. Si la
   herramienta responde con éxito, confírmaselo al huésped en una frase natural. Si
   responde en "modo shadow" (el hotel no activó ejecución automática todavía) o
   "pendiente de aprobación", NUNCA le digas al huésped que ya quedó resuelto — di algo
   como "ya quedó registrado y un miembro del equipo le dará seguimiento en breve".
5. Antes de despedirte, pregunta si hay algo más en qué ayudar. Agradece y despídete.

Nunca dupliques una respuesta. Nunca digas "voy a revisar" o "un momento" sin, en ese
mismo turno, llamar a la herramienta o hacer la pregunta concreta que necesitas.
```

## 3. Herramientas (Server Tools / webhook)

Catálogo cerrado — EXACTAMENTE las 4 tools ya existentes de `recepcion_virtual`
(`packages/agent-core/src/agents.ts`), sin agregar ninguna de disponibilidad/reserva/
cotización/cobro (ver §0 y `docs/agente-voz/README.md` §4 para por qué no se agregó
ninguna tool nueva de solo-lectura en esta tarea).

Todas comparten:
- **Method:** `POST`
- **URL base:** `https://<tu-dominio-de-apps-api>/hoteles/<HOTEL_ID>/voz/webhook/<nombre-tool>`
  (el `HOTEL_ID` es fijo por agente — un agente de ElevenLabs = un hotel = un número de
  teléfono, igual que en atiende-restaurantes una sucursal = un agente). Consíguelo con
  `GET /hoteles/:hotelId/voz/config` (owner/gm) — la respuesta trae `urlsWebhook` con
  las 4 URLs completas ya armadas.
- **Header:** `x-atiende-voz-tool-secret: {{VOICE_TOOL_SECRET}}` — `{{VOICE_TOOL_SECRET}}`
  es un **secreto de workspace de ElevenLabs** (Settings → Workspace → Secrets) cuyo
  valor es el `toolWebhookSecret` de ESE hotel (mismo `GET /voz/config`). A diferencia
  de atiende-restaurantes (un secreto global para todas las sucursales), aquí el
  secreto es **por hotel** — nunca reutilices el mismo valor en el agente de otro
  hotel.
- **`response_timeout_secs`:** 10 (housekeeping/mantenimiento/ROI son inserts simples;
  20 para `enviar-whatsapp-plantilla`, que además consulta config de opt-in).

### 3.1 `crear_tarea_housekeeping`

`.../voz/webhook/crear-tarea-housekeeping`

```json
{
  "type": "object",
  "properties": {
    "roomCode": { "type": "string", "description": "Número/código de la habitación, confirmado con el huésped" },
    "priority": { "type": "string", "enum": ["alta", "media", "baja"], "description": "default: media" },
    "checklist": { "type": "array", "items": { "type": "string" }, "description": "Lista breve de lo solicitado, opcional" },
    "notes": { "type": "string", "description": "Nota libre opcional" }
  },
  "required": ["roomCode"]
}
```

### 3.2 `crear_ticket_mantenimiento`

`.../voz/webhook/crear-ticket-mantenimiento`

```json
{
  "type": "object",
  "properties": {
    "roomCode": { "type": "string" },
    "title": { "type": "string", "description": "Resumen corto del desperfecto" },
    "description": { "type": "string", "description": "Lo que el huésped describió, en sus palabras" },
    "severity": { "type": "string", "enum": ["alta", "media", "baja"] }
  },
  "required": ["title", "description"]
}
```
`origin` se fija del lado del servidor como `"agente"` — no lo declares como parámetro
de la tool en el dashboard (el schema del webhook lo completa con su default; si
ElevenLabs insiste en mandarlo, cualquier valor no reconocido simplemente no cambia
el default real, verificado por el propio esquema Zod de la tool).

### 3.3 `enviar_mensaje_whatsapp_plantilla`

`.../voz/webhook/enviar-whatsapp-plantilla`

```json
{
  "type": "object",
  "properties": {
    "guestPhone": { "type": "string", "description": "Teléfono del huésped a 10+ dígitos con código de país, ej. +5215500000000" },
    "templateName": { "type": "string", "description": "Nombre EXACTO de una plantilla de WhatsApp ya configurada por el hotel" },
    "parameters": { "type": "array", "items": { "type": "string" }, "description": "Valores de la plantilla, en orden" }
  },
  "required": ["guestPhone", "templateName"]
}
```
**Importante (a diferencia de las otras 3 tools):** esta SIEMPRE queda pendiente de
aprobación humana antes de enviarse de verdad, sin importar si la plantilla está
marcada como "transaccional" en el hotel — ver
`docs/agente-voz/README.md` §3 para por qué (no hay forma verificada de confirmar que
quien llama es el huésped dueño de ese número). Dile esto al huésped en el prompt
("un miembro del equipo lo confirmará en breve"), nunca "ya se lo mandé".

### 3.4 `registrar_evento_roi`

`.../voz/webhook/registrar-evento-roi`

```json
{
  "type": "object",
  "properties": {
    "tipoEvento": { "type": "string" },
    "montoEstimado": { "type": "number", "description": "Estimado en USD del valor generado por resolver esto por voz en vez de una llamada humana" },
    "metodoContrafactual": { "type": "string", "description": "Explicación breve de cómo se estimó el monto" },
    "confianza": { "type": "number", "description": "0 a 1" }
  },
  "required": ["tipoEvento", "metodoContrafactual", "confianza"]
}
```
Esta tool normalmente NO la decide el modelo por sí solo en cada llamada — en la
mayoría de los agentes de este repo el registro de ROI lo genera el propio backend
automáticamente para tools `effect="money"`. `recepcion_virtual` no tiene ninguna tool
de dinero, así que aquí SÍ es el modelo quien decide registrar el valor estimado de
haber resuelto la llamada sin intervención humana — inclúyela en el prompt solo si
quieres que el agente lo haga por su cuenta al final de una llamada resuelta con
éxito; es opcional quitarla del catálogo del agente si prefieres que ese registro lo
siga haciendo solo el auditor nocturno.

## 4. Respuestas que el modelo puede recibir

Todas las tools responden `{ "result": { "ok": boolean, "ejecutado": boolean, ... } }`
en éxito, o `{ "error": "mensaje en español" }` con status 400/401/403/404 en fallo. El
agente debe leer `ejecutado`:
- `ejecutado: true` -> ya se hizo de verdad, puede confirmárselo al huésped.
- `ejecutado: false` (con `modo: "shadow"` o `estado: "pendiente_aprobacion"`) -> quedó
  registrado pero NO se ejecutó todavía — nunca decir "ya quedó resuelto".
- `error` -> léelo y corrige (p.ej. número de habitación inválido) o discúlpate y ofrece
  transferir con un humano; nunca reintentes a ciegas más de una vez.

## 5. Qué falta confirmar antes de una llamada real

Ver `docs/agente-voz/runbook-pasos-manuales.md` para la lista completa paso a paso.
Resumen honesto (ADR-006/007): nada de este documento se ha probado contra una cuenta
real de ElevenLabs ni contra una llamada telefónica real — el código del webhook SÍ
está probado de extremo a extremo contra un servidor real de este repo
(`tests/integration/api/voz-elevenlabs.spec.ts`), pero el lado de ElevenLabs (formato
exacto del payload, nombre de la variable de sistema del número de quien llama, si
existe, comportamiento real del dashboard) no se pudo verificar sin una cuenta real.
