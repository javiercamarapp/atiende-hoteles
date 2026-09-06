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

- **Idempotencia**: `request()` deduplica por `(toolName, hash(input), hotelId)`. Una
  segunda solicitud identica reusa la vigente (pendiente, aprobada o rechazada) en vez
  de abrir una decision paralela; solo una solicitud vencida permite una nueva.
- **Doble confirmacion para dinero** (GOB-026): `isMoney: true` exige 2 confirmaciones
  de actores DISTINTOS; el mismo actor no puede confirmar dos veces.
- **Expiracion**: cada solicitud tiene `expiresAt` (TTL configurable); `expirePending()`
  barre las vencidas a `"expirada"`.
- Cada decision guarda `textoExacto` (el texto que vio el aprobador), listo para el hash
  encadenado de `audit_log`.

### 4. AgentRunner (`src/runner.ts`)

Bucle de tool-calling con proveedor LLM abstracto (`LlmProvider`). Nunca termina en
silencio: toda corrida regresa un `AgentRunResult` con `status` explicito
(`completado | esperando_aprobacion | agotado_pasos | presupuesto_agotado |
no_configurado | error_proveedor | truncado`) y un `message` legible para un humano.

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
- `EnvProvider`: lee `ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` de entorno.
  - Sin credenciales: `isAvailable()` es `false` y `complete()` lanza
    `ProviderUnavailableError` ("agente de IA no configurado en este entorno").
  - Con credenciales: `complete()` lanza `ProviderNotImplementedError` -- la llamada
    real al proveedor esta pendiente de integracion (ver ADR-007, "PENDIENTE DE
    CREDENCIALES"/adaptador real); **nunca** se fabrica una respuesta para aparentar que
    la integracion funciona. Este hito (H6a) es nucleo puro, sin llamadas reales a
    proveedores de LLM.

### 7. Trazabilidad (`src/trace.ts`)

Cada paso del `AgentRunner` emite un `AgentTraceEvent` (sin PII: el campo `message`
siempre pasa por `redact()` antes de emitirse) listo para insertarse en `audit_log`.
`InMemoryCostLedger` acumula el costo USD por `(hotelId, modelSlug)` -- contador de
costo por hotel, REQ-AGT-020.

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
