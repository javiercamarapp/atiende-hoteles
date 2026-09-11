NOTA: al correr la batería amplia de regresión (`npx vitest run tests/unit` y
`npx vitest run tests/integration/folio tests/integration/api`) tras implementar
REQ-AB-007, aparecieron 2 fallas. Ninguna de las dos toca código de esta tarea; ambas
son pruebas de UMBRAL DE TIEMPO (timeouts/latencia) sensibles a la carga de la máquina
en el momento de la corrida, no a un defecto funcional:

1. `tests/unit/migrations.spec.ts > runner de migraciones (PGlite) > db:reset
   (dropAllMigratedObjects) deja la base lista para re-aplicar desde cero`:
   `Test timed out in 30000ms`. Esta prueba dropea TODOS los objetos de TODAS las
   migraciones (ahora 95, incluida la 0130 de esta tarea) contra PGlite; su costo crece
   con el número total de migraciones del repo y ronda el límite de 30s por diseño, no
   por algo específico de `0130_fnb_centros_consumo.sql`. Re-corrida en aislado (sin
   competir por CPU con el resto de la batería), pasa en 28.49s:
   `npx vitest run tests/unit/migrations.spec.ts -t "db:reset" --testTimeout 120000` →
   1/1 verde. No se tocó `packages/db/src/runner.ts` en esta tarea.

2. `tests/integration/api/reservas-carga-concurrente.spec.ts > ... > 50 GET
   /hoteles/:hotelId/reservas concurrentes: 0 fallos, p95 < 500ms`: obtuvo
   `p95 = 512.7ms` (umbral 500ms) — 0 fallos, solo el margen de latencia. Prueba de
   carga sobre `routes/reservas.ts`, archivo que esta tarea no modifica; sensible a
   contención de CPU cuando corre después de decenas de otras suites de integración
   contra Postgres real en la misma máquina.

Verificado que REQ-AB-007 NO es la causa de ninguna de las dos:
- `git diff --name-only` de esta tarea: solo `apps/api/src/app.ts`,
  `apps/api/src/lib/errors.ts`, `packages/domain-hotel/src/index.ts` (aditivos, ver los
  `git diff` de cada uno) más los 6 archivos nuevos de REQ-AB-007. Ninguno toca
  `packages/db/src/runner.ts` ni `apps/api/src/routes/reservas.ts`.
- El resto de la batería (186/187 pruebas de `tests/integration/folio` +
  `tests/integration/api`, y 1334/1336 de `tests/unit`) pasa en verde con la migración
  0130 aplicada -- incluida `tests/integration/folio/event-sourcing.spec.ts` y
  `tests/integration/api/auth-y-resumen.spec.ts`, que ejercitan el mismo `app.ts` donde
  se registró la nueva ruta.

Evidencia del criterio real de REQ-AB-007 (docs/ACEPTACION.md, comando exacto):
- `docs/logs/REQ-AB-007/vitest-integration-centros-consumo-20260911-003755.log`:
  `npx vitest run tests/integration/ab/centros-consumo.spec.ts` → 6/6 verde contra
  `embedded-postgres` real, incluido el caso literal "dos centros y un traspaso" y el
  caso negativo (traspaso directo entre dos centros de consumo rechazado, stock
  insuficiente rechazado bajo lock real).
- `docs/logs/REQ-AB-007/vitest-unit-20260911-003755.log`: 12/12 pruebas unitarias puras
  de `planFnbInventoryTransfer`/`computeTheoreticalBreakfastCost`.
- `docs/logs/REQ-AB-007/typecheck-domain-hotel-20260911-003755.log` y
  `typecheck-api-20260911-003755.log`: 0 errores.
- `docs/logs/REQ-AB-007/eslint-20260911-003755.log`: 0 errores/warnings en los archivos
  de esta tarea.
- `docs/logs/REQ-AB-007/check-migraciones-20260911-003755.log`: OK, 95 migraciones
  verificadas, 0 DROP/ALTER destructivo sin aprobar.
