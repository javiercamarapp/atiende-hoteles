NOTA: al correr las compuertas completas de esta sesión (`npm run typecheck`,
`npm run test:unit`, `npm run test:integration`) aparecen 3 fallas PRE-EXISTENTES, no
causadas por REQ-REC-014 -- ninguna toca `packages/domain-hotel/src/fraude/`,
`apps/api/src/routes/fraude.ts`, `apps/api/src/pms/fraudScan.ts`,
`apps/api/src/lib/fraudAlertDispatch.ts`, ni `packages/db/migrations/0095_fraude_alerta.sql`:

1. `tests/unit/gob/cierre-tarea-conventional-commits.spec.ts` (test:unit) --
   `AssertionError: expected [ { ...(3) } ] to have a length of +0 but got 1`. Ya
   documentada por otra sesión como preexistente en
   `docs/logs/REQ-OBS-003/NOTA-falla-preexistente-no-relacionada.md` (misma falla,
   pertenece a REQ-GOB-004/REQ-GOB-005, verificación contra el git log real del repo).

2. `tests/unit/domain-hotel/parity-guard.spec.ts` (typecheck) --
   `TS2532: Object is possibly 'undefined'` en las líneas 169 y 206. Archivo NUEVO de
   una sesión concurrente distinta (visible como `??` en `git status` al momento de
   escribir esto, junto con `packages/domain-hotel/src/revenue/` y varias migraciones
   0082/0084/0085/0090/0091 de otros frentes) -- no pertenece a REQ-REC-014 ni se tocó.

3. `tests/integration/revenue/night-audit.spec.ts` > "marca no-show en el mismo cierre
   para una reserva confirmada cuya llegada ya pasó" (test:integration) --
   `no se pudo crear la reserva: 409 sin_tarifa: No hay tarifa configurada para la
   fecha de llegada 2026-09-07`. Es la MISMA clase de bug de fecha que encontré y
   arreglé en mi propio test nuevo (`tests/integration/fraude/patrones-internos.spec.ts`):
   `seedDev()` siembra `rate_plan`/`availability` para los próximos 30 días REALES a
   partir de "ahora" (`new Date()`), así que una fecha hardcodeada en el pasado
   cercano ("2026-09-07") deja de tener tarifa configurada según avanza el reloj real
   de la máquina. Archivo preexistente, no tocado (pertenece a REQ-REV-013/H16-003,
   fuera de alcance de REQ-REC-014).

No se modificó ninguno de los 3 para no exceder el alcance encargado. Confirmado que
`tests/integration/fraude/patrones-internos.spec.ts` (10/10) y
`tests/unit/domain-hotel/fraude-deteccion.spec.ts` (20/20) -- las pruebas de
REQ-REC-014 -- pasan en verde de forma aislada y dentro de las corridas completas
(ver logs en este mismo directorio).
