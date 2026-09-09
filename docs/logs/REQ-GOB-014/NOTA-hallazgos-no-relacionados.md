# Hallazgos no relacionados con REQ-GOB-014, encontrados al correr la suite completa

Verificado el 2026-09-08 antes de reportar REQ-GOB-014 como cerrado, para no ocultar
una regresión encontrada durante el trabajo aunque no la haya causado esta tarea.

## 1. `tests/unit/gob/cierre-tarea-conventional-commits.spec.ts` — 1 falla preexistente

El test `REQ-GOB-004 (cerrada por el commit real ead57d3) -> 0 violaciones contra el
git log real de este repo` espera que el commit `ead57d3` sea el ÚNICO commit del
historial que menciona `REQ-GOB-004` como palabra completa. Eso dejó de ser cierto
porque el commit `101a1416b79eff9de52f8607863075c11c8cbe35` (`feat(gob): cierra
REQ-GOB-005 — commit de cierre único en Conventional Commits`, ya en el historial de
`main` antes de que esta tarea empezara — no es un cambio mío) menciona
`REQ-GOB-004` en el cuerpo de su propio mensaje (línea: `REAL ya cerrada de este repo
(REQ-GOB-004, commit ead57d3) exit 0 y con un ...`), así que ahora hay 2 commits que
matchean, no 1.

No es una regresión de `packages/agent-core/src/backlog/backlogStateMachine.ts`
(REQ-GOB-014 no toca `checkCierreTareaConventionalCommits` ni sus fixtures) ni de
`docs/FOCUS.md`/`tests/unit/gob/focus-vigente.spec.ts` — confirmado ejecutando
`git log -1 --format="%B" 101a1416b79eff9de52f8607863075c11c8cbe35 | grep REQ-GOB-004`,
que muestra la mención en un commit ya existente en el historial antes de esta tarea.
Queda fuera de alcance de REQ-GOB-014 corregirlo (pertenece a REQ-GOB-004/REQ-GOB-005,
ya ambos `hecho`); lo señalo para quien retome esos requisitos o audite la suite.

Comando para reproducir: `npx vitest run tests/unit/gob/cierre-tarea-conventional-commits.spec.ts`.

## 2. `tests/unit/domain-hotel/parity-guard.spec.ts` — 2 errores de `tsc --noEmit`

Archivo no comiteado, aparecido en el working tree compartido por otra sesión
concurrente (no tocado por esta tarea). `npx tsc --noEmit -p tsconfig.json` reporta:

```
tests/unit/domain-hotel/parity-guard.spec.ts(169,12): error TS2532: Object is possibly 'undefined'.
tests/unit/domain-hotel/parity-guard.spec.ts(206,12): error TS2532: Object is possibly 'undefined'.
```

No relacionado con REQ-GOB-014 (ningún archivo de esta tarea lo importa ni lo toca).
Ver `docs/logs/REQ-GOB-014/typecheck-full-repo-20260908-172433.log` para el output
completo (0 errores en `backlogStateMachine.ts`/`focus-vigente.spec.ts`).
