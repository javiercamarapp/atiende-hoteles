---
ronda: 1
fecha: 2026-09-08
tareasCerradas: 8
veredicto: rojo
resuelto: false
---

# Auditoría periódica automatizada — ronda 1 (2026-09-08)

REQ-OBS-003 (GOB-009): disparada al cerrarse la tarea número 8 del backlog de archivos (`tasks/**`), intervalo de 8 tareas cerradas.

## Checklist ejecutado (16 ítem(s), catálogo real de `scripts/checks/`)

| Ítem | Resultado | Detalle |
|---|---|---|
| `cierre-tarea-conventional-commits` | **ROJO** |   tasks/FAKE-OBS-003-8.md [FAKE-OBS-003-8]: la tarea está en `done` pero 0 commits de `git log` referencian `FAKE-OBS-003-8` -- cierre sin commit real detrás. |
| `evidencia-obligatoria-cierre` | **ROJO** |   tasks/FAKE-OBS-003-8.md [FAKE-OBS-003-8]: la tarea está en `done` pero no existe `docs/logs/FAKE-OBS-003-8/` -- cierre bloqueado sin evidencia de verificación en verde. |
| `gate-por-tarea` | verde | REQ-AGT-019 OK: 8 tarea(s) revisada(s) bajo tasks/ -- gate declarado y válido en todas, y la(s) prueba(s) correspondiente(s) (contract test / determinismo de precio / laboratorio físico) presente(s) para toda tarea cuyos `paths` tocan agentes/precios/dinero/control físico. |
| `llm-juez-solo-sintetico` | verde | REQ-AGT-015 OK: 0 rutas donde una transcripción de huésped real (public.message/public.conversation, routes/mensajeria, adaptador de canal no-fake/simulado) llegue a un archivo/función identificado como LLM-juez, en ninguna dirección, sobre apps/**/src, packages/**/src y scripts/** (excluyendo scripts/checks). |
| `no-biometria-facial` | verde | REQ-HUE-022/REQ-SEG-003 OK: 0 referencias a reconocimiento facial en apps/ y packages/ (24 patrones de SDK/API/función/vendor de reconocimiento facial verificados, comentarios excluidos). |
| `no-comandos-destructivos-agente` | verde | REQ-GOB-009 OK: 0 invocaciones de comandos destructivos/productivos (supabase db push, git push --force) fuera de .github/workflows. |
| `no-delete-events` | verde | REQ-REC-004 OK: 0 DELETE/TRUNCATE contra charge, payment, audit_log, reservation_status_event en apps/api/src ni en migraciones. |
| `no-ota-directa` | verde | REQ-RES-022/REQ-REV-008 OK: 0 llamadas directas a API de Booking.com/Expedia/Airbnb en apps/api/src, apps/web/src ni packages/**. |
| `no-pan-storage` | **ROJO** |   apps/api/src/routes/mensajeria.ts:162: if (pago.containsCardNumber) { |
| `no-tests-skip` | verde |     tests/e2e/paridad-visual.spec.ts:288: motivo = motivoFallo |
| `ocr-aislado-sin-internet` | verde | docs/ARQUITECTURA.md, 'Resolución de las 10 contradicciones' #10). |
| `orden-conectores-pms` | verde | REQ-REV-008 OK: 0 conectividad OTA propia + orden de prioridad Cloudbeds→Mews→SiteMinder→OHIP reflejado en el registro. |
| `pms-mirror-solo-lectura` | verde |       compartida con REQ-BO-029/REQ-SEG-015). |
| `registro-unico-conectores` | verde | REQ-AGT-018 OK: 0 ocurrencias de `if provider === X`/`if pms === X` (ni `switch(provider\|pms)`) fuera del registro central de conectores, en apps/api/src, apps/web/src y packages/**. |
| `schema-location` | verde | REQ-TEN-002 OK: `hotel` existe una sola vez y es una extensión 1:1 de `location` (id → location(id)). |
| `scope-de-tarea` | verde | REQ-GOB-004 OK: ninguna tarea en `doing`/`review` con diff fuera de su scope declarado (8 archivo(s) de tarea revisado(s) bajo tasks/). |

## Veredicto: 🔴 ROJO

3/16 ítem(s) del checklist fallaron. REQ-OBS-003/GOB-009 exige detener el loop de construcción hasta resolución -- no se toma ninguna tarea nueva del backlog mientras esta ronda siga sin marcarse resuelta (`node scripts/checks/auditoria-periodica.ts --resolver 1` una vez corregida la causa).
