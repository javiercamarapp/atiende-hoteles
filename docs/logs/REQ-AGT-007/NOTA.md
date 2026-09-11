# REQ-AGT-007 — evidencia (2026-09-10)

Criterio (`docs/ACEPTACION.md`): toda decisión de agente que afecte económica/legalmente
al huésped (negar reembolso, aplicar cargo) es trazable/explicable con registro de la
regla/prompt que la originó, verificable ante el huésped y la autoridad (verificado
reconstruyendo una decisión desde su registro).

## Estado real encontrado al llegar

`AgentTraceEvent` (`packages/agent-core/src/trace.ts`) y su persistencia
(`persistAgentTraceEvents`, `apps/api/src/lib/agentObservability.ts`, REQ-AGT-006) ya
dejaban en `audit_log` el nombre de la tool, `effect`, `gate` y un `message` genérico
(`result.summary` de la propia tool, redactado) para CADA `tool_call` -- incluidas las de
`effect="money"`. Pero NUNCA el input real con el que se tomó la decisión (monto, folio,
lo que el modelo pidió) ni QUÉ versión de las instrucciones del agente (`systemPrompt`)
estaba vigente. Confirmado con `grep -n "tool_call" packages/agent-core/src/runner.ts` →
el único `emit(..., "tool_call", {...})` del archivo solo pasaba
`toolName/effect/gate/message`, y con la propia fila de `docs/REQUISITOS.md`
(`REQ-AGT-007` → `pendiente`, sin test prescrito existente todavía).

También se confirmó que NINGUNA tool del catálogo real de `agent-core` implementa hoy
"negar reembolso" o "aplicar cargo" al huésped: esas dos acciones viven como endpoints
100% de STAFF humano en `apps/api/src/routes/folios.ts` (cargos/reversos) y
`routes/reservas.ts` (cancelación con penalización, `evaluateCancellation()`), cada una ya
auditada por separado vía `record_audit_log`, pero fuera de `AgentRunner` -- no son
"decisiones de un agente" en el sentido del requisito. La única tool `effect="money"` real
(`autorizar_gasto_mantenimiento`) es gasto de mantenimiento interno, no un cargo/reembolso
al huésped.

## Cambio: dos campos nuevos en el núcleo, poblados automáticamente

- `packages/agent-core/src/trace.ts`: `AgentTraceEvent.toolInput` (input real ya validado
  por Zod, redactado con el MISMO formato que `describeApprovalInput()` ya usa para el
  aprobador humano) y `.promptVersion` (hash sha256 del `systemPrompt` vigente) +
  `computeSystemPromptVersion()`, nuevo, exportado.
- `packages/agent-core/src/runner.ts`: se calcula `promptVersion` una vez por corrida
  (`computeSystemPromptVersion(opts.systemPrompt)`) y se adjunta, junto con `toolInput`,
  al `tool_call` de toda tool `effect==="money"` o `isPriceOrEmission===true` (el
  marcador GOB-026 de "precio/tarifa/emisión de cargo" que ya existía en `tool.ts` sin
  usarse en ningún punto del runner) -- sin importar `result.ok`, para que una decisión
  que NIEGA algo sea tan trazable como una que ejecuta. Nunca en tools `read`/`write`/
  `external` sin valor económico.
- `apps/api/src/lib/agentObservability.ts`: `persistAgentTraceEvents` persiste
  `event.toolInput`/`event.promptVersion` como `inputHerramienta`/`versionPrompt` en el
  `payload` de `audit_log`, con `redact()` aplicado a `toolInput` como defensa en
  profundidad adicional (mismo criterio que ya aplicaba a `mensaje` para REQ-AGT-006). No
  se tocó ninguna otra ruta de persistencia (`agent_run` no necesita estos campos: son
  por-paso, no del resumen agregado).
- Sin migración de BD: `audit_log.payload` ya es `jsonb`, dos claves nuevas no requieren
  cambio de esquema (`npm run check:migraciones` reconfirma 0 DROP/ALTER sin aprobar).

## Prueba nueva

