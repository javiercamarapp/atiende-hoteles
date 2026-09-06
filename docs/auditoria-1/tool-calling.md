# Tool calling y autorización — auditoría 1

**Nota: 3/10** (sin ronda anterior — primera ronda, línea base). N/A razón de movimiento.

**El riesgo mayor de hoy:** la cola de aprobación humana (`ApprovalQueue`), que es el
único mecanismo que hace cumplir REQ-AGT-002 para cobros/tarifas/emisiones, tiene dos
defectos verificados y reproducidos con el código real que juntos permiten que **una
acción de dinero se ejecute sin que ningún humano haya visto realmente qué estaba
aprobando, y que la aprobación de la acción del huésped A autorice, sin que nadie lo
note, la misma acción sobre el huésped/folio B** — exactamente el escenario "ejecutar
una acción irreversible sin aprobación" que la escala de `docs/auditoria/RUBROS.md`
fija como techo de nota 4/10.

Metodología: todo hallazgo de este documento se **reprodujo ejecutando el código
real** de `packages/agent-core/src/*.ts` con `vite-node` (import directo de los
módulos `.ts`, sin mocks) contra escenarios concretos — no son inferencias de lectura.
Los scripts de verificación se escribieron y corrieron en el directorio de scratchpad
de esta sesión, nunca dentro del repo auditado. `npx vitest run tests/unit/agent-core`
corre en verde (9 archivos, 73 pruebas) — la suite existente no cubre ninguno de los
escenarios de abajo, lo cual es parte del hallazgo, no una contradicción con él.

## Hallazgos

### [CRÍTICO] Una aprobación de dinero de un huésped/folio autoriza la misma acción de OTRO huésped/folio en el mismo hotel

`packages/agent-core/src/approval.ts:87-90` (`idempotencyKey`) y `:114-127`
(`request()`); `packages/agent-core/src/runner.ts:239-247` (construcción de la
solicitud de aprobación).

Escenario: en `hotel-1`, el patrón Likida obligatorio (ADR-006, `properties: {}`)
hace que una tool como `cerrar_folio` declare `inputSchema: z.object({})` — el
folio/monto real no viaja en el input, se asume resuelto por el `ToolContext` de la
conversación en curso. `ToolContext` (`context.ts:46-52`) **no** trae un identificador
de folio/reserva, solo `orgId/hotelId/actor/requestId`. `idempotencyKey(toolName,
inputHash, hotelId)` (`approval.ts:87-89`) se arma con `hotelId::cerrar_folio::hash({})`
— idéntico sin importar la conversación, el actor o el folio. Reproducido con el
código real:

1. Huésped A pide cerrar su folio F-100 ($1,500 MXN). El runner llama
   `approvalQueue.request({ toolName: "cerrar_folio", input: {}, hotelId: "hotel-1",
   requestedBy: "agent:recepcionista:guest-A-folio-100", isMoney: true, ... })` → se
   crea la solicitud `A1`.
2. Casi simultáneo, huésped B pide cerrar su folio F-200 ($9,800 MXN), mismo hotel.
   El runner llama `approvalQueue.request({ ... input: {}, hotelId: "hotel-1",
   requestedBy: "agent:recepcionista:guest-B-folio-200", ... })`.
3. Verificado en runtime: `request()` (`approval.ts:121-127`) encuentra
   `existingId` para el mismo `idemKey` y **devuelve la MISMA solicitud `A1`** a
   huésped B (`reqGuestA.id === reqGuestB.id` → `true`).
4. El gerente aprueba `A1` (2 confirmaciones, `isMoney: true`) creyendo que solo
   autoriza el cierre del folio de A. Verificado: `q2.get(reqGuestB.id)` devuelve
   `status: "aprobada"` — la solicitud de B queda aprobada **sin que el gerente la
   haya visto nunca**, y el siguiente paso del runner de B ejecutará
   `tool.run(ctx, {})` sobre el folio de B con luz verde.
