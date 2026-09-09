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

## 8. Criterio de transición de gate a producción (shadow → propone → autopilot)

Todo agente nace en `"shadow"` por default de código (`defaultGate`,
`packages/agent-core/src/agents.ts`, BP-016: "ningún agente nuevo entra en autopilot por
omisión"). En `"shadow"`, `AgentRunner` (runner.ts) nunca ejecuta ninguna tool con
`effect` distinto de `"read"` — el agente "corre" pero ninguna tarea/ticket/mensaje/
evento se crea de verdad. Mover un (hotel, agente) fuera de shadow es la única forma de
que empiece a tener efectos reales, así que es la decisión de "pasar a producción" real
de esta plataforma.

### 8.1 El endpoint (única vía soportada)

```bash
curl -X PATCH https://<tu-dominio>/hoteles/<HOTEL_ID>/agentes/<AGENTE>/config \
  -H "Authorization: Bearer <TOKEN_STAFF>" -H "Content-Type: application/json" \
  -d '{"gate": "propone"}'   # o "autopilot" / "shadow" para revertir
```

- `<AGENTE>` es uno de `recepcion_virtual` / `enrutador_mensajes` / `auditor_nocturno`
  (catálogo cerrado, `listAgentDefinitions()`).
- **Quién puede llamarlo**: solo `owner`/`gm` del hotel (`ADMIN_ROLES`,
  `apps/api/src/domain/roles.ts`) — el mismo middleware de rol que el resto de rutas
  administrativas de esta API. Un `frontdesk`/`housekeeping`/`reservations` recibe `403`
  aunque ese rol sí pueda DISPARAR el agente vía `/ejecutar`; disparar y gobernar el gate
  son autorizaciones distintas a propósito.
- **Qué significa cada valor** (`packages/agent-core/src/runner.ts`): en `"shadow"`,
  NINGUNA tool con `effect` distinto de `"read"` se ejecuta (se registra
  `tool_skipped_shadow` en la traza y ahí termina). En `"propone"` y en `"autopilot"`
  cada tool SÍ se ejecuta según su propia declaración (`packages/agent-core/src/tool.ts`
  exige `needsApproval: true` en toda tool `effect="external"`/`"money"`, nunca opcional
  para esas dos) — hoy, de las 4 tools del catálogo, 3 (`crear_tarea_housekeeping`,
  `crear_ticket_mantenimiento`, `registrar_evento_roi`, todas `effect="write"`) corren
  de inmediato sin pasar por aprobación, y solo `enviar_mensaje_whatsapp_plantilla`
  (`effect="external"`) pasa por la cola de aprobación (`agent_approval` /
  `/hoteles/<HOTEL_ID>/aprobaciones`) antes de enviarse.
  **Importante — `"propone"` y `"autopilot"` ejecutan HOY exactamente igual**: el único
  lugar de `runner.ts` que lee `gate` para decidir si ejecuta una tool es el corte de
  `"shadow"` de arriba; el `needsApproval`/`alwaysApprove` de cada tool (línea 412 de
  `runner.ts`, `if (tool.needsApproval && !tool.alwaysApprove)`) NO está condicionado
  por el gate — una tool futura que declare `alwaysApprove: true` se saltaría la cola de
  aprobación igual en `"propone"` que en `"autopilot"` mientras el código siga así. Para
  ESTE catálogo, la diferencia real entre `"propone"` y `"autopilot"` es de gobierno del
  hotel (qué tan lejos se dejó avanzar al agente, y la única distinción real que sí
  aplica hoy: el guard extra de §8.2 para `auditor_nocturno` solo se activa en
  `"autopilot"`, nunca en `"propone"`) — si algún día se necesita que `"autopilot"`
  también cambie la ejecución de tools normales, ese es un cambio de código en
  `runner.ts`, no algo que ya ocurra solo por fijar el gate.
- **Auditoría (quién/cuándo/de-qué-a-qué)**: cada cambio real de `gate`/`techoMensualUsd`
  queda en `public.audit_log` (acción `agent_config.gate_cambiado`, vía
  `record_audit_log()` — misma bitácora append-only/hash-encadenada del resto del
  sistema, 0008/0016) con `actor_user_id` (quién, resuelto de `auth.uid()` dentro de la
  función `SECURITY DEFINER`, nunca de un campo del cuerpo), `created_at` (cuándo), y en
  `payload`: `agente`, `actorRole`, `gateAnterior`/`gateNuevo`,
  `techoMensualUsdAnterior`/`techoMensualUsdNuevo`. Un `PATCH` que no cambia nada (mismo
  valor ya vigente) no escribe una fila nueva. Consulta el historial de un hotel con:
  ```sql
  select actor_user_id, created_at, payload
  from public.audit_log
  where hotel_id = '<HOTEL_ID>' and action = 'agent_config.gate_cambiado'
  order by created_at asc;
  ```

### 8.2 Excepción: `auditor_nocturno` (revenue/cierre) exige ADEMÁS aprobación del fundador

`auditor_nocturno` es el único agente etiquetado revenue/cierre del catálogo. Pasarlo a
`"autopilot"` es exactamente la categoría reservada `"shadow_a_autopilot_revenue"` del
catálogo cerrado de REQ-GOB-012 (`founder_reserved_category`, migración 0081) — un
trigger de base de datos (`agent_config_shadow_a_autopilot_revenue_guard`, sobre
`public.agent_config`) bloquea ese `INSERT`/`UPDATE` concreto aunque el actor sea
`owner`/`gm`, hasta que exista una `founder_decision_approval` vigente para ese
(org, hotel). El endpoint HTTP responde `409 {"code": "aprobacion_fundador_requerida"}`
(nunca un 500 opaco) mientras falte esa aprobación.

- [ ] Antes de subir `auditor_nocturno` a `"autopilot"` en un hotel real, el fundador
      (identidad de plataforma, `founder_identity` — nunca un `owner`/`gm` de hotel)
      debe registrar la aprobación directamente en la base (no hay endpoint de
      autoservicio, a propósito — ver 0081):
      ```sql
      insert into public.founder_decision_approval
        (category, org_id, hotel_id, decided_by, texto_exacto)
      values (
        'shadow_a_autopilot_revenue', '<ORG_ID>', '<HOTEL_ID>', '<FOUNDER_USER_ID>',
        'Apruebo el paso de auditor_nocturno a autopilot para <hotel> tras N días en shadow/propone sin desviaciones.'
      );
      ```
- [ ] `recepcion_virtual` y `enrutador_mensajes` NO tienen este requisito adicional
      (no tocan revenue directamente) — para esos dos, `owner`/`gm` basta, como en 8.1.
- Cobertura: `tests/integration/api/agentes.spec.ts` (describe `PATCH .../config`, caso
  "auditor_nocturno (revenue) a 'autopilot'...") ejercita el 409 sin aprobación y el 200
  auditado con ella, vía el endpoint HTTP real; `tests/adversarial/
  decisiones-reservadas-fundador.spec.ts` cubre el resto del catálogo de 24 categorías.

### 8.3 Qué revisar antes de aprobar cualquier transición (criterio operativo, no técnico)

- [ ] El agente lleva un período razonable en el gate anterior sin incidentes graves en
      `GET /hoteles/<HOTEL_ID>/agentes/costos` (columna `alerta`) ni en `agent_run`
      (`status` distinto de `completado` de forma recurrente).
- [ ] El techo mensual (`techoMensualUsd`) sigue dentro de la banda documentada por rol
      en `packages/agent-core/src/agents.ts` (comentario de archivo, LLM-026/GOB-036 §2)
      — un techo fuera de banda es señal de revisar el guion/costo antes de subir el
      gate, no de subirlo para "ver qué pasa".
- [ ] Para `recepcion_virtual`: las plantillas de WhatsApp transaccionales relevantes
      (`hotel_messaging_config.transactional_templates`) ya están configuradas — en
      `"propone"`/`"autopilot"` sí se envían de verdad.
- [ ] Para `auditor_nocturno`: la aprobación del fundador (8.2) está vigente
      (`revoked_at is null`) para el hotel en cuestión — una aprobación revocada bloquea
      la transición otra vez, aunque ya se hubiera hecho antes.