`tests/integration/agent-core/trazabilidad-decision.spec.ts` (5/5, contra
`embedded-postgres` real, `PostgresApprovalQueue` real, código de persistencia REAL de
`apps/api` -- nunca una reimplementación paralela del INSERT):

1. Decisión económica APROBADA (`autorizar_gasto_mantenimiento`, doble confirmación
   owner+gm) → se reconstruye POR COMPLETO desde su única fila de `audit_log`: el
   `inputHerramienta` parseado de vuelta da el `ticketId`/`actualCost` EXACTOS, el
   `versionPrompt` coincide con `computeSystemPromptVersion()` recalculado sobre el mismo
   `systemPrompt`, y `mensaje` trae el resultado.
2. Caso negativo: decisión económica DENEGADA (ticket inexistente, `result.ok===false`)
   queda igual de trazable -- mismo `inputHerramienta`/`versionPrompt` registrados.
3. Cambiar el `systemPrompt` (agregar una sola frase) produce un `promptVersion`
   DISTINTO -- confirma que el hash está atado al texto real, no es un valor fijo.
4. Una tool `effect="write"` (`crear_ticket_mantenimiento`) NO adjunta
   `toolInput`/`promptVersion` -- confirma el alcance acotado a lo económico/legal.
5. `computeSystemPromptVersion()` es determinista y sensible a cualquier cambio de texto,
   probado de forma aislada (sin BD).

## Comandos y evidencia

- `npx vitest run tests/integration/agent-core/trazabilidad-decision.spec.ts` → 5/5 verde
  (`vitest-trazabilidad-decision-20260910-220716.log`).
- `npx vitest run tests/unit/agent-core tests/integration/agent-core --pool=forks --poolOptions.forks.singleFork`
  → 23 archivos/231 pruebas verdes, sin regresión sobre REQ-AGT-001/003/006/020
  (`vitest-agent-core-full-20260910-220716.log`).
- `npx vitest run tests/adversarial/pii-redaction-trazas.spec.ts tests/integration/api/agentes.spec.ts tests/adversarial/prompt-injection.spec.ts`
  → 3 archivos/23 pruebas verdes -- REQ-AGT-006/009 y el wiring real de `apps/api` siguen
  verdes con los campos nuevos (`vitest-regresion-pii-agentes-injection-20260910-220716.log`).
- `npx tsc --noEmit -p tsconfig.json` y `-p apps/api/tsconfig.json` → 0 errores
  (`typecheck-root-20260910-220716.log`, `typecheck-api-20260910-220716.log`).
- `npx eslint <4 archivos de este cambio>` → 0 errores/advertencias
  (`eslint-20260910-220716.log`).
- `npm run lint` (repo completo) → 0 errores (1 advertencia preexistente ajena en
  `tests/e2e/paridad-restaurantes-login.spec.ts`, no tocado por este cambio).
- `npm run check:migraciones` → OK, 94 migraciones verificadas, 0 DROP/ALTER sin aprobar
  (sin migración nueva de este cambio).

## Fuera de alcance de este encargo (declarado explícitamente)

- No existe hoy ninguna tool de agente real que "niegue un reembolso" o "aplique un
  cargo" al huésped -- ver "Estado real encontrado al llegar". El mecanismo construido
  aquí cubre automáticamente cualquier tool `effect="money"`/`isPriceOrEmission` presente
  o futura sin cambio de código adicional, pero decidir SI/CUÁNDO el catálogo de agentes
  gana una tool guest-facing de reembolso/cargo (y conectar `autorizar_gasto_mantenimiento`
  a un agente, gap ya declarado fuera de alcance por REQ-AGT-003) no es parte de este
  requisito.
- No se agregó una categoría "legal" separada de "económica" en `ToolEffect` -- el tipo
  del repo no la define (`"read" | "write" | "external" | "money"`); inventar una
  taxonomía nueva sin que el requisito la especifique se consideró mayor riesgo de
  desviarse del contrato real que quedarse con los dos marcadores (`money`/
  `isPriceOrEmission`) que este catálogo ya usaba para "acción con valor económico"/
  "precio, tarifa, emisión de cargo".
- No se tocó ningún trabajo previo no comiteado de otros frentes encontrado en el
  working tree al llegar.
