# @atiende-hoteles/agent-core

Nucleo de agentes y herramientas con autorizacion para Atiende Hoteles. Hito **H6a**:
solo tipos y logica pura en TypeScript, sin I/O real ni llamadas a proveedores de LLM.
Implementa el patron de agentes descrito en `docs/ARQUITECTURA.md` ADR-006 (Likida +
`needs_approval` + runtime por rol) y ADR-007 (forma de puertos), sobre los requisitos
`REQ-AGT-001..022` y `REQ-SEG-*` de `docs/REQUISITOS.md`.

## Modelo de autorizacion (resumen ejecutable)

```
ServerSession (JWT/sesion)              Modelo (LLM)
        |                                    |
        v                                    v
  buildToolContext()                 completion.toolCalls[]
        |                                    |
        |            AgentRunner.run(ctx, mensaje)
        |                     |
        |     +---------------+----------------+
        |     |               |                |
        v     v               v                v
   ToolContext   gate (shadow/     needsApproval?    loop-guard +
  {orgId,hotelId, propone/         -> ApprovalQueue    presupuesto
   actor,requestId,autopilot)       .request()          (tokens/ms/USD)
   budget}
        |
        v
   tool.run(ctx, input)   <-- input SOLO trae lo que el modelo debe decidir;
                               NUNCA tenant/hotel/actor (vienen de ctx)
```

### 1. Las tools nunca reciben identificadores del modelo

`defineTool()` (`src/tool.ts`) valida en tiempo de definicion, no solo por convencion:

- El esquema de entrada (`inputSchema`, Zod) puede ser `z.object({})` a proposito --
  mismo patron que `properties: {}` de Likida (ver
  `docs/referencia/06-backoffice-agentes-likida.md` §2.5) -- cuando la tool no necesita
  nada del modelo porque todo viene del `ToolContext`.
- Cualquier campo `org_id`/`hotel_id`/`tenant_id`/`guest_id`/`actor_id`/`staff_id`
  (en cualquier variante de mayusculas/guiones) en el esquema hace que `defineTool()`
  lance `ToolDefinitionError` al definirla: la inyeccion de prompt queda cerrada de
  forma estructural, no por validacion de argumentos.
- `effect: "external" | "money"` exige `needsApproval: true` (GOB-026); definir una de
  estas tools sin `needsApproval` lanza en el momento de registrarla.
- `isPriceOrEmission: true` (tools de precio/tarifa/emision de cargo o reserva) prohibe
  `alwaysApprove: true` -- tambien verificado al definir la tool, no en runtime.

`ToolContext` (`src/context.ts`) se construye SIEMPRE con `buildToolContext(session,
budget)` a partir de una `ServerSession` ya resuelta por el servidor (JWT de sesion,
ADR-004): `orgId`, `hotelId`, `actor`, `requestId`. El modelo nunca ve ni propone estos
valores.

### 2. Aislamiento de contexto entre tenants (REQ-AGT-022 / GOB-025)

`buildContext(hotelId, fragments)` arma el contexto que entra al prompt exclusivamente
con datos del hotel en curso y hechos publicos (`scope: "public"`). Cualquier fragmento
`scope: "hotel"` de OTRO tenant se **rechaza** lanzando `CrossTenantContextError`
(fail-closed: nunca se filtra en silencio). Esto es independiente del aislamiento por
RLS a nivel de base de datos (`REQ-TEN-001`, `packages/db`): uno protege la fila en
Postgres, el otro protege lo que efectivamente entra al prompt del LLM.

`redact()` (`src/redact.ts`) redacta PII (email, telefono MX, INE/documento de
identidad, pasaporte, tarjeta) antes de que cualquier texto libre entre a un
`AgentTraceEvent` (REQ-AGT-006/GOB-035). El `AgentRunner` la aplica automaticamente a
mensajes de error y a los resumenes (`ToolResult.summary`) que emite en sus trazas.

### 3. Cola de aprobacion humana (`src/approval.ts`)

`ApprovalQueue` es una interfaz; `InMemoryApprovalQueue` es la implementacion de este
hito. Esta pensada para que una implementacion futura respaldada por una tabla
`agent_task`/`approval` de `packages/db` (estado `pendiente_aprobacion`, resuelta por un
humano via API/WhatsApp/web -- ver ADR-006) implemente el mismo contrato sin tocar el
`AgentRunner` ni las tools:

