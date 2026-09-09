# Runbook — Pasos manuales pendientes para la primera llamada real

Nada de esto se ha ejecutado en este entorno (no hay cuenta de ElevenLabs ni número de
teléfono real conectados). Es la lista exacta, paso a paso, de lo que falta para que un
hotel piloto reciba una llamada telefónica real atendida por este agente.

## 0. Prerrequisitos

- [ ] Cuenta de ElevenLabs con acceso a Conversational AI (plan que incluya telefonía).
- [ ] Este backend (`apps/api`) desplegado y accesible por HTTPS público (ElevenLabs no
      puede llamar a `localhost`) — ver `deploy/api/` de este repo para las opciones ya
      documentadas (Docker/Vercel).
- [ ] El hotel piloto ya sembrado/dado de alta en la base de datos real (no el seed de
      desarrollo) — necesitas su `hotelId` real.

## 1. Configurar el canal en este backend

```bash
# Autenticado como owner/gm del hotel piloto:
curl -X PATCH https://<tu-dominio>/hoteles/<HOTEL_ID>/voz/config \
  -H "Authorization: Bearer <TOKEN_STAFF>" -H "Content-Type: application/json" \
  -d '{"habilitado": true}'

curl https://<tu-dominio>/hoteles/<HOTEL_ID>/voz/config \
  -H "Authorization: Bearer <TOKEN_STAFF>"
# -> guarda `toolWebhookSecret` y las 4 `urlsWebhook` de la respuesta, las necesitas abajo.
```

- [ ] Decide el gate real de `recepcion_virtual` para este hotel ANTES de la primera
      llamada real: mientras siga en `"shadow"` (default), ninguna tarea/ticket/mensaje
      se crea de verdad — la llamada se sentirá "atendida" para el huésped pero nada
      queda registrado en el sistema. Para un piloto real, fíjalo a `"propone"`:
      ```bash
      curl -X PATCH https://<tu-dominio>/hoteles/<HOTEL_ID>/agentes/recepcion_virtual/config \
        -H "Authorization: Bearer <TOKEN_STAFF>" -H "Content-Type: application/json" \
        -d '{"gate": "propone"}'
      ```
      (`"autopilot"` no cambia nada adicional para estas 4 tools porque ninguna
      requiere doble confirmación de dinero — `"propone"` ya basta.)

## 2. Crear el agente en el dashboard de ElevenLabs

- [ ] Dashboard de ElevenLabs → Conversational AI → Create an agent.
- [ ] Nombre sugerido: `Recepción virtual — <Nombre del hotel>`.
- [ ] Idioma: español (es).
- [ ] Modelo (LLM): cualquiera de los soportados por el plan — un modelo económico
      (ej. `gemini-2.5-flash` o el que el catálogo vigente ofrezca) es razonable para
      esta tarea (clasificar intención + llamar 1-2 tools por llamada).
- [ ] Voz: elige una voz en español latino/México de la biblioteca.

## 3. Pegar el system prompt

- [ ] Copia el contenido completo de la sección "2. System Prompt" de
      `docs/agente-voz/system-prompt.md`, reemplaza `{{NOMBRE_HOTEL}}` por el nombre
      real del hotel, y pégalo en el campo "Prompt" del agente.
- [ ] Primer mensaje sugerido: `"{{NOMBRE_HOTEL}}, buenas, ¿en qué puedo ayudarle?"`
      (ajusta el saludo al horario/estilo real del hotel).

## 4. Configurar las 4 tools (Server Tools / webhook)

Para CADA una de las 4 (`crear-tarea-housekeeping`, `crear-ticket-mantenimiento`,
`enviar-whatsapp-plantilla`, `registrar-evento-roi`):

- [ ] Agent → Tools → Add tool → Webhook.
- [ ] Nombre de la tool: usa el nombre CON GUIONES BAJOS de la sección 3 de
      `system-prompt.md` (`crear_tarea_housekeeping`, etc. — el nombre de la tool que ve
      el modelo, distinto del segmento de URL que usa guiones).
- [ ] Descripción: copia la de `system-prompt.md` §3.
- [ ] Method: `POST`.
- [ ] URL: la `urlsWebhook.<nombre-con-guiones>` real que devolvió `GET /voz/config`
      en el paso 1 (ya incluye el `HOTEL_ID` correcto).
- [ ] Request headers → agrega `x-atiende-voz-tool-secret` con el valor
      `{{VOICE_TOOL_SECRET}}` (variable, no el texto literal).
- [ ] **Antes de guardar**, ve a Settings → Workspace → Secrets y crea (si no existe ya)
      el secreto `VOICE_TOOL_SECRET` con el valor REAL `toolWebhookSecret` de ESE hotel
      (paso 1). Un secreto de workspace distinto por hotel si vas a tener varios
      hoteles en la misma cuenta de ElevenLabs — nombra cada uno distinto
      (`VOICE_TOOL_SECRET_<HOTEL>`) para no mezclarlos entre agentes.
- [ ] Request body schema: pega el JSON Schema de la sección correspondiente de
      `system-prompt.md` §3.
- [ ] `response_timeout_secs`: 10 (20 para `enviar-whatsapp-plantilla`).
- [ ] Guarda y repite para las 4.

## 5. Comprar/portar el número telefónico

- [ ] ElevenLabs → Phone Numbers → Buy a number (o Import/port un número existente del
      hotel, si aplica — revisa el flujo de portabilidad de tu país, puede tardar días).
- [ ] Asocia el número al agente creado en el paso 2.
- [ ] Si el hotel ya tenía un número publicado y quieres conservarlo, planea el corte
      con anticipación (desvío de llamadas o portabilidad real) — esto es un cambio de
      cara al público, no reversible en caliente sin coordinación con el hotel.

## 6. Primera llamada de prueba real

- [ ] Llama al número desde un teléfono real y pide algo simple ("¿me pueden traer
      toallas extra a la 204?").
- [ ] Verifica en la base de datos real (o el panel de housekeeping del hotel) que se
      creó la tarea de verdad:
      `select * from housekeeping_task where hotel_id = '<HOTEL_ID>' order by created_at desc limit 1;`
- [ ] Revisa los logs del servidor para confirmar la forma real del payload que llegó
      (ver `docs/agente-voz/webhook-contrato.md` §3) y actualiza ese documento.
- [ ] Prueba también un caso de `enviar-whatsapp-plantilla` y confirma que aparece como
      `pendiente_aprobacion` en `/hoteles/<HOTEL_ID>/aprobaciones` para que un gerente
      real lo decida.
- [ ] Prueba los 4 límites duros del prompt (§0 de `system-prompt.md`): pide una
      tarifa, intenta dar un número de tarjeta, pregunta si "Fulano" está hospedado, y
      pide que te manden una llave digital — las 4 deben ser rechazadas por el agente
      SIN llamar a ninguna tool (porque ninguna tool de eso existe en su catálogo).

## 7. Antes de escalar a más hoteles

- [ ] Repite pasos 1-6 por cada hotel — recuerda: un agente de ElevenLabs distinto (con
      su propio `VOICE_TOOL_SECRET_<HOTEL>`) por cada hotel, nunca reutilices el mismo
      agente/número para dos hoteles.
- [ ] Considera activar `guardrails` de ElevenLabs (`platform_settings.guardrails`,
      ver la skill `agents`) como defensa adicional en la capa de ElevenLabs —
      complementa, no reemplaza, los guardrails de código ya existentes
      (`packages/domain-hotel/src/voiceGuardrails.ts`).
