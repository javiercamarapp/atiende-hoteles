# Corrección de hallazgos — auditoría 1, `packages/agent-core`

Método Likida aplicado hallazgo por hallazgo, en orden CRÍTICO → ALTO → MEDIO → BAJO,
sobre `docs/auditoria-1/tool-calling.md` y `docs/auditoria-1/agentico.md`. Para cada
hallazgo: (1) verificación, (2) prueba que lo reproduce (falla antes del fix), (3)
arreglo mínimo, (4) prueba verde + suite completa del paquete verde, (5) commit
`fix(aud-1/agent-core): ...` citando el archivo del informe. Ningún hallazgo se descartó
por falso — los 16 se verificaron como reales contra el código de
`packages/agent-core/src/*.ts`.

## `docs/auditoria-1/tool-calling.md`

| # | Hallazgo | Estado |
|---|---|---|
| CRÍTICO 1 | Una aprobación de dinero de un huésped/folio autoriza la misma acción de OTRO huésped/folio (idempotencyKey sin ámbito de conversación/actor) | **Arreglado** `e37abdd` — `idempotencyKey()` ahora incluye `requestedBy` (ámbito de conversación/actor) además de hotel+tool+hash(input). Riesgo residual documentado: si un mismo `actor.id` de staff gestiona dos conversaciones de huéspedes distintos sin un identificador de folio/conversación propio en `ToolContext` (que hoy no existe), el ámbito seguiría siendo compartido — ver "Pendientes" abajo. |
| CRÍTICO 2 | El aprobador nunca ve el monto/folio/huésped real (`ApprovalRequest`/`textoMostrado` solo llevan `inputHash` y el nombre de la tool) | **Arreglado** `e37abdd` — nuevo campo `ApprovalRequest.inputSummary`; `AgentRunner` construye `textoMostrado`/`inputSummary` a partir de `parsed.data` real (redactado), no solo `"<agente> ejecuta <tool> en <hotel>"`. |
| ALTO 1 | `defineTool()` bloquea el campo prohibido exacto en el nivel raíz, pero pasa sin error anidado, en arreglo, `.passthrough()`, `z.record`/`z.any`, o el sinónimo `location_id` | **Arreglado** `010757c` — `assertNoIdentifierFields()` recorre recursivamente objetos anidados/arreglos/uniones/optional/nullable/default; rechaza `.passthrough()`/`.catchall()`, `z.record(...)`, `z.any()`/`z.unknown()` en cualquier profundidad; lista de patrones prohibidos configurable (`registerForbiddenIdentifierPattern()`) y ampliada con `location_id`. |
| ALTO 2 | El loop-guard de repetición solo compara contra la ÚLTIMA llamada, no contra el historial | **Arreglado** `0d9b2f7` — ventana deslizante de N firmas recientes (`AgentRunnerOptions.loopGuardWindow`, default 5) en vez de una sola variable. |
| ALTO 3 | Una solicitud RECHAZADA se reporta al modelo/humano como "pendiente de aprobación" para siempre, sin camino de resolución | **Arreglado** `e37abdd` — `AgentRunner.run()` reporta un nuevo status terminal explícito `"accion_rechazada"` (nunca `"esperando_aprobacion"`) cuando la tool ya fue rechazada. `ApprovalQueue.request()` sigue reusando la solicitud rechazada (es la MISMA decisión humana, documentado explícitamente en README) — la resolución es el reporte terminal claro, no un reinicio silencioso de la decisión. |
| MEDIO 1 | La excepción de "tools terminales" del loop-guard no tiene ninguna prueba | **Arreglado (cobertura, sin defecto de código)** `c838e5b` — prueba escrita primero pasó en verde de inmediato: el comportamiento ya era correcto. Se deja como regresión sobre la rama más sensible del loop-guard. |
| MEDIO 2 | El mensaje final de `AgentRunResult` mezcla detalle interno (nombre de variable de entorno, hito H6a, nombre de paquete) con el mensaje "SIEMPRE cerrado hacia el humano" | **Arreglado** `d26ba0c` — el mensaje de cierre para `"error_proveedor"` es ahora siempre genérico y seguro; el detalle técnico completo sigue disponible solo en la traza interna (`redact(err.message)`). |

## `docs/auditoria-1/agentico.md`