5. `requestedBy` (que sí distingue a A de B) se guarda en `ApprovalRequest` pero
   **no participa en `idempotencyKey`** — es puramente informativo, no lo usa el
   dedup.

Consecuencia: el gerente cree que aprobó un cargo/cierre de $1,500 y en realidad
también autorizó (sin saberlo, sin verlo, sin poder negarlo) el cierre del folio de
otro huésped por $9,800. Esto rompe REQ-AGT-002 (P0: "toda acción irreversible...
debe pasar por aprobación humana explícita") para el caso de uso exacto que ADR-006
recomienda como patrón por defecto (`properties: {}`). El contrato `ApprovalQueue`
está documentado en `packages/agent-core/README.md:70-74` como "el contrato que una
implementación futura respaldada por Postgres debe cumplir" — si se implementa tal
cual, el defecto se hereda a producción.

Severidad: CRÍTICO (dinero mal / acción irreversible sin aprobación específica).

### [CRÍTICO] El aprobador nunca ve el monto, el folio ni al huésped: ni `ApprovalRequest` ni `textoMostrado` cargan el input real

`packages/agent-core/src/approval.ts` (interfaz `ApprovalRequest`, líneas 22-37: solo
existe `inputHash: string`, nunca el input en claro); `packages/agent-core/src/runner.ts:246`.

GOB-026 exige que "cada aprobación registre en `audit_log` el texto exacto que vio el
aprobador". El único lugar donde el `AgentRunner` construye ese texto es:

```
textoMostrado: `${opts.agentName} solicita ejecutar "${tool.name}" en hotel ${ctx.hotelId}`
```

Escenario: para `cobrar_folio` con `isMoney: true` sobre un monto real de $12,340.50
MXN, el texto que el gerente ve (y que queda como `textoExacto` en el hash encadenado
de `audit_log`) es literalmente `"recepcionista solicita ejecutar \"cobrar_folio\" en
hotel hotel-1"` — sin monto, sin folio, sin huésped, sin ningún dato del `parsed.data`
que sí llegó al runner (`parsed.data` existe en `runner.ts:212`, pero nunca se pasa a
`approvalQueue.request()` más que como un hash SHA-256 no legible). `ApprovalRequest`
tampoco tiene un campo para guardar el input en claro: quien construya un panel de
aprobación sobre este contrato solo puede mostrar `inputHash` (una cadena hexadecimal)
o el `textoMostrado` genérico — no hay forma, con este contrato, de que el aprobador
sepa qué está aprobando más allá del nombre de la tool y el hotel.

Consecuencia: un gerente "aprueba" cobros, cambios de tarifa o emisiones sin ver la
cifra ni el destinatario — la aprobación humana se vuelve un trámite ciego, no el
control que REQ-AGT-002/GOB-026 exigen. Esto agrava el hallazgo anterior: ni siquiera
en retrospectiva (auditoría del `audit_log`) se puede reconstruir qué vio realmente el
aprobador, porque lo que vio nunca incluyó la cifra.

Severidad: CRÍTICO (control de aprobación de dinero no verificable / de facto
inexistente en su función).

### [ALTO] `defineTool()` bloquea el nombre exacto del campo, pero el mismo campo prohibido pasa sin error si está anidado, en un arreglo, en un esquema `passthrough`, en `z.record`/`z.any`, o con el sinónimo real del dominio (`location`)

`packages/agent-core/src/tool.ts:40-59` (`FORBIDDEN_FIELD_PATTERN`,
`assertNoIdentifierFields`).

`assertNoIdentifierFields` solo actúa `if (!(schema instanceof z.ZodObject)) return;`
y solo inspecciona `schema.shape` de **primer nivel**. Reproducido con `defineTool()`
real (zod 4.5.4, el mismo que usa el paquete), cinco bypasses confirmados, ninguno
lanza `ToolDefinitionError`:

1. **Anidado**: `inputSchema: z.object({ filtro: z.object({ hotel_id: z.string() }) })`
   — `defineTool()` NO lanza. El campo `hotel_id` vive un nivel abajo de `filtro`.
2. **Arreglo de objetos**: `inputSchema: z.object({ items: z.array(z.object({
   hotel_id: z.string() })) })` — NO lanza.
3. **`.passthrough()`**: `inputSchema: z.object({ ticketId: z.string()
   }).passthrough()` — `defineTool()` NO lanza (el shape declarado es solo
   `ticketId`), y en runtime `schema.safeParse({ ticketId: "t1", hotel_id:
   "hotel-666", precio: 999999 })` → `success: true`, `data` incluye `hotel_id` y
   `precio` intactos. Ese `parsed.data` es exactamente lo que `runner.ts:212-221`
   entrega a `tool.run(ctx, parsed.data)`.
4. **`z.record(z.string(), z.unknown())`**: no es `instanceof z.ZodObject`, así que
   `assertNoIdentifierFields` retorna sin validar nada — `defineTool()` acepta la
   tool y en runtime cualquier `{ hotel_id, org_id, monto, ... }` pasa el parseo
   íntegro.
5. **Sinónimo real del dominio**: el patrón (`org.?id|hotel.?id|tenant.?id|guest.?id|
   actor.?id|staff.?id|property.?id`) no contiene la palabra `location`, que es —
   según `packages/db/migrations/0002_org_location_hotel.sql:1-2` y
   `packages/db/README.md:91` — el nombre real de la entidad que representa un hotel
   (`location.kind='hotel'`). `inputSchema: z.object({ location_id: z.string() })`
   pasa `defineTool()` sin error: es un identificador de hotel por otro nombre,
   exactamente lo que la regla dice prohibir.

Consecuencia: la garantía que ADR-006 describe como "cierra la inyección de prompt de
forma **estructural**, no por convención" (README.md:41-43) tiene, hoy, cinco formas
verificadas de declarar una tool que rompe esa regla sin que nada lo detecte — ni un
error en definición, ni una prueba (ninguna de las cinco formas está cubierta en
`tests/unit/agent-core/tool.spec.ts`, que solo prueba el campo `hotel_id` en el nivel
raíz). Hoy no existe ninguna tool de dominio real en el repo (no hay
`packages/domain-hotel` todavía) que use estas formas, así que el hallazgo es sobre el
guardarraíl mismo, no sobre una fuga ya ocurrida — pero es precisamente el guardarraíl
que el rubro pide "vigilar que ninguna tool nueva rompa" (`RUBROS.md`), y hoy no lo
vigila.

Severidad: ALTO (falla silenciosa de un control estructural; escala a CRÍTICO el día
que una tool real use cualquiera de estas cinco formas).

### [ALTO] El loop-guard de repetición solo compara contra la ÚLTIMA llamada, no contra el historial: una tool de escritura sin `needsApproval` se ejecuta dos veces con el mismo input si se intercala otra llamada

`packages/agent-core/src/runner.ts:194-210` (`lastToolSignature`, una sola variable,
no un conjunto/historial).

Reproducido con el `AgentRunner` real: una tool `crear_ticket_housekeeping`
(`effect: "write"`, `needsApproval: false` — no todas las tools de escritura exigen
aprobación, solo `external`/`money` la exigen por `defineTool()`) registrada en un
`ToolRegistry`. Guion del `FakeProvider`: ronda 1 llama
`crear_ticket_housekeeping({ habitacion: "204", detalle: "toalla sucia" })`; ronda 2
llama una tool de lectura no relacionada (`consultar_estado_habitacion`); ronda 3
vuelve a llamar `crear_ticket_housekeeping` con **el mismo input exacto**
(`{ habitacion: "204", detalle: "toalla sucia" }`). Resultado real: `runSpy` (el
`run()` de la tool) se invocó **2 veces** con el input idéntico — se crean dos
tickets de housekeeping duplicados para la misma habitación y el mismo motivo, y el
resultado final es `status: "completado"` (ningún error, ninguna señal de que hubo
duplicación).

El único guardarraíl de repetición (`signature === lastToolSignature`,
`runner.ts:195`) solo protege contra la repetición **inmediata** (dos llamadas
consecutivas idénticas, como sí prueba
`tests/unit/agent-core/runner.spec.ts:158-179`) — no contra un reintento del modelo
tres rondas después, que es exactamente el patrón "el modelo cree que la tool falló
o no se ejecutó y la vuelve a pedir" que `docs/auditoria/RUBROS.md` (rubro 3) describe
como "un reintento de la llamada al LLM que duplica un efecto", y que
`docs/referencia/06-backoffice-agentes-likida.md` §2.5 marca explícitamente como el
riesgo a vigilar "el día que una tool sí reciba datos del modelo" (aquí ya los recibe:
`crear_ticket_housekeeping` no es `properties: {}`).

Consecuencia: cualquier tool de efecto (`write`) que no sea dinero/externa (y por
tanto no pase por `ApprovalQueue`, cuyo `idemKey` sí sería una segunda defensa) no
tiene ninguna protección de idempotencia dentro de `agent-core` contra una repetición
no inmediata — dos tickets de mantenimiento, dos mensajes, dos ajustes duplicados por
el mismo motivo real.

Severidad: ALTO (efecto duplicado).

### [ALTO] Una solicitud ya RECHAZADA se reporta al modelo y al humano como "pendiente de aprobación" para siempre, sin camino para resolverse

`packages/agent-core/src/runner.ts:253-262`; `packages/agent-core/src/approval.ts:114-127`.

`ApprovalQueue.request()` reutiliza la solicitud vigente para el mismo
`(toolName, inputHash, hotelId)` sin importar su estado — `packages/agent-core/README.md:76-78`
documenta esto como intencional ("reusa la vigente (pendiente, aprobada o
rechazada)"). Reproducido: se crea una solicitud, un gerente la **rechaza**
explícitamente (`decide({ decision: "rechazar" })`, `status` queda `"rechazada"`), y
una segunda solicitud idéntica (mismo tool+input+hotel, dentro del TTL) devuelve la
misma solicitud con `status: "rechazada"` intacto.

El problema no es la reutilización en sí (documentada como diseño), sino cómo
`AgentRunner.run()` la interpreta: `runner.ts:253` solo comprueba
`approval.status !== "aprobada"` — trata `"rechazada"` exactamente igual que
`"pendiente"`: la empuja a `pendingApprovalIds`, el mensaje que recibe el modelo dice
literalmente `"pendiente de aprobacion humana: <id>"`, y `close()` devuelve
`status: "esperando_aprobacion"` con el mensaje "Esperando aprobación humana para 1
acción(es) antes de continuar." Pero esa acción **ya fue decidida y rechazada** — y
como `decide()` (`approval.ts:159-163`) lanza `ApprovalError` sobre cualquier solicitud
que no esté en `"pendiente"`, esta solicitud **nunca podrá pasar a `"aprobada"`**: el
estado "esperando_aprobación" es, de hecho, permanente y sin salida.

Consecuencia: un huésped o un miembro del staff cuya solicitud fue explícitamente
negada por un gerente sigue viendo (o el agente sigue reportando) que "se está
esperando aprobación", nunca que fue rechazada — nadie recibe el cierre explícito que
ADR-006/`runner.ts:1-5` promete ("ninguna rama de este bucle termina en silencio").
Es exactamente el caso "se trabó" que `docs/auditoria/RUBROS.md` (rubro 3) señala como
el peor resultado: la base sabe una cosa (rechazada) y el humano/huésped cree otra
(pendiente).

Severidad: ALTO (falla silenciosa / cierre no comunicado).

### [MEDIO] La excepción de "tools terminales" del loop-guard —la única que permite ejecutar una mutación en la última ronda— no tiene ninguna prueba

`packages/agent-core/src/runner.ts:160-174` (`terminalToolNames`,
`hayTerminalDisponible`).

`tests/unit/agent-core/runner.spec.ts` no usa `terminalToolNames` en ningún test (grep
sobre el archivo confirma cero ocurrencias). El único camino probado es el caso
"ninguna tool terminal disponible → corta" (`runner.spec.ts:181-199`); el camino
inverso —cuando sí hay una tool terminal disponible en la última ronda, que es
precisamente la excepción que permite que una tool de efecto se ejecute en el límite
del `maxSteps`— corre hoy sin ningún arnés. Es la rama más sensible del loop-guard
(la que decide si se paga o no una mutación más) y es la única sin cobertura.

Severidad: MEDIO (se degrada y se nota — o no se nota, que es el punto: nadie sabría
si se rompe).

### [MEDIO] El mensaje final de `AgentRunResult` mezcla detalle interno de implementación con el mensaje que, según el propio comentario del archivo, es "SIEMPRE cerrado hacia el humano"

`packages/agent-core/src/provider.ts:186-198`; `packages/agent-core/src/runner.ts:114-124`.

`EnvProvider.complete()` con credenciales presentes lanza `ProviderNotImplementedError`
con el mensaje: `credencial "ANTHROPIC_API_KEY" presente, pero la llamada real al
proveedor LLM no esta implementada en agent-core (H6a es nucleo puro...)`. `runner.ts:118-122`
toma ese mensaje literal (`err.message`) como el `message` de cierre de
`AgentRunResult` — el mismo campo que el propio `runner.ts:60-61` documenta como
"Mensaje SIEMPRE cerrado hacia el humano". `AgentRunResult` no distingue un mensaje
para operación/staff interno de un mensaje seguro para el canal del huésped
(WhatsApp/voz); nada en `agent-core` impide que una capa superior reenvíe este texto
tal cual a un huésped. No incluye secretos (no se filtra el valor de la credencial),
pero sí nombra la variable de entorno y detalles de implementación interna que un
huésped no debería ver nunca.

Severidad: MEDIO (riesgo de exposición operativa si se reenvía sin filtrar; no hay
evidencia en este hito de que ya se reenvíe así, porque no existe todavía el canal de
salida hacia el huésped).

## Lo que revisé y está bien

- **`buildContext()` (`context.ts:90-103`) rechaza de forma fail-closed cualquier
  fragmento `scope: "hotel"` de un tenant distinto** — probado y verificado en
  `tests/unit/agent-core/context.spec.ts:27-48` con casos que incluyen identificar el
  tenant ajeno y el hotel en curso en el error. Este es el control central de
  REQ-AGT-022/GOB-025 y está bien construido: nunca "filtra en silencio".
- **`defineTool()` sí bloquea el caso simple y más común**: un campo
  `hotel_id`/`tenant_id`/`guest_id`/`org_id`/`actor_id`/`staff_id`/`property_id` en el
  nivel raíz del esquema lanza `ToolDefinitionError` en tiempo de definición, antes de
  que la tool llegue a registrarse (`tool.ts:43-59`, `tool.spec.ts:94-105`). El defecto
  documentado arriba es sobre los bypasses, no sobre el caso base, que funciona.
- **`needsApproval` se revisa dos veces, no solo en la definición**: `defineTool()`
  exige `needsApproval: true` para `effect: "external"|"money"` en definición
  (`tool.ts:69-73`), y `AgentRunner.run()` vuelve a comprobarlo en **ejecución**
  (`runner.ts:238-263`) antes de invocar `tool.run()` — una tool con `needsApproval`
  sin aprobación **no se ejecuta** (`runSpy` no se llama, verificado en
  `runner.spec.ts:97-116`). Esto responde directamente al riesgo que el rubro pide
  vigilar ("needs_approval comprobado en definición pero no en ejecución"): aquí sí se
  comprueba en ambos lados.
- **`alwaysApprove` está bien prohibido para precio/emisión**: `isPriceOrEmission &&
  alwaysApprove` lanza en definición (`tool.ts:74-78`, probado en `tool.spec.ts:66-79`),
  y `alwaysApprove` en una tool que NO es de precio/emisión sí se permite
  (`tool.spec.ts:81-92`) — la regla es específica, no una prohibición ciega.
  Advertencia menor: `alwaysApprove` no se lee en ningún punto de `runner.ts` (no hay
  código que aproveche el flag para saltar la cola), así que hoy es un campo
  declarativo sin efecto en ejecución — no es un hallazgo porque no hay ningún camino
  donde eso *debilite* la autorización (el efecto ausente es "más estricto", no menos),
  pero vale la nota para quien lo implemente.
- **El fallback de proveedor atribuye el costo al modelo que realmente respondió, por
  hotel**: probado con un `FakeProvider` primario que falla transitoriamente y un
  fallback con otro `modelSlug` — `costLedger.detallePorHotel()` no tiene entrada para
  el modelo primario y sí para el de fallback, con el monto correcto
  (`runner.spec.ts:221-235`). Corrige exactamente el bug de Likida que
  `docs/referencia/06-backoffice-agentes-likida.md` §2.6 documenta.
  `estimateCostUsd` (`pricing.ts:37-46`) devuelve `0` explícito para un modelo ausente
  de la tabla — nunca adivina un precio.
- **El fallback nunca re-ejecuta una tool ya corrida**: solo reintenta la llamada de
  completado (`runner.ts:107-113`, `continue` reintenta la MISMA ronda), las tools se
  ejecutan después en código propio — mismo patrón (`CR-5`) que Likida.
- **Respuesta truncada tratada como error explícito, nunca como respuesta parcial
  válida**: `completion.truncated` cierra con `status: "truncado"` antes de tocar
  ninguna tool (`runner.ts:143-154`, probado en `runner.spec.ts:214-219`).
- **Estado "sin credenciales" honesto, nunca simulado**: `EnvProvider` sin
  `ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY` lanza `ProviderUnavailableError` y el
  `AgentRunner` cierra con `status: "no_configurado"` (`runner.spec.ts:244-250`); con
  credenciales presentes pero sin integración real implementada, lanza
  `ProviderNotImplementedError` — nunca fabrica un texto de modelo para aparentar que
  funciona (`provider.spec.ts:71-74`).
- **`redact()` se aplica antes de emitir cualquier traza** (`runner.ts:111,115,123,270`)
  y cubre email/teléfono MX/INE/pasaporte/tarjeta con pruebas razonables
  (`redact.spec.ts`); el campo `data` de `ToolResult` (que puede llevar más detalle)
  **nunca** se envía de vuelta al modelo ni a la traza — solo `result.summary`
  (`runner.ts:272`, `trace.ts:37-38` documenta explícitamente esa frontera). Esto
  responde directamente al riesgo "resultado de tool que vuelve al modelo con más
  datos de los necesarios": no ocurre, `data` está estructuralmente separado de lo que
  ve el modelo.
- **Doble confirmación de dinero por actores distintos**: `InMemoryApprovalQueue`
  exige 2 confirmaciones de actores diferentes para `isMoney: true` y rechaza que el
  mismo actor confirme dos veces (`approval.spec.ts:34-80`) — el mecanismo de doble
  control en sí (una vez que alguien SÍ ve la solicitud) es correcto; el problema
  encontrado es que, hoy, casi nadie ve lo que está confirmando (hallazgo CRÍTICO #2).
- **Gate `shadow` bloquea toda tool que no sea lectura, sin importar `needsApproval`**:
  probado explícitamente (`runner.spec.ts:74-95`) — es un control independiente y
  complementario, no una alternativa a `needsApproval`.
- **`ROLE_PARAMS` fija `temperature: 0` en los tres roles** (`roles.ts:44-48`,
  probado en `roles.spec.ts:32-36`) — consistente con GOB-032/LLM-020 (el LLM nunca
  calcula precio/tarifa por generación libre); no puede verificarse el motor
  determinista real porque no existe todavía (ver "Lo que NO alcancé").

## Lo que NO alcancé a revisar

- **No existe ningún motor de precio/impuesto/disponibilidad real que auditar contra
  REQ-REV-001/GOB-013/GOB-032.** `packages/domain-hotel/` no existe en este snapshot
  (`find` no devuelve nada); `agent-core` es núcleo puro sin ninguna tool de dominio
  registrada todavía (`grep -rl "defineTool("` solo encuentra `tool.ts` y sus propias
  pruebas). No pude verificar "que el motor de precio/impuesto/disponibilidad sea de
  verdad un servicio tipado, no una llamada oculta al LLM" porque **no hay ningún
  camino de código, feliz o secundario, que lo ejercite hoy** — se audita el
  guardarraíl (el tipo `ToolEffect`, la regla `temperature: 0`), no una instancia real.
- **`EnergyPort`/`LockPort` (ADR-011, REQ-SEG-015/REQ-REC-009) no existen en el
  código.** `packages/mcp-servers/` no existe en este snapshot; tampoco
  `scripts/checks/lockport-inalcanzable-desde-energia-y-voz.ts`. No hay ninguna tool
  de emisión de llave ni de control de HVAC que auditar — ni para confirmar el
  aislamiento, ni para encontrar una fuga. Se declara explícitamente: **no verificable
  en esta ronda**, no se asume que está bien ni que está mal.
- **No hay integración real con ningún proveedor de LLM** (`EnvProvider` lanza
  `ProviderNotImplementedError` incluso con credenciales) — no pude auditar REQ-AGT-009
  (protección contra inyección de instrucciones vía mensajes/reseñas) contra una
  llamada real, ni el `cache_control`/prompt caching (GOB-033), porque el hito actual
  (H6a) no hace ninguna llamada de red. Tampoco pude auditar cómo se construye un
  `systemPrompt` real con contenido de huésped no confiable, porque `agent-core` recibe
  el `systemPrompt` ya armado como string opaco — esa construcción vive en otra capa
  que no existe todavía en este snapshot.
- **Ninguna de las pruebas adversariales que `docs/ACEPTACION.md` lista para estos
  requisitos existe todavía**: `tests/adversarial/needs-approval-irreversible.spec.ts`,
  `tests/adversarial/prompt-injection.spec.ts`,
  `tests/adversarial/aislamiento-contexto-prompt.spec.ts`,
  `tests/adversarial/pii-redaction-trazas.spec.ts`,
  `tests/integration/agent-core/presupuesto-por-agente.spec.ts` — ninguna se encontró
  en `tests/adversarial/` ni `tests/integration/`. Toda la verificación de este informe
  se hizo contra `tests/unit/agent-core/` y contra ejecución directa del código; no
  pude comprobar el comportamiento bajo concurrencia real (dos runs simultáneos del
  mismo hotel contra la `InMemoryApprovalQueue`, que no es thread-safe por diseño ni
  falta que le haga en un solo proceso Node, pero sí importa el día que dos requests
  HTTP concurrentes compartan la instancia).
- **No revisé `apps/api/` ni `apps/web/`** para confirmar si `AgentRunner`/`ToolContext`
  ya están conectados a una ruta HTTP real — `grep` sobre `apps/api` no encontró
  ninguna referencia a `agent-core`/`ToolRegistry`/`defineTool`/`AgentRunner`, así que
  asumo que la integración todavía no existe, pero no inspeccioné el resto de esas
  carpetas a fondo (quedó fuera de mi rubro).
- **No corrí `npm run lint` ni `npx tsc --noEmit`** sobre el snapshot completo (solo
  `npx vitest run tests/unit/agent-core`, que es lo que aporta evidencia directa a
  este rubro); no puedo afirmar que el resto del monorepo tipa o lintea limpio.
