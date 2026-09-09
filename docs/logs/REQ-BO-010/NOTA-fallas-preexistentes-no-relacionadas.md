NOTA: `npm run typecheck` del workspace `@atiende-hoteles/api` y varios archivos de
`tests/unit/domain-hotel/*.spec.ts` fallan de forma PRE-EXISTENTE, NO causada por
REQ-BO-010 -- confirmado ANTES de tocar ningún archivo de esta tarea (primera corrida
de baseline) y vuelto a confirmar después (ver logs de este mismo directorio).

Causa raíz real: este repo trabaja en un working tree COMPARTIDO entre varias tareas
concurrentes (mismo patrón que ya documentó el commit `b1f3d47`
"feat(REQ-AGT-012): ... No incluye ... packages/domain-hotel/src/index.ts: en este
working tree compartido esos archivos mezclan cambios sin commitear de otras 8 tareas
concurrentes ... se dejan pendientes de commit para no bundlear código no auditado").
Al momento de esta tarea, varias de esas otras sesiones (fraude interno REQ-REC-014,
alergias F&B REQ-AB-004, revenue engine REQ-REV-003, paridad de tarifas, forecast
REQ-AGT-012) tienen su implementación y sus pruebas YA escritas en el working tree,
pero SUS PROPIAS líneas de export en `packages/domain-hotel/src/index.ts` todavía no
están agregadas (índice compartido, cada tarea agrega la suya por separado). Por eso:

- `apps/api/src/pms/fraudScan.ts`, `apps/api/src/routes/fraude.ts`,
  `apps/api/src/routes/pedidosFnb.ts` fallan `tsc` con `TS2305 has no exported member`
  para símbolos de `fraude/deteccion.ts` y `fnbAllergyGuard.ts` (existen en esos
  archivos, confirmado con `grep`; solo falta su línea de export en `index.ts`).
- `tests/unit/domain-hotel/fraude-deteccion.spec.ts`,
  `tests/unit/domain-hotel/fnb-allergy-guard.spec.ts`,
  `tests/unit/domain-hotel/parity-guard.spec.ts`,
  `tests/unit/domain-hotel/revenue-engine-gate.spec.ts`,
  `tests/unit/domain-hotel/walk-forward-backtest.spec.ts`,
  `tests/unit/domain-hotel/pronostico-series-tiempo.spec.ts` fallan en vitest por el
  mismo motivo (`TypeError: X is not a function` al importar de
  `@atiende-hoteles/domain-hotel`).

Verificado que REQ-BO-010 NO es la causa:
- `git diff HEAD -- packages/domain-hotel/src/index.ts` muestra que el único cambio de
  esta tarea sobre ese archivo es ADITIVO (el bloque de export de `pl/usaliPL.ts`) --
  no se removió ni reordenó ninguna línea existente.
- `git show HEAD:packages/domain-hotel/src/index.ts` (el último commit real de `main`,
  `b3c40cf`) tampoco exporta `forecast/`, `revenue/`, `fraude/`, `fnbAllergyGuard.ts` ni
  `parity-guard` -- la falta de export es anterior a esta tarea, no una regresión
  introducida aquí.
- Los archivos `.ts` de esos módulos (`fraude/deteccion.ts`, `fnbAllergyGuard.ts`,
  `revenue/revenueEngineGate.ts`, etc.) y sus `.spec.ts` están todos `??` (untracked)
  en `git status` -- pertenecen a otras 5-6 tareas en curso en este mismo working tree,
  ninguna cerrada/commiteada todavía.

No se tocó `packages/domain-hotel/src/index.ts` más allá de agregar el propio bloque
de REQ-BO-010 (mismo criterio que el resto de tareas concurrentes: cada una agrega
solo su línea, nunca la de otra tarea que no auditó). No se modificaron los archivos
de las otras tareas para "arreglar" este error, para no exceder el alcance encargado
ni bundlear código no auditado bajo este cambio.

Evidencia de que esto NO afecta a REQ-BO-010 en sí:
- `docs/logs/REQ-BO-010/typecheck-domain-hotel-20260908-182729.log`: el paquete
  `@atiende-hoteles/domain-hotel` (donde vive TODO el código nuevo de esta tarea)
  typechecka limpio, 0 errores.
- `docs/logs/REQ-BO-010/eslint-20260908-182729.log`: 0 errores de lint en los 7
  archivos de esta tarea.
- `docs/logs/REQ-BO-010/vitest-unit-usali-pl-20260908-182729.log`: 10/10 pruebas
  unitarias puras (`tests/unit/domain-hotel/usali-pl.spec.ts`) en verde.
- `docs/logs/REQ-BO-010/vitest-integration-pl-usali-20260908-182729.log`: el comando
  EXACTO de `docs/ACEPTACION.md`
  (`npx vitest run tests/integration/bo/pl-usali.spec.ts`), 4/4 pruebas en verde contra
  embedded-postgres real.
- `docs/logs/REQ-BO-010/vitest-regresion-adyacente-20260908-182729.log`: 76/76 pruebas
  verdes en `tests/unit/rls`, `tests/adversarial/roles.spec.ts`,
  `tests/integration/schema`, `tests/integration/folio`, `tests/integration/reservas`
  -- ninguna regresión causada por la migración `0110_pl_usali.sql` ni por el nuevo
  registro de rutas en `apps/api/src/app.ts`.
- `docs/logs/REQ-BO-010/check-migraciones-20260908-182729.log`: `scripts/check-migraciones.ts`
  OK (71 migraciones verificadas, 0 DROP/ALTER destructivo sin aprobar).

Pendiente REAL fuera de mi alcance (para quien consolide el índice compartido antes de
mergear a `main`): agregar a `packages/domain-hotel/src/index.ts` las líneas de export
de `revenue/`, `forecast/`, `fraude/`, `fnbAllergyGuard.ts` y `parity-guard.ts` cuando
esas tareas terminen su propia auditoría -- no es trabajo de REQ-BO-010 hacerlo por
ellas.