| # | Hallazgo | Estado |
|---|---|---|
| CRÍTICO | `redact()` no reconoce CURP ni RFC (persona física y moral) | **Arreglado** `e631b4b` — nuevos patrones `CURP_RE`, `RFC_PERSONA_FISICA_RE`, `RFC_PERSONA_MORAL_RE` (con separador opcional espacio/guión entre grupos), evaluados antes que INE/pasaporte. |
| ALTO | `run_finished` está declarado en `AgentTraceKind` pero nunca se emite | **Arreglado** `3f83489` — `close()` (único punto de retorno de `run()`) emite `run_finished` con el mensaje de cierre redactado, cubriendo las 8 ramas de salida. |
| ALTO | El disclosure de IA (REQ-HUE-006/GOB-034) no existe en ningún punto del código | **Arreglado (mecanismo mínimo dentro de agent-core)** `92edd92` — `ServerSession.isFirstTurn` → `ToolContext.isFirstTurn`; `AgentRunnerOptions.disclosureMessage` se antepone al mensaje de cierre en cualquier desenlace cuando `isFirstTurn` es true. **Pendiente** (fuera de `packages/agent-core`, no tocado): detección real de "es el primer turno de esta conversación" por canal (WhatsApp/voz/web), copy legal final aprobado, y respuesta fija a "¿eres humano?" — eso vive en la capa de sesión/API que todavía no existe (`apps/api`/`packages/domain-hotel`). |
| ALTO | El loop-guard hashea el `input` crudo del modelo, no el `input` ya validado/coercionado por Zod | **Arreglado** `0d9b2f7` (mismo commit que tool-calling ALTO 2 — es el mismo código: la firma ahora se calcula sobre `parsed.data` después de `safeParse()`, con tipos ya normalizados). |
| ALTO | `disable_parallel_tool_use` (REQ-AGT-004) no está anclado en ningún tipo ni chequeo | **Arreglado** `4add151` — `LlmCompleteParams.disableParallelToolUse` (obligatorio, siempre `true` desde `AgentRunner`); guardarraíl de refuerzo en runtime: si una respuesta trae más de una tool `effect="money"`, ninguna se ejecuta (nuevo status `"paralelismo_dinero_bloqueado"`). |
| MEDIO | El presupuesto se comprueba al inicio de cada ronda, no después de contabilizar el costo real de esa ronda | **Arreglado** `4f86aed` — nuevo chequeo de `ctx.budget.agotado()` justo después de registrar tokens/costo y antes de ejecutar cualquier tool de esa ronda. |
| MEDIO | La doble confirmación de dinero (GOB-026) verifica un `actor` string distinto, no un ROL distinto | **Arreglado** `e37abdd` — `role` es ahora obligatorio para decidir "aprobar" sobre una solicitud de dinero; dos confirmaciones con el mismo rol (aunque actores distintos) se rechazan. |
| MEDIO | El runtime por rol no distingue voz de texto/WhatsApp: `effort` queda fijo en `"medium"` | **Arreglado** `c02e517` — nueva función `roleParamsForChannel(role, channel?)`: para `"canal"` + `channel: "voz"` baja el effort a `"low"`; `ROLE_PARAMS` no cambia (compatibilidad). |
| BAJO | `alwaysApprove` es una función fantasma: se valida al definir la tool pero el runner nunca la lee | **Arreglado** `e37abdd` — `AgentRunner` ahora omite la `ApprovalQueue` cuando `tool.needsApproval && tool.alwaysApprove`. |

## Pendientes (fuera del alcance de `packages/agent-core`, documentados, no tocados)

- **Ámbito de conversación/folio propio en `ToolContext`**: el fix del CRÍTICO 1 usa
  `requestedBy` (`agent:<agentName>:<actor.id>`) como ámbito de idempotencia. Si en el
  futuro un mismo actor de staff gestiona simultáneamente dos conversaciones de huéspedes
  distintos bajo el mismo `actor.id` (sin un identificador de folio/conversación en
  `ToolContext`, que hoy no existe por diseño de este hito), ambas seguirían compartiendo
  ámbito. Corrección completa requiere que la capa de sesión (fuera de este paquete)
  resuelva un identificador de conversación/folio por turno y lo incluya en
  `ServerSession`/`ToolContext` — no se agregó aquí para no inventar un campo sin que
  exista todavía el consumidor real (`packages/domain-hotel`/`apps/api`).
- **Disclosure de IA completo**: ver fila correspondiente arriba.
- **`ApprovalQueue` respaldada por Postgres**: sigue siendo memoria (`InMemoryApprovalQueue`),
  sin cambios en este hito — es trabajo de `packages/db`/H6b, fuera de este paquete.

## Compuertas de calidad (verificadas tras el último commit)

- `npm run lint` (raíz): 0 errores — `docs/logs/aud1-agentcore-lint-20260906-063634.log`.
- `npm run typecheck` (raíz, incluye `tests/unit/agent-core`): 0 errores —
  `docs/logs/aud1-agentcore-typecheck-20260906-063634.log`.
- `npx tsc -p packages/agent-core --noEmit` (aislado): 0 errores —
  `docs/logs/aud1-agentcore-typecheck-isolated-20260906-063634.log`.
- `npx vitest run tests/unit/agent-core`: 9 archivos, **113/113 pruebas verdes** (73
  originales + 40 nuevas de esta corrección) —
  `docs/logs/aud1-agentcore-test-unit-20260906-063634.log`.
- `npx eslint packages/agent-core tests/unit/agent-core` (aislado): 0 problemas —
  `docs/logs/aud1-agentcore-eslint-isolated-20260906-063634.log`.
