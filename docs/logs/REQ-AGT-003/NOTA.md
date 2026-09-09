# REQ-AGT-003 — evidencia (2026-09-08)

Criterio (`docs/ACEPTACION.md`): `ROIEvent` (monto_verificado, monto_estimado,
metodo_contrafactual, confianza) registrado en el 100% de las acciones con valor
económico, sin excepción (verificado: 0 acciones económicas sin `ROIEvent` asociado en
un lote de prueba).

## Estado real encontrado al llegar

`packages/agent-core/src/tools/roiTools.ts` (`registrar_evento_roi`) ya existía: una
tool `effect="write"` que el MODELO puede llamar para registrar un `ROIEvent`. Eso deja
el "sin excepción" del requisito en manos de que el modelo decida llamarla — ninguna
tool `effect="money"` real del catálogo (`autorizar_gasto_mantenimiento`,
`housekeepingTools.ts`) tenía forma de garantizar su propio `ROIEvent`. Confirmado con
`grep -rn "deriveRoiEvent" packages/` → 0 resultados antes de este cambio, y con la
propia fila de `docs/REQUISITOS.md` (`REQ-AGT-003` → `pendiente`).

## Cambio: cobertura estructural en el núcleo, no en el modelo

- `packages/agent-core/src/tool.ts`: `RoiEventDraft` (los 4 campos del criterio +
  versionado del supuesto) y `ToolDefinitionSpec.deriveRoiEvent` — función determinista
  que una tool `effect="money"` usa para describir el valor económico de SU ejecución
  concreta (recibe `ctx`/input ya validado/`ToolResult`, nunca algo que el modelo
  rellene).
- `packages/agent-core/src/runner.ts`: `AgentRunner`, después de ejecutar con éxito
  cualquier tool `effect="money"`, llama `deriveRoiEvent()` y persiste el resultado vía
  el nuevo `RoiEventRecorder` (`AgentRunnerOptions.roiEventRecorder`). Si la tool no
  declara `deriveRoiEvent`, devuelve `null`, no hay `roiEventRecorder` configurado, o la
  persistencia falla, la corrida se cierra explícitamente `roi_event_faltante` (nuevo
  `AgentRunStatus`) — nunca `"completado"` sin esa cobertura (fail-closed, la mutación
  real ya ocurrida NO se revierte, pero tampoco se reporta éxito sin ROI).
- `packages/agent-core/src/tools/roiTools.ts`: `insertRoiEvent()` compartido (mismo
  INSERT que ya usaba `registrar_evento_roi`) + `createPostgresRoiEventRecorder()`, la
  implementación real de `RoiEventRecorder` contra `public.roi_event`
  (`packages/db/migrations/0026_roi_event.sql`).
- `packages/agent-core/src/tools/housekeepingTools.ts`: `autorizar_gasto_mantenimiento`
  (la única tool `effect="money"` real del catálogo) declara `deriveRoiEvent` —
  `montoVerificado` = `actualCost` (costo real, ya aprobado por dos roles distintos,
  GOB-026), `confianza: 1`, `referenciaTipo: "tarea"` con el `ticketId`.
- `apps/api/src/routes/agentes.ts`: conecta `roiEventRecorder:
  createPostgresRoiEventRecorder(db)` en el único punto real de construcción de
  `AgentRunner` (misma `db` de la sesión, RLS activa vía `dbSession`).
- `tests/integration/agent-core/journey-checkin-incidencia.spec.ts`: el caso "doble
  confirmación… ejecuta la autorización y cierra el ticket" SÍ ejecuta
  `autorizar_gasto_mantenimiento` con éxito — sin `roiEventRecorder` en su
  `buildRunner()`, ese caso pasaba de "completado" a "roi_event_faltante" con este
  cambio (regresión real detectada, no hipotética). Se agregó el recorder a
  `buildRunner()`; vuelve a pasar.

## Prueba nueva

`tests/integration/agent-core/roi-event-cobertura.spec.ts` (4/4, contra
`embedded-postgres` real, `PostgresApprovalQueue` real — ADR-003, sin mocks de SQL):

