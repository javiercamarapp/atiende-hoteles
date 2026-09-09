---
phase: cierre-p0
openModules: TEN, RES, HUE, REC, HK, AB, REV, CRM, BO, AGT, INT, SEG, OBS, UX, QA, GOB
---

# Foco vigente — Atiende Hoteles

Formato leído por `parseFocusFile` (`packages/agent-core/src/backlog/backlogStateMachine.ts`,
REQ-GOB-014): frontmatter con `phase` (fase vigente) y `openModules` (lista de códigos
de módulo separados por coma). `selectNextTask` (REQ-GOB-001) recibe `openModules` ya
resuelto desde aquí y excluye cualquier tarea `ready` cuyo `module` no esté en esta
lista, sin importar su `orden` — así "el flujo de planificación solo abre tareas del
foco vigente" (GOB-049) es un filtro real, no una convención de proceso.

## Fase vigente: `cierre-p0`

Documentada primero en `docs/cierre-p0/inventario.md` (2026-09-06) y vigente en
`docs/PROGRESO.md` hasta la fecha de este archivo (2026-09-08): cerrar los requisitos
`P0`/`P1` sin dependencia externa pendiente (`docs/REQUISITOS.md`), priorizando
seguridad/dinero, luego gobierno/proceso, luego producto/UX, luego observabilidad —
en vez de trabajar un solo módulo de producto a la vez como haría un hito `H1..H11`
(`docs/ARQUITECTURA.md`) posterior.

## Módulos abiertos

Los 16 módulos de `docs/REQUISITOS.md` (§3.1–3.16) están abiertos porque los 16 tienen
hoy al menos un `REQ-*` sin `Estado: hecho` (recuento verificado sobre el documento real
el 2026-09-08: `TEN 5/6, RES 18/22, HUE 27/27, REC 11/14, HK 22/22, AB 13/14, REV 16/19,
CRM 11/11, BO 35/37, AGT 17/22, INT 15/15, SEG 17/19, OBS 11/11, UX 6/6, QA 7/10,
GOB 15/21` pendientes/parciales de un total por módulo). Un foco de cierre general no
tiene un módulo "no tocado" que excluir todavía — la exclusión real por módulo aplica a
partir de la próxima fase (p.ej. un hito `H*` que declare trabajar solo un módulo), y es
entonces cuando este archivo debe reducir la lista de abajo, no seguir listando los 16.

## Cómo actualizar este archivo

1. Editar `phase` cuando cambie la fase vigente (p.ej. de `cierre-p0` a `H12` o al
   nombre de la siguiente línea de trabajo).
2. Editar `openModules` a la lista real de módulos que esa fase autoriza a abrir —
   quitar un módulo aquí es lo que hace que `selectNextTask` deje de tomar sus tareas,
   sin tocar código.
3. Actualizar la sección "Módulos abiertos" con la justificación verificable del cambio
   (igual que la de arriba: un recuento o una decisión citable, nunca "porque sí").
4. Preferir `renderFocusFile({ phase, openModules }, body)` (mismo módulo) para generar
   el frontmatter desde código y evitar un typo de módulo escribiéndolo a mano.
