NOTA: 1 archivo/1 prueba falla en 'npm run test:unit' de forma PRE-EXISTENTE, no causada por
REQ-OBS-003 -- confirmado antes de tocar ningún archivo de esta tarea (primera corrida de
baseline de la sesión, misma falla ya presente):

FAIL tests/unit/gob/cierre-tarea-conventional-commits.spec.ts >
  checkCierreTareaConventionalCommits: tarea de muestra REAL ya cerrada de este repo
  (REQ-GOB-004) -> 0 violaciones contra el git log real de este repo
  AssertionError: expected [ { ...(3) } ] to have a length of +0 but got 1

No relacionado con packages/agent-core/src/backlog/backlogStateMachine.ts ni con
scripts/checks/auditoria-periodica.ts -- pertenece a REQ-GOB-004/REQ-GOB-005 (verificación de
commit real de git log), fuera del alcance de REQ-OBS-003. No se modificó para no exceder el
alcance encargado.