1. Lote de 3 acciones económicas reales (`autorizar_gasto_mantenimiento`, doble
   confirmación de owner+gm) → exactamente 3 filas en `roi_event`, cada una con
   `monto_verificado` = costo real autorizado, `monto_estimado` NULL,
   `metodo_contrafactual` no vacío, `confianza` en `[0,1]`, `estimado=false` (trigger de
   0026 recalculado). 0 acciones económicas del lote sin su `ROIEvent` asociado.
2. Fail-closed con una tool de prueba `effect="money"` sin `deriveRoiEvent`: la corrida
   NUNCA reporta "completado" — se cierra `roi_event_faltante`, 0 filas en `roi_event`.
3. Defensa en profundidad: la tool REAL (`autorizar_gasto_mantenimiento`) ejecutada SIN
   `roiEventRecorder` configurado también se cierra `roi_event_faltante` (la mutación del
   ticket sí ocurre — documentado, no revertida — pero nunca se reporta éxito sin ROI).
4. Una acción pendiente de aprobación (nunca se ejecutó) no exige ningún `ROIEvent`.

## Comandos y evidencia

- `npx vitest run tests/integration/agent-core/roi-event-cobertura.spec.ts --pool=forks --poolOptions.forks.singleFork`
  → 4/4 verde (`vitest-roi-event-cobertura-20260908-181828.log`).
- `npx vitest run tests/unit/agent-core tests/integration/agent-core --pool=forks --poolOptions.forks.singleFork`
  → 19 archivos/199 pruebas verdes, sin regresión (`vitest-agent-core-full-20260908-181828.log`).
- `npx vitest run tests/integration/api/agentes.spec.ts tests/adversarial/prompt-injection.spec.ts --pool=forks --poolOptions.forks.singleFork`
  → 2 archivos/16 pruebas verdes (wiring real de `apps/api`, `vitest-regresion-agentes-api-20260908-181828.log`).
- `npx tsc --noEmit -p tsconfig.json` → 0 errores en los 8 archivos de este cambio (57
  errores preexistentes ajenos en `tests/unit/domain-hotel/*`, de trabajo no comiteado de
  otras sesiones, confirmado con `grep` que ninguno menciona un archivo tocado aquí —
  `typecheck-full-repo-20260908-181828.log`).
- `npx eslint <8 archivos de este cambio>` → 0 errores (`eslint-20260908-181828.log`).
- `npm run test:unit` (suite completa) → 914/1037 pruebas verdes, 122 fallas
  preexistentes ajenas (todas en `tests/unit/domain-hotel/*` y una ya documentada en
  `docs/PROGRESO.md` REQ-GOB-014 para `cierre-tarea-conventional-commits.spec.ts`) — 0
  fallas nuevas causadas por este cambio (confirmado corriendo cada archivo tocado por
  separado antes y comparando contra este resultado agregado).

## Fuera de alcance de este encargo (declarado explícitamente)

- `autorizar_gasto_mantenimiento` sigue sin estar en el `toolNames` de ningún agente de
  `packages/agent-core/src/agents.ts` (gap preexistente de REQ-AGT-001, no de este
  requisito) — la cobertura automática de ROI queda lista y probada de punta a punta
  (incluido el wiring real de `apps/api`) para el momento en que se decida agregarla a un
  agente; decidir SI/CUÁNDO agregarla no es parte de REQ-AGT-003.
- No se tocó ningún trabajo previo no comiteado de otros frentes encontrado en el
  working tree al llegar (`REQ-AB-004`/`REQ-AGT-004/011/012/022`/`REQ-BO-024`/
  `REQ-HUE-022`/`REQ-OBS-003/010`/`REQ-REC-014`/`REQ-REV-003/007`/`REQ-SEG-012/014`/
  `REQ-TEN-002`, `.gitleaks.toml`, `scripts/checks/*.ts` nuevos, `schema.sql`,
  `packages/domain-hotel/src/{revenue,fraude}/`, etc.) — todos ya construidos por rondas
  anteriores, revisados y dejados intactos.
