NOTA: al ejecutar `npm run typecheck` y la suite completa de `npm run test:unit` para cerrar
REQ-OBS-007, el repo YA traía fallas pre-existentes, confirmadas ANTES de tocar ningún
archivo de esta tarea (primera corrida de baseline de la sesión, guardada en
`/tmp/baseline-typecheck.log`, no copiada aquí por vivir fuera del repo):

1. **Módulos de otros REQ (REQ-REV-003/REQ-BO-005/REQ-REV-014/REQ-REC-014/etc.) sin
   exportar todavía desde `packages/domain-hotel/src/index.ts`** al momento del baseline:
   `walkForwardBacktest.ts`, `revenue/revenueEngineGate.ts`, `forecast/timeSeriesForecast.ts`,
   `fnbAllergyGuard.ts`, `fraude/deteccion.ts`, `revenue/parityGuard.ts` (nombres de archivo
   aproximados por el mensaje de error). Sus specs
   (`tests/unit/domain-hotel/{walk-forward-backtest,revenue-engine-gate,pronostico-series-tiempo,fnb-allergy-guard,fraude-deteccion,parity-guard}.spec.ts`)
   importan de `@atiende-hoteles/domain-hotel` (el paquete resuelve solo a `src/index.ts`,
   ver `packages/domain-hotel/package.json`), así que sin ese export fallan en
   compilación/ejecución. **122 tests, 7 archivos**, mismo conteo antes y después del
   cambio de esta tarea (`diff` de la lista exacta de tests en FAIL entre el run
   inmediatamente antes y el run final de REQ-OBS-007: 0 líneas de diferencia).
2. `tests/unit/gob/cierre-tarea-conventional-commits.spec.ts` (REQ-GOB-004): falla contra
   el git log real del repo por una razón ajena a domain-hotel/ROI (confirmado también
   antes de tocar nada de esta tarea).

**Ninguno de estos 8 archivos ni sus specs fue tocado por REQ-OBS-007.** El único archivo
de `packages/domain-hotel/src/index.ts` modificado por esta tarea es la adición del bloque
de export de `buildReporteMensualDueno`/`RoiEventoMensual`/`ReporteMensualDuenoInput`/
`ReporteMensualDueno` -- no se tocó ninguna línea preexistente.

**Nota adicional sobre concurrencia**: este repo se trabaja con varias sesiones de Claude
Code en paralelo sobre el mismo árbol de trabajo (ver `docs/PROGRESO.md`/hitos H1..H11 y
las múltiples carpetas `docs/logs/REQ-*` ya presentes al iniciar esta tarea). Durante esta
sesión, `packages/domain-hotel/src/index.ts` recibió una adición externa (export de
`./roi/roiBaseline.ts`, REQ-REV-018) hecha por otra sesión mientras esta tarea corría --
confirmado leyendo el archivo después del cambio: el bloque de esta tarea
(`buildReporteMensualDueno`) permanece intacto e inalterado, el bloque nuevo se agregó
DESPUÉS del de esta tarea, sin conflicto. Por eso el conteo total de tests de
`npm run test:unit` fluctúa levemente entre corridas de esta sesión (931→960→970 pasando)
sin relación con REQ-OBS-007: son otras tareas paralelas terminando de cablear sus propios
módulos. La evidencia que sí es atribuible a esta tarea es la comparación exacta de la
LISTA de tests en FAIL (no el conteo agregado), que no cambia con el trabajo de
REQ-OBS-007.