- **Idempotencia**: `request()` deduplica por `(toolName, hash(input), hotelId,
  requestedBy)` -- `requestedBy` es el ambito de conversacion/actor (p.ej.
  `agent:<agentName>:<actor.id>`), asi que dos conversaciones distintas (dos
  huespedes/folios) que llaman la misma tool con el mismo input (tipico del patron
  Likida `properties: {}`, donde el input real siempre es `{}`) NUNCA comparten la
  misma solicitud (corregido en aud-1, ver `docs/auditoria-1/correccion-agent-core.md`,
  tool-calling CRITICO #1). Una segunda solicitud identica dentro del mismo ambito reusa
  la vigente (pendiente, aprobada o rechazada -- es la MISMA decision humana, no se
  reabre en silencio con un simple reintento); solo una solicitud vencida (expirada)
  permite crear una nueva. `AgentRunner.run()` reporta explicitamente el estado
  `"accion_rechazada"` (terminal, nunca "esperando_aprobacion") cuando la tool que pidio
  ejecutar ya fue rechazada -- nunca dice "pendiente" de algo que un humano ya cerro
  (tool-calling ALTO #4).
- **Resumen legible del input real** (`inputSummary`, GOB-026): el aprobador no firma a
  ciegas -- `ApprovalRequest.inputSummary` expone el input real (redactado) que recibio
  la tool, no solo `inputHash` (tool-calling CRITICO #2).
- **Doble confirmacion para dinero** (GOB-026): `isMoney: true` exige 2 confirmaciones
  de actores DISTINTOS **y de ROLES distintos** (`role` es obligatorio al aprobar dinero);
  el mismo actor, o el mismo rol bajo un alias/actor distinto, no puede confirmar dos
  veces (agentico MEDIO #6).
- **Expiracion**: cada solicitud tiene `expiresAt` (TTL configurable); `expirePending()`
  barre las vencidas a `"expirada"`.
- Cada decision guarda `textoExacto` (el texto que vio el aprobador), listo para el hash
  encadenado de `audit_log`.

### 4. AgentRunner (`src/runner.ts`)

Bucle de tool-calling con proveedor LLM abstracto (`LlmProvider`). Nunca termina en
silencio: toda corrida regresa un `AgentRunResult` con `status` explicito
(`completado | esperando_aprobacion | accion_rechazada | agotado_pasos |
presupuesto_agotado | no_configurado | error_proveedor | paralelismo_dinero_bloqueado |
roi_event_faltante | truncado`) y un `message` legible para un humano.

- **Loop-guard**: (a) detecta la repeticion inmediata de la misma tool+input y corta
  antes de re-ejecutarla; (b) en la ultima ronda permitida, si ninguna de las tools
  solicitadas es "terminal" (`terminalToolNames`, cuyo resultado no vuelve al modelo),
  corta ANTES de ejecutar el `Promise.all` de tool calls -- mismo patron que
  `generateWithTools` de Likida (§2.6): nunca se paga una mutacion mas por un resultado
  que nadie va a leer.
- **Presupuesto** (`src/budget.ts`, `RunBudget`): un reloj compartido de
  tokens/tiempo/costo USD, consultado antes de cada ronda (`agotado()`). Se agota ->
  `presupuesto_agotado`, nunca un cuelgue silencioso.
- **Fallback de proveedor**: ante un `ProviderTransientError` (y solo una vez por
  corrida), reintenta la MISMA ronda con `fallbackProvider` -- ninguna tool ya ejecutada
  se repite, porque el fallback solo cubre la llamada de completado, igual que en
  Likida (§2.6, comentario `CR-5`).
- **Contabilidad de costo**: el costo estimado (`estimateCostUsd`, `src/pricing.ts`) se
  atribuye SIEMPRE al modelo que de verdad respondio esa ronda (el primario o el
  fallback), nunca al modelo original si hubo fallback -- corrige el mismo bug de
  auditoria que Likida documenta.
- **Truncamiento**: una respuesta con `truncated: true` se trata como error explicito
  (`status: "truncado"`), nunca como una respuesta parcial valida.
- **Gate shadow/propone/autopilot**: en `gate: "shadow"`, NINGUNA tool con
  `effect !== "read"` se ejecuta (se registra `tool_skipped_shadow` en la traza y se le
  devuelve al modelo un resultado que dice "NO ejecutada"), sin importar si tiene
  `needsApproval`. En `propone`/`autopilot` las tools se ejecutan, pero
  `needsApproval: true` (obligatorio para `external`/`money`) sigue pasando por la
  `ApprovalQueue` -- el gate y `needsApproval` son controles independientes y
  complementarios.
- **Cobertura de ROIEvent (REQ-AGT-003/H17-001/GOB-037)**: justo despues de ejecutar con
  exito (`result.ok===true`) cualquier tool `effect="money"`, `AgentRunner` invoca
  `tool.deriveRoiEvent(ctx, input, result)` (`tool.ts`) y persiste el `ROIEvent`
  resultante via `AgentRunnerOptions.roiEventRecorder` (interfaz `RoiEventRecorder`,
  implementacion real `createPostgresRoiEventRecorder` en `tools/roiTools.ts`) -- NUNCA
  depende de que el modelo decida llamar aparte la tool `registrar_evento_roi` (esa
  tool sigue existiendo para eventos que NINGUNA tool `money` produce, p.ej. el cierre
  nocturno del auditor). Fail-closed: si la tool no declara `deriveRoiEvent`, la
  devuelve `null`, no hay `roiEventRecorder` configurado, o la persistencia falla, la
  corrida se cierra `status: "roi_event_faltante"` -- la mutacion real que la tool ya
  hizo NO se revierte (este nucleo no hace two-phase commit sobre efectos externos),
  pero tampoco se reporta `"completado"` sin esa cobertura. Verificado con
  `embedded-postgres`/`PostgresApprovalQueue` reales en
  `tests/integration/agent-core/roi-event-cobertura.spec.ts`.

### 5. Runtime por rol (`src/roles.ts`)

Un solo mapa `ModelRole -> slug` (`canal` = Sonnet 5, `enrutador` = Haiku 4.5,
`batch_nocturno` = Opus 5), igual que `models.ts` de Likida (§2.7): cada default
documentado con su fuente, override por variable de entorno
(`AGENT_MODEL_CANAL`/`AGENT_MODEL_ENRUTADOR`/`AGENT_MODEL_BATCH_NOCTURNO`) para que
cambiar de modelo cueste una variable, no un despliegue. `ROLE_PARAMS` fija
`temperature: 0` en los tres roles (GOB-032/LLM-020: el LLM nunca calcula precio,
tarifa, impuesto, disponibilidad ni horario; esos valores siempre vienen de un motor
determinista fuera de este paquete).

`StaticGateResolver` resuelve el gate (`shadow | propone | autopilot`) por
`(hotelId, agent)`, con default `"shadow"`: ningun agente entra en autopilot por
omision (BP-016/BP-053).

### 6. Proveedor de LLM (`src/provider.ts`)

- `FakeProvider`: determinista, reproduce un guion fijo de pasos (`tool_calls`,
  `final`, `truncated`, `transient_error`) -- usado en todas las pruebas de este
  paquete, sin red.
- `EnvProvider` (fix/llm-openrouter-real): decision de negocio -- el agente habla con
  [OpenRouter](https://openrouter.ai) (`POST /api/v1/chat/completions`, compatible
  OpenAI Chat Completions), NUNCA con un SDK de un solo proveedor. `complete()` hace la
  llamada HTTP real: traduce `LlmCompleteParams` (system/messages/toolNames/
  temperature/maxOutputTokens/disableParallelToolUse/effort) al formato de OpenRouter y
  traduce la respuesta de vuelta (texto, `tool_calls`, usage, truncado por
  `finish_reason:"length"`).
  - Credencial: SOLO `OPENROUTER_API_KEY` por default (`envKeys` configurable, pero
    OpenRouter es el UNICO endpoint al que este `complete()` sabe llamar -- una
    credencial de otro proveedor ahi produciria un 401 real).
  - Modelo: `EnvProviderOptions.model` (prioridad maxima) > `env.OPENROUTER_MODEL` >
    mapeo por defecto desde `LlmCompleteParams.modelSlug` (`claude-*` ->
    `anthropic/claude-*`, el mismo slug que `roles.ts` `DEFAULT_MODEL_BY_ROLE` ya
    resuelve por rol). `modelSlugOverride` permite que una instancia reporte, para
    efectos de costo/traza (`pricing.ts`), un `modelSlug` distinto al que le llego en
    `params` -- necesario cuando esa instancia en realidad llama a OTRO modelo (ver
    proveedor de respaldo en `apps/api/src/routes/agentes.ts`).
  - Sin credenciales: `isAvailable()` es `false` y `complete()` lanza
    `ProviderUnavailableError` ("agente de IA no configurado en este entorno") --
    **nunca** toca la red.
  - Errores HTTP: 429/5xx/timeout/fallo de red -> `ProviderTransientError` (apto para
    fallback cross-provider); cualquier otro 4xx (401 credencial invalida, 400 request
    mal formado, 404 modelo inexistente en la cuenta...) -> `ProviderHttpError`
    (`status` expuesto, NUNCA dispara fallback -- necesita revision humana de
    configuracion). Nunca se fabrica una respuesta para aparentar que la llamada
    funciono.
  - **`OPENROUTER_INTEGRATION_VERIFIED_AGAINST_REAL_API = false`** (provider.ts,
    "esqueleto honesto" ADR-006/ADR-007, mismo patron que `SATSubmitter` del repo
    hermano de facturacion): el contrato HTTP esta probado de verdad contra un
    simulador local fiel (`tests/support/openRouterSimulator.ts`,
    `tests/unit/agent-core/env-provider-openrouter.spec.ts` -- sin tools, con
    `tool_calls`, truncado, 401, 429, timeout), pero **nunca** se ha ejercitado contra
    `https://openrouter.ai` real -- sin credenciales reales en este entorno. Pasos
    exactos para la primera prueba real (ver el docstring de la constante en
    provider.ts): (1) cuenta + API key en openrouter.ai, (2) saldo cargado (cobra
    prepago), (3) `OPENROUTER_API_KEY` real en el entorno de `apps/api`, (4) opcional
    `OPENROUTER_MODEL` si el default no esta habilitado en esa cuenta, (5) correr un
    `AgentRunner.run()` real sin `demo:true` y verificar a mano.
  - **Limitacion conocida, no oculta**: `LlmCompleteParams.toolNames` solo lleva
    nombres de tool (no el JSON Schema `strict:true` que `tool.ts`
    `toStrictToolSchema()` ya sabe generar por tool, pero que `runner.ts` todavia no le
    pasa a `complete()`) -- `EnvProvider` declara cada tool con `parameters` vacio/
    permisivo, asi que el modelo real tiene que adivinar la forma de los argumentos
    solo por el nombre y el system prompt. Corregirlo de raiz exige extender
    `LlmCompleteParams`/`AgentRunner` para propagar el schema real, un cambio de
    interfaz deliberadamente fuera de alcance de fix/llm-openrouter-real.
- `ProviderRouter` (REQ-AGT-011/LLM-022): router propio de fallback de proveedor,
  implementado -- YA NO es solo la aspiración descrita en versiones previas de este
  README. Recibe una lista de `LlmProvider` en orden de prioridad; `complete()` llama al
  primero cuyo `isAvailable()` sea `true` (nunca paga una llamada que ya sabe perdida) y
  `isAvailable()` del propio router es `true` si CUALQUIERA de la lista lo está. Cubre el
  escenario que `AgentRunner.fallbackProvider` (§4) NO cubre: el primario nunca llega a
  intentar la llamada porque ya está `isAvailable() === false` (típicamente, sin
  credenciales). Un fallo TRANSITORIO a mitad de una llamada ya en curso se sigue
  resolviendo con `AgentRunner.fallbackProvider`, sin duplicar esa lógica aquí --
  `apps/api/src/routes/agentes.ts` combina las dos capas (mismo proveedor de respaldo
  como `providers[1]` del router Y como `fallbackProvider` del `AgentRunner`) para los
  agentes de canal CONVERSACIONAL (`canal`/`enrutador`; el auditor `batch_nocturno` se
  queda con un único proveedor, sin router). Verificado con Postgres real en
  `tests/integration/agent-core/fallback-proveedor.spec.ts`.

### 7. Trazabilidad (`src/trace.ts`)

Cada paso del `AgentRunner` emite un `AgentTraceEvent` (sin PII: el campo `message`
siempre pasa por `redact()` antes de emitirse) listo para insertarse en `audit_log`,
incluido `run_finished` al final de CUALQUIER salida de `run()` (completado, rechazado,
error, presupuesto agotado...) -- el desenlace de la corrida queda anclado en el mismo
canal de auditoria que el resto de los pasos (aud-1 agentico.md ALTO).
`InMemoryCostLedger` acumula el costo USD por `(hotelId, modelSlug)` -- contador de
costo por hotel, REQ-AGT-020.

### 8. Disclosure de IA (REQ-HUE-006/GOB-034)

Mecanismo minimo dentro de agent-core: `ServerSession.isFirstTurn` (resuelto por la
capa de sesion externa, que es quien sabe si ya existia una conversacion previa) se
copia a `ToolContext.isFirstTurn`; si `AgentRunnerOptions.disclosureMessage` esta
configurado y `ctx.isFirstTurn` es `true`, `AgentRunner.run()` antepone ese texto al
`message` de cierre -- en CUALQUIER desenlace de la corrida, no solo "completado".

`src/disclosure.ts` agrega la mitad que antes vivia "pendiente fuera de este paquete":
`WHATSAPP_DISCLOSURE_MESSAGE` (reexporta `AGENT_DEFINITIONS.recepcion_virtual.disclosureMessage`,
una sola fuente de verdad) y `esPreguntaSiEsHumano()` + `RESPUESTA_FIJA_ES_HUMANO` (deteccion
deterministica y respuesta FIJA, nunca generada por el modelo). La deteccion real de
"conversacion nueva por canal" sigue siendo responsabilidad de cada canal (agent-core no
tiene estado de conversacion) -- `apps/api/src/routes/mensajeria.ts` (webhook de WhatsApp,
el UNICO punto real de este repo que procesa un mensaje entrante) ya la usa: 0 mensajes
previos en `public.message` para la conversacion dispara el disclosure antes de cualquier
otra respuesta automatica. **Pendiente real** (no de este paquete): el canal de voz, que
depende de una integracion de telefonia/PBX (Telnyx) que este repo todavia no tiene en
ninguna forma, ni el copy legal FINAL aprobado (el texto actual es un borrador funcional) --
ver `docs/REQUISITOS.md` (fila REQ-HUE-006) y `tests/adversarial/disclosure-ia.spec.ts`.

## Limites explicitos de este hito (H6a)

- No hay llamadas de red reales a ningun proveedor de LLM (`EnvProvider` se declara
  honesto en vez de simular).
- `InMemoryApprovalQueue` es una implementacion en memoria; el contrato (`ApprovalQueue`)
  esta listo para una implementacion respaldada por Postgres, pero esa implementacion es
  trabajo de un hito posterior (no se toca `packages/db` en H6a).
- No se implementa el patron completo de "reserva antes de llamar, liquida despues" del
  presupuesto de Likida (`presupuesto.ts` `reservarCompletion`); este paquete registra
  costo/tokens DESPUES de cada llamada exitosa, lo cual ya garantiza atribucion correcta
  por modelo pero no cubre el caso "el proveedor cobro pese a que la llamada broto un
  error de red" -- documentado aqui para no fingir paridad completa con Likida.

## H6b: `PostgresApprovalQueue` + 4 tools de dominio reales

- `PostgresApprovalQueue` (`src/postgresApproval.ts`) implementa `ApprovalQueue` sobre
  `agent_approval`/`agent_approval_confirmation`
  (`packages/db/migrations/0042_agent_approval.sql`+`0045_agent_approval_input_json.sql`):
  MISMA suite de contrato que `InMemoryApprovalQueue`
  (`tests/support/approvalQueueContract.ts`, corrida contra ambas en
  `tests/unit/agent-core/approval.spec.ts` y
  `tests/integration/agent-core/postgres-approval-queue.spec.ts`), mas la persistencia
  real que la version en memoria no puede dar (sobrevive un reinicio del proceso, ver esa
  misma prueba de integracion). `getStoredInput()` es una extension MAS ALLA del
  contrato -- guarda el input real ya validado para que `apps/api` pueda ejecutar la tool
  correspondiente cuando una aprobacion se completa fuera de una corrida de
  `AgentRunner` (dos peticiones HTTP de dos aprobadores distintos).
- 4 tools reales (`src/tools/`), inyectadas por dependencia (`SqlClient`/
  `WhatsappSenderLike`, nunca importan un motor de BD ni un paquete de WhatsApp
  concretos): `crear_tarea_housekeeping` (write), `crear_ticket_mantenimiento` (write,
  con dedupe 24h), `autorizar_gasto_mantenimiento` (money, needsApproval), y
  `enviar_mensaje_whatsapp_plantilla` (external, needsApproval SIEMPRE por GOB-026 --
  `createTransactionalTemplateApprovalQueue()` es el mecanismo, fuera de la tool, que
  auto-aprueba las plantillas transaccionales configuradas por hotel sin violar esa
  regla). Las 4 se reutilizan tal cual desde `apps/api` (rutas de staff) y desde el
  journey de `AgentRunner`+`FakeProvider` en
  `tests/integration/agent-core/journey-checkin-incidencia.spec.ts` (shadow/propone/
  autopilot de punta a punta).
- **Nota de compatibilidad de runtime:** ningun archivo de este paquete usa el azucar de
  TypeScript "parameter properties" (`constructor(private readonly x: T)`) -- ese azucar
  no esta soportado por `node --experimental-strip-types` (el runtime real de
  `apps/api`, ver su README); usarlo revienta la carga del modulo completo con
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` en cuanto algo de `apps/api` importa CUALQUIER cosa
  de `@atiende-hoteles/agent-core`. Se corrigio tambien en `packages/mcp-servers/shared`
  y `packages/mcp-servers/whatsapp` por la misma razon (H6b es quien primero conecta
  agent-core y un adaptador de mcp-servers a un proceso que arranca con ese runtime).

## H7: catálogo de agentes como configuración + `registrar_evento_roi`

- `src/agents.ts` declara `AGENT_DEFINITIONS`: los 3 agentes de este hito
  (`recepcion_virtual` canal/Sonnet 5, `enrutador_mensajes` enrutador/Haiku 4.5 sin
  tools, `auditor_nocturno` batch_nocturno/Opus 5), cada uno con `role` (roles.ts),
  `toolNames` permitidas, `allowedStaffRoles` (defensa en profundidad además de RLS),
  `defaultGate` (siempre `"shadow"`, BP-016) y `defaultMonthlyCeilingUsd` (dentro de la
  banda LLM-026 ≈USD 27-158/mes por hotel de 45 habitaciones). Agregar un agente nuevo es
  agregar una entrada aquí (REQ-AGT-018, patrón registry) — `apps/api/src/routes/agentes.ts`
  es el ÚNICO lugar que traduce `toolNames` a fábricas de tool concretas.
- `src/tools/roiTools.ts` (`registrar_evento_roi`, REQ-AGT-003/H17-001): `effect="write"`
  sin `needsApproval` — es un registro de observabilidad de valor económico, no una
  acción que mueva dinero; por eso SÍ se omite en gate `"shadow"` (como cualquier tool
  write) pero nunca exige aprobación humana. Rechaza (sin tocar la BD) un evento sin
  `montoEstimado` NI `montoVerificado`. La columna `estimado` de `roi_event`
  (`packages/db/migrations/0026`) la recalcula un TRIGGER en Postgres a partir de si hay
  `monto_verificado` — la tool nunca decide esa bandera. Esta tool sigue siendo el
  camino para eventos que NINGUNA tool `money` produce (p.ej. el cierre nocturno del
  auditor); la cobertura **obligatoria, sin excepción** de toda tool `effect="money"`
  real ahora vive en el núcleo (`AgentRunner`, ver §4 arriba) vía
  `deriveRoiEvent`/`RoiEventRecorder`/`createPostgresRoiEventRecorder` (mismo
  `insertRoiEvent` compartido) — nunca depende de que el modelo llame esta tool.
- `apps/api/src/routes/agentes.ts` es quien construye el `ToolContext` (desde la sesión,
  nunca del cliente), resuelve el gate/techo efectivo (`agent_config` o default de
  código), corta por presupuesto ANTES de invocar al proveedor
  (`public.agent_cost_mes()`, `packages/db/migrations/0024`) y persiste
  `AgentRunner.onTrace()` en `audit_log`+`agent_run` dentro de la misma transacción por
  request — ver `apps/api/README.md` §H7 para el detalle de rutas.
- Pendiente/rojo declarado: sin corrida nocturna programada real de `auditor_nocturno`
  (se dispara manualmente vía API/demo, sin scheduler); `EnvProvider` sigue en el mismo
  estado honesto desde H6a (con credenciales declara la integración real pendiente, sin
  ellas se declara `no_configurado`) — H7 no agrega ninguna llamada real a un proveedor
  LLM.
